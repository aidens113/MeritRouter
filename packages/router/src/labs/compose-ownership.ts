import path from "node:path";
import { z } from "zod";
import { composeCanonicalHash } from "./compose-recipe.js";
import { ComposeContainerInspectSchema, ComposeNetworkInspectSchema, ComposeResourceProofInputSchema, ComposeResourceProofResultSchema } from "./compose-ownership-schema.js";
type Code=z.infer<typeof ComposeResourceProofResultSchema>["code"];
class Refused extends Error { constructor(readonly code:Code){super(code);} }
function refuse(code:Code):never{throw new Refused(code);}
const equal=(a:unknown,b:unknown)=>composeCanonicalHash(a)===composeCanonicalHash(b);
const sorted=<T>(values:T[])=>[...values].sort((a,b)=>composeCanonicalHash(a).localeCompare(composeCanonicalHash(b)));
const LABEL="io.switchyard.";
function labels(identity:z.infer<typeof ComposeResourceProofInputSchema>["current"],projectName:string,kind:string){
 return {[LABEL+"install"]:identity.installId,[LABEL+"lab"]:identity.labId,[LABEL+"run"]:identity.runId,[LABEL+"generation"]:String(identity.generation),[LABEL+"spec"]:identity.specSha256,[LABEL+"nonce"]:identity.nonceSha256,[LABEL+"request"]:identity.requestSha256,[LABEL+"intent"]:identity.intentId,[LABEL+"resource"]:kind,"com.docker.compose.project":projectName};
}
function exactLabels(actual:Record<string,string>,expected:Record<string,string>){
 for(const [key,value]of Object.entries(expected))if(actual[key]!==value)refuse("identity_mismatch");
 for(const key of Object.keys(actual))if(key.startsWith(LABEL)&&!(key in expected))refuse("identity_mismatch");
}
function environment(values:string[]|null){
 const result:Record<string,string>=Object.create(null);
 for(const value of values??[]){const split=value.indexOf("=");if(split<1)refuse("config_mismatch");const key=value.slice(0,split);if(Object.hasOwn(result,key))refuse("config_mismatch");result[key]=value.slice(split+1);}
 return result;
}
function boundedInput(raw:unknown){
 // Inputs cross a JSON boundary: validate size/depth/nodes before zod/canonical hashing.
 let size=0,nodes=0;const active=new Set<object>();
 const visit=(value:unknown,depth:number):void=>{
  if(++nodes>100_000||depth>32)refuse("invalid_input");
  if(typeof value==="string"){if(value.length>5*1024*1024)refuse("invalid_input");size+=Buffer.byteLength(value);if(size>5*1024*1024)refuse("invalid_input");return;}
  if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value))return;
  if(typeof value!=="object"||!value||active.has(value))refuse("invalid_input");
  if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)refuse("invalid_input");
  active.add(value);const keys=Object.keys(value);if(keys.length>10_000)refuse("invalid_input");
  for(const key of keys){size+=Buffer.byteLength(key);if(size>5*1024*1024)refuse("invalid_input");const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!("value"in descriptor))refuse("invalid_input");visit(descriptor.value,depth+1);}active.delete(value);
 };
 visit(raw,0);return ComposeResourceProofInputSchema.parse(raw);
}
/** Pure snapshot decision. Caller must supply trusted committed journal/engine observations; no mutation authority is returned. */
export function verifyComposeResourceProof(raw:unknown):z.infer<typeof ComposeResourceProofResultSchema>{
 try{
  const input=boundedInput(raw),{journal,current,approval}=input,{authority,canonical,images}=approval;
  if(!equal(journal.identity,current)||!equal(journal.engine,input.observedEngine))refuse("identity_mismatch");
  const services=Object.keys(canonical.services).sort();
  if(journal.state!=="committed"||!journal.networkId||!services.length||!equal(Object.keys(journal.containers).sort(),services))refuse("resource_ids_uncommitted");
  const ids=Object.values(journal.containers);if(new Set(ids).size!==ids.length)refuse("identity_mismatch");
  if(current.specSha256!==composeCanonicalHash(approval)||canonical.name!==authority.projectName||!equal(Object.keys(authority.services).sort(),services)||!equal(Object.keys(images).sort(),services))refuse("approval_mismatch");
  const networkName=canonical.networks.default.name??`${canonical.name}_default`;
  if(networkName!==`${canonical.name}_default`)refuse("approval_mismatch");
  const inside=(root:string,value:string)=>{const rel=path.relative(path.resolve(root),path.resolve(value));return rel!==".."&&!rel.startsWith(".."+path.sep)&&!path.isAbsolute(rel);};
  if(path.resolve(authority.worktree)===path.resolve(authority.labRoot)||!inside(authority.labRoot,authority.worktree)||authority.dataRoots.some(root=>path.resolve(root)===path.resolve(authority.labRoot)||!inside(authority.labRoot,root)))refuse("approval_mismatch");
  const published=new Set<number>();
  for(const name of services){
   const spec=canonical.services[name]!,authorized=authority.services[name]!;
   if(spec.image!==authorized.image||!equal(spec.environment,authorized.environment)||!equal(spec.ports.map(p=>({target:p.target,published:p.published})),authorized.ports)||!equal(spec.volumes.map(m=>({source:m.source,target:m.target,readOnly:m.read_only})),authorized.mounts))refuse("approval_mismatch");
   for(const port of spec.ports){if(published.has(port.published))refuse("approval_mismatch");published.add(port.published);}
   const targets=new Set<string>();
   for(const mount of spec.volumes){
    if(targets.has(mount.target)||[mount.source,mount.target].some(value=>/docker\.sock|(?:^|[\\/])\.git(?:[\\/]|$)|(?:^|[\\/])\.switchyard(?:[\\/]|$)/i.test(value))||path.resolve(mount.source)===path.resolve(authority.worktree)||path.resolve(mount.source)===path.resolve(authority.labRoot))refuse("approval_mismatch");
    targets.add(mount.target);
    if(![authority.worktree,...authority.dataRoots].some(root=>{const rel=path.relative(path.resolve(root),path.resolve(mount.source));return rel!==".."&&!rel.startsWith(".."+path.sep)&&!path.isAbsolute(rel);}))refuse("approval_mismatch");
   }
  }
  if(Buffer.byteLength(input.containersJson)>2*1024*1024||Buffer.byteLength(input.networkJson)>1024*1024)refuse("invalid_input");
  const containers=z.array(ComposeContainerInspectSchema).max(100).parse(JSON.parse(input.containersJson));
  const network=z.array(ComposeNetworkInspectSchema).length(1).parse(JSON.parse(input.networkJson))[0]!;
  if(network.Id!==journal.networkId||network.Name!==networkName)refuse("identity_mismatch");
  exactLabels(network.Labels,{...labels(current,canonical.name,"network"),"com.docker.compose.network":"default"});
  if(containers.length!==services.length||new Set(containers.map(c=>c.Id)).size!==containers.length||containers.some(c=>!ids.includes(c.Id)))refuse("identity_mismatch");
  const attached=new Set<string>();
  for(const name of services){
   const container=containers.find(c=>c.Id===journal.containers[name])??refuse("identity_mismatch");
   const spec=canonical.services[name]!,image=images[name]!;
   if(!image.RepoDigests.includes(spec.image)||container.Image!==image.Id||container.Config.Image!==spec.image)refuse("image_mismatch");
   exactLabels(container.Config.Labels,{...labels(current,canonical.name,"container"),"com.docker.compose.service":name});
   for(const [key,value]of Object.entries(image.Config.Labels??{}))if(!key.startsWith(LABEL)&&!key.startsWith("com.docker.compose.")&&container.Config.Labels[key]!==value)refuse("config_mismatch");
   const env={...environment(image.Config.Env),...spec.environment};
   if(!equal(environment(container.Config.Env),env))refuse("config_mismatch");
   const entry=spec.entrypoint??image.Config.Entrypoint??[],cmd=spec.command??(spec.entrypoint!==undefined?[]:image.Config.Cmd??[]),argv=[...entry,...cmd];
   if(!argv.length||!equal(container.Config.Entrypoint??[],entry)||!equal(container.Config.Cmd??[],cmd)||container.Path!==argv[0]||!equal(container.Args,argv.slice(1))||container.Config.User!==(spec.user??image.Config.User)||container.Config.WorkingDir!==(spec.working_dir??image.Config.WorkingDir)||(container.Config.StopSignal??"")!==(image.Config.StopSignal??""))refuse("config_mismatch");
   const baseline=Object.fromEntries(Object.keys(approval.engineBaseline).map(key=>[key,container.HostConfig[key as keyof typeof container.HostConfig]]));
   if(!equal(baseline,approval.engineBaseline)||container.AppArmorProfile!==approval.appArmorProfile)refuse("config_mismatch");
   if(![networkName,journal.networkId].includes(container.HostConfig.NetworkMode))refuse("network_mismatch");
   const expectedMounts=spec.volumes.map(m=>({source:m.source,target:m.target,readOnly:m.read_only}));
   const configured=container.HostConfig.Mounts.map(m=>({source:m.Source,target:m.Target,readOnly:m.ReadOnly}));
   const actual=container.Mounts.map(m=>({source:m.Source,target:m.Destination,readOnly:!m.RW}));
   if(!equal(sorted(expectedMounts),sorted(configured))||!equal(sorted(expectedMounts),sorted(actual))||container.Mounts.some(m=>!["",m.RW?"rw":"ro"].includes(m.Mode)))refuse("mount_mismatch");
   const wanted:Record<string,Array<{HostIp:string;HostPort:string}>>={};
   for(const port of spec.ports){const key=`${port.target}/tcp`;if(wanted[key])refuse("approval_mismatch");wanted[key]=[{HostIp:"127.0.0.1",HostPort:String(port.published)}];}
   if(!equal(container.HostConfig.PortBindings,wanted))refuse("port_mismatch");
   const exposed={...(image.Config.ExposedPorts??{}),...Object.fromEntries(spec.ports.map(p=>[`${p.target}/tcp`,{}]))};
   if(!equal(container.Config.ExposedPorts??{},exposed))refuse("port_mismatch");
   if(!equal(Object.keys(container.NetworkSettings.Ports).sort(),Object.keys(exposed).sort()))refuse("port_mismatch");
   for(const [port,bindings]of Object.entries(container.NetworkSettings.Ports))if(bindings!==null? !equal(bindings,wanted[port]):container.State.Running&&wanted[port]!==undefined)refuse("port_mismatch");
   if(container.State.Running!==(container.State.Status==="running"))refuse("config_mismatch");
   const names=Object.keys(container.NetworkSettings.Networks);if(names[0]!==networkName)refuse("network_mismatch");
   const endpoint=container.NetworkSettings.Networks[networkName]!;
   if(endpoint.NetworkID!==network.Id)refuse("network_mismatch");
   const peer=network.Containers[container.Id];
   if(endpoint.EndpointID){if(!peer||peer.EndpointID!==endpoint.EndpointID||peer.Name!==container.Name.replace(/^\//,""))refuse("network_mismatch");attached.add(container.Id);}
   else if(container.State.Running||peer)refuse("network_mismatch");
  }
  if(!equal(Object.keys(network.Containers).sort(),[...attached].sort()))refuse("network_mismatch");
  return ComposeResourceProofResultSchema.parse({state:"verified",code:"exact_resources_match",containerCount:containers.length,runtimeEnabled:false});
 }catch(error){return ComposeResourceProofResultSchema.parse({state:"quarantine",code:error instanceof Refused?error.code:"invalid_input",containerCount:0,runtimeEnabled:false});}
}
