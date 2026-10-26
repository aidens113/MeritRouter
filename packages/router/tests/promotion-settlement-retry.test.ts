import { afterEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import { WorkerTaskSchema } from "../src/core/task.js";
import { RepositoryMutationError } from "../src/workspaces/repository-mutation.js";
import { PROMOTION_REVIEW_PURPOSE } from "../src/verification/promotion-review.js";
import type { MeritRouter } from "../src/core/service.js";
import { makeEnv, open, ScriptedClient, reply, summarizeTask, type Env } from "./helpers.js";

let env:Env|undefined,router:MeritRouter|undefined;
afterEach(async()=>{vi.useRealTimers();await router?.close();router=undefined;env?.cleanup();env=undefined;vi.restoreAllMocks();});
async function fixture(){
  env=makeEnv();router=open(env,new ScriptedClient(()=>reply("unused")),{worker:false});
  const [task]=router.tasks.submit([WorkerTaskSchema.parse(summarizeTask({id:"review"}))],{project:"demo"});
  router.db.prepare("UPDATE tasks SET purpose=? WHERE id=?").run(PROMOTION_REVIEW_PURPOSE,task!.taskId);
  vi.useFakeTimers();return router;
}
const notify=(sy:MeritRouter)=>(sy as unknown as {events:EventEmitter}).events.emit("settled","review");
it("retries transient promotion publication contention without another model request",async()=>{
  const sy=await fixture(),settle=vi.spyOn(sy,"settlePromotions").mockRejectedValueOnce(new RepositoryMutationError("lock_busy","busy")).mockResolvedValue(1);
  notify(sy);await vi.advanceTimersByTimeAsync(0);expect(settle).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(250);expect(settle).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10000);expect(settle).toHaveBeenCalledTimes(2);
});
it("keeps unresolved publication evidence for explicit recovery",async()=>{
  const sy=await fixture(),settle=vi.spyOn(sy,"settlePromotions").mockRejectedValue(new RepositoryMutationError("pending_publication","retained"));
  notify(sy);await vi.advanceTimersByTimeAsync(10000);expect(settle).toHaveBeenCalledTimes(1);
});
it("bounds contention retries and cancels pending retries on close",async()=>{
  const sy=await fixture(),settle=vi.spyOn(sy,"settlePromotions").mockRejectedValue(new RepositoryMutationError("lock_busy","busy"));
  notify(sy);await vi.advanceTimersByTimeAsync(10000);expect(settle).toHaveBeenCalledTimes(6);
  notify(sy);await vi.advanceTimersByTimeAsync(0);const count=settle.mock.calls.length;
  await sy.close();router=undefined;await vi.advanceTimersByTimeAsync(10000);expect(settle).toHaveBeenCalledTimes(count);
});
