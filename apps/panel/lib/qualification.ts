import "server-only";
import { notFound } from "next/navigation";
import { insights, type MeritRouter } from "meritrouter";
import type { DetailScope } from "@/components/detail-scope";
import { QUALIFICATION_BASE, QUALIFICATION_SLUG } from "./links";

// The reserved `_qualification` project's work (qualification eval trials and comparison runs on
// eval goals) is viewed under /all/qualification: it is never a project, so it has no /p/ pages.

/** Detail views under /all/qualification: no actions, no list pages (a job links to its task view). */
export const QUALIFICATION_SCOPE: DetailScope = {
  project: QUALIFICATION_SLUG,
  base: QUALIFICATION_BASE,
  back: { href: `${QUALIFICATION_BASE}#work`, label: "Qualification" },
  actions: false,
  lists: false,
};

/** 404 unless task `taskId` is the qualification project's. */
export function requireQualificationTask(sy: MeritRouter, taskId: string): void {
  if (!insights.isQualificationTask(sy, taskId)) notFound();
}

/** 404 unless session `sessionId` is of a qualification project task. */
export function requireQualificationSession(sy: MeritRouter, sessionId: string): void {
  const s = sy.sessions.get(sessionId);
  if (!s?.taskId || !insights.isQualificationTask(sy, s.taskId)) notFound();
}
