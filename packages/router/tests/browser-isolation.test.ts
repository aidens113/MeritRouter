import { expect, it } from "vitest";
import { browserIsolationCapability, BrowserIsolationCapabilitySchema, BrowserIsolationUnavailableError, requireBrowserIsolation } from "../src/labs/browser-isolation.js";
it('has no accepted adapter and keeps Windows explicitly unavailable',()=>{
 expect(browserIsolationCapability('windows_appcontainer_v1','win32')).toMatchObject({status:'unavailable',code:'adapter_not_installed'});
 expect(browserIsolationCapability('linux_netns_v1','win32')).toMatchObject({status:'unavailable',code:'unsupported_platform'});
 expect(browserIsolationCapability('linux_netns_v1','linux').status).toBe('unavailable');
 expect(()=>requireBrowserIsolation('windows_appcontainer_v1','win32')).toThrow(BrowserIsolationUnavailableError);
});
it('rejects boolean/JSON proof and arbitrary executable capability fields',()=>{
 for(const value of [true,{available:true},{status:'available',backend:'linux_netns_v1',proof:true},{...browserIsolationCapability('linux_netns_v1','linux'),pid:1,contained:true}])expect(BrowserIsolationCapabilitySchema.safeParse(value).success).toBe(false);
 expect(()=>browserIsolationCapability('flags_only' as never)).toThrow();
});
