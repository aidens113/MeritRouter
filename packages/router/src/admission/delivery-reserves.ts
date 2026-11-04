import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";

type Policy = Pick<ResolvedConfig["supervisor"]["delivery_budget"],
  "reserve_mode" | "total_requests" | "supervisor_reserve_requests" | "validation_reserve_requests">;
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Input = z.object({ mode: z.enum(["proportional", "fixed"]), nominal: safeCount.positive(),
  supervisor: safeCount, validation: safeCount, cap: safeCount.positive().nullable() }).strict();

/** Reserve allocation only: never changes a request, token, paid or acceptance limit. */
export function deliveryReserves(policy: Policy, cap: number | null): { supervisor: number; validation: number } {
  const input = Input.parse({ mode: policy.reserve_mode, nominal: policy.total_requests,
    supervisor: policy.supervisor_reserve_requests, validation: policy.validation_reserve_requests, cap });
  if (input.mode === "fixed" || input.cap === null || input.cap >= input.nominal)
    return { supervisor: input.supervisor, validation: input.validation };
  const denominator = BigInt(input.nominal), numerator = BigInt(input.cap);
  // BigInt avoids an unsafe intermediate product even though every input/result is safe.
  const scale = (count: number) => Number((BigInt(count) * numerator + denominator - 1n) / denominator);
  return { supervisor: scale(input.supervisor), validation: scale(input.validation) };
}
