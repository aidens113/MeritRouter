export interface RepeatOutcome { ok: boolean; output: string }

/** Fresh observations are compared by outcome, never substituted for an authoritative read. */
export class RepeatObservations {
  private readonly states = new Map<string, { outcome: RepeatOutcome; unchanged: number }>();
  observe(signature: string, outcome: RepeatOutcome): { warn: boolean; stalled: boolean } {
    const previous = this.states.get(signature);
    const unchanged = previous?.outcome.ok === outcome.ok && previous.outcome.output === outcome.output
      ? previous.unchanged + 1 : 1;
    this.states.set(signature, { outcome, unchanged });
    return { warn: unchanged === 2, stalled: unchanged >= 3 };
  }
  progress(): void { this.states.clear(); }
}
