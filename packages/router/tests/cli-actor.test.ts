import {describe,it,expect} from "vitest";
import {cliDecisionActor} from "../src/cli/actor.js";
describe("truthful CLI authority",()=>{
  it("never assumes automation is a human",()=>expect(cliDecisionActor({id:"cli:test",humanRequested:false,stdinIsTTY:false,stdoutIsTTY:false})).toEqual({kind:"supervisor",id:"supervisor:cli:test"}));
  it("requires interactive human attestation even when a caller passes the flag",()=>expect(()=>cliDecisionActor({id:"cli:test",humanRequested:true,stdinIsTTY:false,stdoutIsTTY:false})).toThrow(/human_authority_required/));
  it("does not silently promote interactive agents without the explicit flag",()=>expect(cliDecisionActor({id:"cli:test",humanRequested:false,stdinIsTTY:true,stdoutIsTTY:true}).kind).toBe("supervisor"));
  it("records an explicit interactive human decision",()=>expect(cliDecisionActor({id:"cli:test",humanRequested:true,stdinIsTTY:true,stdoutIsTTY:true}).kind).toBe("human"));
});
