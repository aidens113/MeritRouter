import { immediate, type Db } from "../storage/db.js";

/**
 * Give every row without a project to `primary` and namespace bare repository aliases as
 * `<project>/<alias>` (decisions D3 and D6). Rows from before projects existed (and rows written
 * without a project since, such as a session with no task) land in the primary project, so a
 * single-project install sees all of its history in its one project. Idempotent and cheap when
 * nothing is unassigned; run at every service start.
 */
export function backfillProjects(db: Db, primary: string): { tasks: number } {
  return immediate(db, () => {
    const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args).changes;
    const tasks = run("UPDATE tasks SET project_id = ? WHERE project_id = ''", primary);
    run("UPDATE tasks SET writable_repo = project_id || '/' || writable_repo WHERE writable_repo IS NOT NULL AND project_id != '' AND instr(writable_repo, '/') = 0");
    const taskProject = (col: string) => `COALESCE((SELECT t.project_id FROM tasks t WHERE t.id = ${col}), ?)`;
    run(`UPDATE file_leases SET repository = ${taskProject("file_leases.task_id")} || '/' || repository WHERE instr(repository, '/') = 0`, primary);
    // lock_key is <alias>:<branch>; the alias part has no '/' until namespaced (branches may have one).
    run(`UPDATE merge_queue SET lock_key = ${taskProject("merge_queue.job_id")} || '/' || lock_key WHERE instr(substr(lock_key, 1, instr(lock_key, ':')), '/') = 0`, primary);
    run(`UPDATE sessions SET project_id = ${taskProject("sessions.task_id")} WHERE project_id = ''`, primary);
    run(`UPDATE job_state SET project_id = ${taskProject("job_state.task_id")} WHERE project_id = ''`, primary);
    run(`UPDATE brain_access_requests SET project_id = ${taskProject("COALESCE(brain_access_requests.task_id, brain_access_requests.job_id)")} WHERE project_id = ''`, primary);
    run(`UPDATE brain_grants SET project_id = ${taskProject("brain_grants.task_id")} WHERE project_id = ''`, primary);
    run(`UPDATE job_plans SET project_id = ${taskProject("job_plans.job_id")} WHERE project_id = ''`, primary);
    run("UPDATE events SET project_id = (SELECT t.project_id FROM tasks t WHERE t.id = events.task_id) WHERE (project_id IS NULL OR project_id = '') AND task_id IS NOT NULL");
    // Requests charged to a task take its project; requests charged to none (probes) stay global ('').
    run("UPDATE model_requests SET project_id = (SELECT t.project_id FROM request_charges c JOIN tasks t ON t.id = c.task_id WHERE c.request_id = model_requests.id LIMIT 1) WHERE project_id = '' AND EXISTS (SELECT 1 FROM request_charges c WHERE c.request_id = model_requests.id)");
    return { tasks };
  });
}
