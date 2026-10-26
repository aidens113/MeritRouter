import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Infer only this workspace's source checkout, never an npm consumer's ancestor directory. */
export function sourceCheckoutForModule(moduleUrl:string|URL):string|null {
  try {
    const moduleFile=fileURLToPath(moduleUrl),area=path.dirname(moduleFile),output=path.dirname(area);
    if(!["src","dist"].includes(path.basename(output)))return null;
    const packageDirectory=path.dirname(output),packages=path.dirname(packageDirectory),root=path.dirname(packages);
    if(path.basename(packageDirectory)!=="router"||path.basename(packages)!=="packages")return null;
    const manifest=readFileSync(path.join(root,"package.json"),"utf8");
    if(Buffer.byteLength(manifest)>65536)return null;
    const result=z.object({name:z.literal("meritrouter-workspace")}).passthrough().safeParse(JSON.parse(manifest));
    return result.success?root:null;
  }catch{return null;}
}
