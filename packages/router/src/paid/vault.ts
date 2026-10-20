// The key vault moved to src/providers/vault.ts (direct providers, P1). This re-export keeps
// existing imports compiling until P2 removes src/paid/.
export * from "../providers/vault.js";
