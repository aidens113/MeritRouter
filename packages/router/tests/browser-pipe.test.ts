import { afterEach, describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { BrowserPipeProtocol } from "../src/labs/browser-pipe.js";
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const owned:BrowserPipeProtocol[]=[];
afterEach(async()=>{for(const pipe of owned)pipe.close();owned.length=0;await turn();});
function fixture(limits:ConstructorParameters<typeof BrowserPipeProtocol>[3]={},output?:Writable){
 const input=new PassThrough(),sent:Buffer[]=[];const abort=new AbortController();
 const writer=output??new Writable({write(chunk,_encoding,callback){sent.push(Buffer.from(chunk));callback();}});
 const pipe=new BrowserPipeProtocol(input,writer,abort.signal,limits);owned.push(pipe);
 const send=(value:unknown)=>input.write(Buffer.from(JSON.stringify(value)+'\0'));
 return {pipe,input,output:writer,sent,abort,send};
}
function observe(promise:Promise<unknown>){return promise.then(value=>({value,error:null}),error=>({value:null,error:error as Error}));}
describe('bounded framework browser pipe',()=>{
 it('handles coalesced frames and byte-split UTF-8 with scoped events and replies',async()=>{
  const f=fixture(),events:unknown[]=[];f.pipe.onEvent(e=>events.push(e));const pending=f.pipe.call('Browser.getVersion');
  const bytes=Buffer.from(JSON.stringify({method:'Runtime.ready',params:{text:'héllo ??'},sessionId:'session'})+'\0'+JSON.stringify({id:1,result:{product:'Chrome'}})+'\0');
  for(const byte of bytes)f.input.write(Buffer.from([byte]));
  expect(await pending).toEqual({product:'Chrome'});await f.pipe.drain();expect(events).toEqual([{method:'Runtime.ready',params:{text:'héllo ??'},sessionId:'session'}]);
  expect(JSON.parse(Buffer.concat(f.sent).toString().slice(0,-1))).toMatchObject({id:1,method:'Browser.getVersion',params:{}});
 });
 it('correlates target replies to their exact flat session',async()=>{
  const f=fixture(),p=f.pipe.call('DOM.getDocument',{},'target-a');f.send({id:1,result:{root:{}},sessionId:'target-a'});await p;await f.pipe.drain();
  const q=observe(f.pipe.call('DOM.getDocument',{},'target-a'));f.send({id:2,result:{root:{}},sessionId:'target-b'});expect((await q).error?.message).toContain('frame');
 });
 it('ignores unknown and late replies without settling a different call',async()=>{
  const f=fixture(),p=f.pipe.call('Browser.getVersion');f.send({id:999,result:{wrong:true}});f.send({id:1,result:{right:true}});expect(await p).toEqual({right:true});
  f.send({id:1,result:{late:true}});const q=f.pipe.call('DOM.getDocument');f.send({id:2,error:{code:-1,message:'private raw failure',data:{secret:true}}});expect((await observe(q)).error?.message).toBe('browser protocol refused -1');
 });
 it.each([Buffer.from('not-json\0'),Buffer.from('{"id":1}\0'),Buffer.from('{"id":1,"result":{},"error":{"code":1,"message":"x"}}\0'),Buffer.from('{"method":"Runtime.ready","extra":1}\0'),Buffer.from([0xc3,0x28,0]),Buffer.from([0])])('fails malformed frame/envelope safely %#',async bytes=>{
  const f=fixture(),p=observe(f.pipe.call('Browser.getVersion'));f.input.write(bytes);expect((await p).error?.message).toContain('frame');expect(f.input.destroyed).toBe(true);expect(f.output.destroyed).toBe(true);
 });
 it('enforces exact frame boundary and aggregate bytes, including NUL separators',async()=>{
  const frame=JSON.stringify({method:'Runtime.ready',params:{text:'x'}}),size=Buffer.byteLength(frame);
  const f=fixture({maxFrameBytes:size,maxTotalBytes:2*(size+1),maxEvents:3});f.input.write(Buffer.from(frame+'\0'+frame+'\0'));await f.pipe.drain();
  f.input.write(Buffer.from(frame+'\0'));await expect(f.pipe.drain()).rejects.toThrow('frame');
  const g=fixture({maxFrameBytes:3});g.input.write(Buffer.from('1234'));await expect(g.pipe.drain()).rejects.toThrow('frame');
 });
 it('caps events and cleans listeners after failure',async()=>{
  const f=fixture({maxEvents:2}),p=observe(f.pipe.call('Browser.getVersion'));let seen=0;f.pipe.onEvent(()=>{seen++;});for(let i=0;i<3;i++)f.send({method:'Runtime.ready'});
  expect((await p).error).toBeTruthy();expect(seen).toBe(2);await turn();expect(f.input.listenerCount('data')).toBe(0);expect(f.input.listenerCount('error')).toBe(0);expect(f.output.listenerCount('error')).toBe(0);
 });
 it('caps pending calls and listener subscriptions without losing accepted calls',async()=>{
  const f=fixture({maxPending:1,maxListeners:1}),p=f.pipe.call('Browser.getVersion');await expect(f.pipe.call('DOM.getDocument')).rejects.toThrow('pending');const off=f.pipe.onEvent(()=>{});expect(()=>f.pipe.onEvent(()=>{})).toThrow('listener');off();f.pipe.onEvent(()=>{});f.send({id:1,result:{}});await p;await f.pipe.drain();
 });
 it('bounds drain waiters and waits for writable callback after a reply',async()=>{
  let complete:((error?:Error|null)=>void)|undefined;
  const output=new Writable({highWaterMark:1,write(_chunk,_encoding,callback){complete=callback;}});
  const f=fixture({maxPending:1},output),p=f.pipe.call('Browser.getVersion');await turn();let drained=false;const d=f.pipe.drain().then(()=>{drained=true;});await expect(f.pipe.drain()).rejects.toThrow('waiter');f.send({id:1,result:{}});await p;await turn();expect(drained).toBe(false);complete!();await d;expect(output.writableLength).toBe(0);
 });
 it.each(['abort','eof','partial','close'])('rejects all pending calls and drain on %s',async action=>{
  const f=fixture(),p=observe(f.pipe.call('Browser.getVersion')),d=observe(f.pipe.drain());if(action==='abort')f.abort.abort();else if(action==='eof')f.input.end();else if(action==='partial')f.input.end(Buffer.from('{"id":'));else f.pipe.close();expect((await p).error).toBeTruthy();expect((await d).error).toBeTruthy();await turn();expect(f.input.listenerCount('data')).toBe(0);f.pipe.close();
 });
 it('handles output errors/aborted construction and rejects framework-invalid command input',async()=>{
  const f=fixture({},new Writable({write(_c,_e,callback){callback(new Error('private write error'));}}));expect((await observe(f.pipe.call('Browser.getVersion'))).error?.message).toMatch(/^browser pipe (I\/O|write) failed$/);await turn();
  const g=fixture();g.abort.abort();await expect(g.pipe.call('Browser.getVersion')).rejects.toThrow('aborted');
  const h=fixture();await expect(h.pipe.call('Runtime.evaluate' as never)).rejects.toThrow();expect(h.input.destroyed).toBe(false);
 });
 it('rejects a stalled peer by the bounded transport deadline and supports already-aborted construction',async()=>{
  const f=fixture({timeoutMs:5}),p=observe(f.pipe.call('Browser.getVersion')),d=observe(f.pipe.drain());expect((await p).error?.message).toContain('deadline');expect((await d).error?.message).toContain('deadline');
  const abort=new AbortController();abort.abort();const input=new PassThrough(),output=new Writable({write(_c,_e,cb){cb();}});const pipe=new BrowserPipeProtocol(input,output,abort.signal);owned.push(pipe);await expect(pipe.call('Browser.getVersion')).rejects.toThrow('aborted');
 });
 it('rejects oversized, cyclic and accessor commands without executing getters',async()=>{
  const f=fixture({maxFrameBytes:100}),p=observe(f.pipe.call('Browser.getVersion'));await expect(f.pipe.call('DOM.querySelector',{selector:'x'.repeat(101)})).rejects.toThrow('command');expect((await p).error).toBeTruthy();
  let invoked=false;const value=Object.defineProperty({},'secret',{enumerable:true,get(){invoked=true;return 'private';}});const g=fixture();await expect(g.pipe.call('DOM.querySelector',value)).rejects.toThrow('command');expect(invoked).toBe(false);
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic;const h=fixture();await expect(h.pipe.call('DOM.querySelector',cyclic)).rejects.toThrow('command');
 });
 it('closes queued and in-flight writes on abort without dangling calls',async()=>{
  const output=new Writable({write(_c,_e,_cb){}}),f=fixture({},output);
  const a=observe(f.pipe.call('Browser.getVersion')),b=observe(f.pipe.call('DOM.getDocument')),d=observe(f.pipe.drain());
  await turn();f.abort.abort();expect((await a).error).toBeTruthy();expect((await b).error).toBeTruthy();expect((await d).error).toBeTruthy();await turn();expect(output.listenerCount('error')).toBe(0);
 });
 it('refuses streams already closed before transport construction',async()=>{
  const input=new PassThrough(),output=new Writable({write(_c,_e,cb){cb();}});input.destroy();await turn();const pipe=new BrowserPipeProtocol(input,output,new AbortController().signal);owned.push(pipe);await expect(pipe.call('Browser.getVersion')).rejects.toThrow('closed');
 });
 it('refuses configured limits above hard caps',()=>{expect(()=>fixture({maxFrameBytes:12*1024*1024+1})).toThrow();expect(()=>fixture({maxTotalBytes:32*1024*1024+1})).toThrow();});
 it('fails thrown or async event handlers without unhandled rejections',async()=>{
  const f=fixture(),p=observe(f.pipe.call('Browser.getVersion'));f.pipe.onEvent(()=>{throw new Error('private handler error');});f.send({method:'Runtime.ready'});expect((await p).error?.message).not.toContain('private');
  const g=fixture(),q=observe(g.pipe.call('Browser.getVersion'));g.pipe.onEvent(async()=>{throw new Error('async private');});g.send({method:'Runtime.ready'});expect((await q).error).toBeTruthy();await turn();
 });
});
