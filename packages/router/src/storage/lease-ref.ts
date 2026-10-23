import { z } from "zod";
/** Immutable task execution identity shared by storage and low-level effect guards. */
export const LeaseRefSchema = z.object({
  taskId: z.string().min(1).max(64), owner: z.string().min(1).max(200),
  runCount: z.number().int().positive(), project: z.string().max(200), incarnation: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();
export type LeaseRef = Readonly<z.infer<typeof LeaseRefSchema>>;
