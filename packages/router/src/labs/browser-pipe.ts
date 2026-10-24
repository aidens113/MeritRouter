import { TextDecoder } from "node:util";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

const Method = z.string().regex(/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]+$/).max(160);
const Session = z.string().min(1).max(200);
const Envelope = z.object({
  id: z.number().int().positive().optional(), sessionId: Session.optional(),
  result: z.record(z.string(),z.unknown()).optional(), error: z.object({code:z.number().int(),message:z.string().max(2000),data:z.unknown().optional()}).strict().optional(),
  method: Method.optional(), params: z.record(z.string(),z.unknown()).optional(),
}).strict().superRefine((value,ctx)=>{
  const has = (key:string)=>Object.hasOwn(value,key);
  if (value.id !== undefined ? value.method !== undefined || has("params") || has("result") === has("error") : value.method === undefined || has("result") || has("error"))
    ctx.addIssue({code:"custom",message:"invalid CDP envelope"});
});
export const BROWSER_PIPE_LIMITS = Object.freeze({maxFrameBytes:12*1024*1024,maxTotalBytes:32*1024*1024,maxPending:32,maxEvents:10_000,maxListeners:16,timeoutMs:60_000});
const Limits = z.object({
  maxFrameBytes:z.number().int().min(1).max(BROWSER_PIPE_LIMITS.maxFrameBytes),
  maxTotalBytes:z.number().int().min(1).max(BROWSER_PIPE_LIMITS.maxTotalBytes),
  maxPending:z.number().int().min(1).max(BROWSER_PIPE_LIMITS.maxPending),
  maxEvents:z.number().int().min(1).max(BROWSER_PIPE_LIMITS.maxEvents),
  maxListeners:z.number().int().min(1).max(BROWSER_PIPE_LIMITS.maxListeners),
  timeoutMs:z.number().int().min(1).max(BROWSER_PIPE_LIMITS.timeoutMs),
}).strict();
/** Internal framework commands only. No evaluate/script injection or model-facing command surface. */
export const BrowserPipeMethodSchema = z.enum([
  "Browser.getVersion","Browser.close","Target.getTargets","Target.createTarget","Target.closeTarget","Target.setAutoAttach",
  "Page.enable","Page.setLifecycleEventsEnabled","Page.navigate","Page.captureScreenshot",
  "Runtime.enable","Runtime.runIfWaitingForDebugger","Log.enable","Network.enable","Network.setCacheDisabled","Network.setBypassServiceWorker",
  "Network.emulateNetworkConditions","Emulation.setScriptExecutionDisabled","Emulation.setDeviceMetricsOverride",
  "Fetch.enable","Fetch.failRequest","Fetch.fulfillRequest","DOM.getDocument","DOM.querySelector","DOM.describeNode",
  "DOM.getBoxModel","DOM.focus","DOM.scrollIntoViewIfNeeded","Input.dispatchMouseEvent","Input.dispatchKeyEvent","Input.insertText","Page.reload",
  "DOM.setFileInputFiles",
]);
export type BrowserPipeMethod = z.infer<typeof BrowserPipeMethodSchema>;

/** Serialize JSON without recursive toJSON hooks or unbounded nested/intermediate concatenation. */
function commandJson(value:unknown,maximum:number):string {
  const parts:string[]=[];let bytes=0,nodes=0;
  const active=new Set<object>();
  const add=(text:string)=>{bytes+=Buffer.byteLength(text);if(bytes>maximum)throw new Error("command byte limit");parts.push(text);};
  const quoted=(text:string)=>{if(text.length>maximum)throw new Error("command string limit");add(JSON.stringify(text));};
  const visit=(item:unknown,depth:number):void=>{
    if(++nodes>10_000||depth>32)throw new Error("command structure limit");
    if(item===null){add("null");return;}
    if(typeof item==="string"){quoted(item);return;}
    if(typeof item==="boolean"){add(String(item));return;}
    if(typeof item==="number"&&Number.isFinite(item)){add(String(item));return;}
    if(typeof item!=="object"||!item||active.has(item))throw new Error("command must be JSON");
    if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw new Error("command must be plain JSON");
    active.add(item);
    if(Array.isArray(item)&&item.length>10_000)throw new Error("command structure limit");
    const keys=Array.isArray(item)?Array.from({length:item.length},(_,i)=>String(i)):Object.keys(item);
    if(keys.length>10_000)throw new Error("command structure limit");
    add(Array.isArray(item)?"[":"{");
    for(const [index,key] of keys.entries()){
      const property=Object.getOwnPropertyDescriptor(item,key);
      if(!property||!("value" in property))throw new Error("command accessors are refused");
      if(index)add(",");if(!Array.isArray(item)){quoted(key);add(":");}visit(property.value,depth+1);
    }
    add(Array.isArray(item)?"]":"}");active.delete(item);
  };
  visit(value,0);return parts.join("");
}

