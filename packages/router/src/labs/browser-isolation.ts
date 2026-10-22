import { z } from "zod";
export const BrowserIsolationBackendSchema=z.enum(["linux_netns_v1","windows_appcontainer_v1"]);
export type BrowserIsolationBackend=z.infer<typeof BrowserIsolationBackendSchema>;
/** H1 has no accepted backend. No serialized available/proven/boolean state is accepted. */
export const BrowserIsolationCapabilitySchema=z.object({
 status:z.literal("unavailable"),backend:BrowserIsolationBackendSchema,
 code:z.enum(["unsupported_platform","adapter_not_installed"]),
 message:z.literal("Hydrated browser isolation is unavailable on this host; static checks remain supported."),
}).strict();
export type BrowserIsolationCapability=z.infer<typeof BrowserIsolationCapabilitySchema>;
const leaseIdentity:unique symbol=Symbol("trusted browser isolation lease");
/** Future trusted native adapter contract; JSON/PIDs/flags cannot construct this nominal lease. */
export interface BrowserIsolationLease {
 readonly [leaseIdentity]:true;
 readonly backend:BrowserIsolationBackend;
 readonly generation:string;
 /** Revalidate exact native containment and descendant ownership, rejecting ambiguity. */
 assertOwned(signal:AbortSignal):Promise<void>;
 /** Close only the owned native containment; preserve proof if cleanup cannot be established. */
 close():Promise<void>;
}
export interface BrowserIsolationAdapter {
 readonly backend:BrowserIsolationBackend;
 /** An adapter is not selectable until a later reviewed capability/acceptance contract is added. */
 publicCapability():BrowserIsolationCapability;
}
export function browserIsolationCapability(backend:BrowserIsolationBackend,platform:NodeJS.Platform=process.platform):BrowserIsolationCapability{
 const selected=BrowserIsolationBackendSchema.parse(backend);
 return BrowserIsolationCapabilitySchema.parse({status:"unavailable",backend:selected,
 code:(selected==="linux_netns_v1"&&platform!=="linux")||(selected==="windows_appcontainer_v1"&&platform!=="win32")?"unsupported_platform":"adapter_not_installed",
 message:"Hydrated browser isolation is unavailable on this host; static checks remain supported."});
}
export class BrowserIsolationUnavailableError extends Error{
 readonly code="browser_isolation_unavailable";
 readonly capability:BrowserIsolationCapability;
 constructor(capability:BrowserIsolationCapability){const validated=BrowserIsolationCapabilitySchema.parse(capability);super(validated.message);this.capability=validated;this.name="BrowserIsolationUnavailableError";}
}
/** Deliberately no launch or fake proof fallback in this prerequisite. */
export function requireBrowserIsolation(backend:BrowserIsolationBackend,platform:NodeJS.Platform=process.platform):never{
 throw new BrowserIsolationUnavailableError(browserIsolationCapability(backend,platform));
}
