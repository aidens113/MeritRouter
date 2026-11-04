import { AsyncLocalStorage } from "node:async_hooks";
import { TaskValidationError } from "./errors.js";

interface OperationScope {
  project: string;
  originProject: string;
  active: boolean;
  promotionProject: string | null;
}

/** One service's admitted effects, including their live, same-project descendants. */
export class ServiceOperations {
  private readonly context = new AsyncLocalStorage<OperationScope>();
  private readonly pending = new Set<Promise<unknown>>();
  private draining = false;

  seal(): void { this.draining = true; }

  /** Explicit host scheduler/timer boundary; never revives an inherited ended scope. */
  runRoot<T>(project: string, work: () => Promise<T>): Promise<T> {
    return this.context.exit(() => this.run(project, work));
  }

  allowsPromotionRetry(project?: string): boolean {
    const scope = this.context.getStore();
    return !!scope?.active && scope.promotionProject === scope.project && (project === undefined || scope.project === project);
  }

  owns(project: string): boolean { const scope = this.context.getStore(); return !!scope?.active && scope.project === project; }

  assertCurrent(project: string): void {
    const scope = this.context.getStore();
    if (!scope?.active || scope.project !== project) throw new TaskValidationError("service operation no longer owns this project");
  }

  run<T>(project: string, work: () => Promise<T>, promotion = false): Promise<T> {
    const parent = this.context.getStore();
    if (parent && !parent.active) return Promise.reject(new TaskValidationError("service operation has ended"));
    // Resource lifetime is not an ACL. Authorized shared Brain reads can cross projects,
    // but a resource hop can never mint or move promotion retry authority.
    if (promotion && parent && parent.originProject !== project)
      return Promise.reject(new TaskValidationError("service operation does not own this promotion project"));
    if (this.draining && !parent?.active) return Promise.reject(new TaskValidationError("service is closing"));
    const scope: OperationScope = { project, originProject: parent?.originProject ?? project, active: true, promotionProject: promotion ? project : parent?.promotionProject ?? null };
    let result: Promise<T>;
    try { result = this.context.run(scope, work); }
    catch (error) { result = Promise.reject(error); }
    const tracked = Promise.resolve(result).finally(() => { scope.active = false; this.pending.delete(tracked); });
    this.pending.add(tracked);
    return tracked;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