export interface BrowserPipeEvent { method:string; params?:unknown; sessionId?:string }
interface Pending { sessionId?:string; resolve(value:unknown):void; reject(error:Error):void }

/** Owns only the supplied pipe streams, never a PID/process. Not evidence of browser isolation. */
export class BrowserPipeProtocol {
  private readonly limits;
  private readonly deadline:ReturnType<typeof setTimeout>;
  private next=0;
  private bytes=0;
  private eventCount=0;
  private frameBytes=0;
  private frame=Buffer.alloc(0);
  private failure:Error|null=null;
  private readonly pending=new Map<number,Pending>();
  private readonly listeners=new Set<(event:BrowserPipeEvent)=>void>();
  private readonly drains=new Set<{resolve():void;reject(error:Error):void}>();
  private writes=0;
  private queue:Promise<void>=Promise.resolve();
  private cancelWrite:(()=>void)|null=null;
  private readonly onData=(chunk:unknown)=>{try{this.receive(chunk);}catch{this.fail(new Error("invalid or over-limit browser pipe frame"));}};
  private readonly onEnd=()=>this.fail(new Error(this.frameBytes ? "unfinished browser pipe frame" : "browser pipe ended"));
  private readonly onClose=()=>this.fail(new Error("browser pipe closed"));
  private readonly onError=()=>this.fail(new Error("browser pipe I/O failed"));
  private readonly onAbort=()=>this.fail(new Error("browser pipe aborted"));
  constructor(private readonly input:Readable,private readonly output:Writable,private readonly signal:AbortSignal,limits:Partial<z.infer<typeof Limits>>={}) {
    this.limits=Limits.parse({...BROWSER_PIPE_LIMITS,...limits});
    this.deadline=setTimeout(()=>this.fail(new Error("browser pipe deadline exceeded")),this.limits.timeoutMs);
    this.deadline.unref();
    input.on("data",this.onData);input.on("end",this.onEnd);input.on("close",this.onClose);input.on("error",this.onError);
    output.on("close",this.onClose);output.on("error",this.onError);
    signal.addEventListener("abort",this.onAbort,{once:true});
    if(signal.aborted)this.onAbort();
    else if(input.destroyed||input.readableEnded||output.destroyed||output.writableEnded)this.onClose();
  }
  private account(length:number):void {
    this.bytes+=length;
    if(this.bytes>this.limits.maxTotalBytes)throw new Error("browser pipe total byte limit exceeded");
  }
  private receive(chunk:unknown):void {
    if(this.failure)return;
    if(!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))throw new Error("browser pipe requires bytes");
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    this.account(bytes.length);
    let offset=0;
    while(offset<bytes.length && !this.failure){
      const end=bytes.indexOf(0,offset), stop=end<0?bytes.length:end;
      const length=stop-offset;
      const needed=this.frameBytes+length;
      if(needed>this.limits.maxFrameBytes)throw new Error("browser pipe frame limit exceeded");
      if(needed>this.frame.length){
        const grown=Buffer.alloc(Math.min(this.limits.maxFrameBytes,Math.max(needed,this.frame.length*2,1024)));
        this.frame.copy(grown,0,0,this.frameBytes);this.frame=grown;
      }
      bytes.copy(this.frame,this.frameBytes,offset,stop);this.frameBytes=needed;
      if(end<0)break;
      if(!this.frameBytes)throw new Error("empty browser pipe frame");
      const frame=this.frame.subarray(0,this.frameBytes);
      this.frameBytes=0;
      this.dispatch(Envelope.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(frame))));
      offset=end+1;
    }
  }
  private dispatch(message:z.infer<typeof Envelope>):void {
    if(message.id!==undefined){
      const call=this.pending.get(message.id);
      if(!call)return; // Late/unknown replies consume byte budget, but cannot settle another call.
      if(message.sessionId!==call.sessionId)throw new Error("browser pipe reply session mismatch");
      this.pending.delete(message.id);
      if(message.error)call.reject(new Error(`browser protocol refused ${message.error.code}`));else call.resolve(message.result);
      this.notifyDrain();return;
    }
    if(++this.eventCount>this.limits.maxEvents)throw new Error("browser pipe event limit exceeded");
    for(const listener of this.listeners){
      const result:unknown=listener({method:message.method!,params:message.params,sessionId:message.sessionId});
      if(result && typeof (result as {then?:unknown}).then==="function"){
        // Event delivery is synchronous; never leave an accidental async rejection unobserved.
        void Promise.resolve(result).catch(()=>{});
        throw new Error("browser pipe listeners must be synchronous");
      }
    }
  }
  onEvent(listener:(event:BrowserPipeEvent)=>void):()=>void {
    if(this.failure)throw this.failure;
    if(this.listeners.size>=this.limits.maxListeners)throw new Error("browser pipe listener limit exceeded");
    this.listeners.add(listener);return()=>{this.listeners.delete(listener);};
  }
  async call(method:BrowserPipeMethod,params:Record<string,unknown>={},sessionId?:string):Promise<unknown>{
    if(this.failure)throw this.failure;
    BrowserPipeMethodSchema.parse(method);
    if(!params||typeof params!=="object"||Array.isArray(params))throw new Error("browser pipe params must be an object");
    if(sessionId!==undefined)Session.parse(sessionId);
    if(this.pending.size>=this.limits.maxPending||this.writes>=this.limits.maxPending)throw new Error("browser pipe pending limit exceeded");
    const id=++this.next;
    let frame:Buffer;
    try{
      const json=commandJson({id,method,params,...(sessionId===undefined?{}:{sessionId})},this.limits.maxFrameBytes);
      frame=Buffer.from(json+"\0");
      if(frame.length-1>this.limits.maxFrameBytes)throw new Error("frame limit");
      this.account(frame.length);
    }catch{this.fail(new Error("invalid or over-limit browser pipe command"));throw this.failure!;}
    const promise=new Promise<unknown>((resolve,reject)=>this.pending.set(id,{resolve,reject,sessionId}));
    this.writes++;
    this.queue=this.queue.then(async()=>{if(this.failure)throw this.failure;await this.write(frame);}).catch(()=>this.fail(new Error("browser pipe write failed"))).finally(()=>{this.writes--;this.notifyDrain();});
    return promise;
  }
  private write(frame:Buffer):Promise<void>{
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error?:Error|null)=>{if(settled)return;settled=true;this.cancelWrite=null;error?reject(error):resolve();};
      this.cancelWrite=()=>finish(new Error("browser pipe closed during write"));
      try{this.output.write(frame,error=>finish(error));}catch{finish(new Error("browser pipe write failed"));}
    });
  }
  /** Wait for outstanding writes and responses; caller's required abort signal bounds stalled peers. */
  drain():Promise<void>{
    if(this.failure)return Promise.reject(this.failure);
    if(!this.pending.size&&!this.writes)return Promise.resolve();
    if(this.drains.size>=this.limits.maxPending)return Promise.reject(new Error("browser pipe drain waiter limit exceeded"));
    return new Promise((resolve,reject)=>this.drains.add({resolve,reject}));
  }
  private notifyDrain():void{if(!this.pending.size&&!this.writes){for(const waiter of this.drains)waiter.resolve();this.drains.clear();}}
  private fail(error:Error):void{
    if(this.failure)return;
    this.failure=error;clearTimeout(this.deadline);this.frame=Buffer.alloc(0);this.frameBytes=0;
    this.signal.removeEventListener("abort",this.onAbort);
    this.input.off("data",this.onData);this.input.off("end",this.onEnd);this.input.off("close",this.onClose);this.output.off("close",this.onClose);
    for(const call of this.pending.values())call.reject(error);this.pending.clear();
    for(const waiter of this.drains)waiter.reject(error);this.drains.clear();this.listeners.clear();
    this.cancelWrite?.();
    // Keep error handlers until stream close: failing write callbacks may emit error afterwards.
    const clearInput=()=>this.input.off("error",this.onError),clearOutput=()=>this.output.off("error",this.onError);
    if(this.input.closed)clearInput();else this.input.once("close",clearInput);
    if(this.output.closed)clearOutput();else this.output.once("close",clearOutput);
    this.input.destroy();this.output.destroy();
  }
  close():void{this.fail(new Error("browser pipe closed"));}
}
