import type { LabManager } from "./lab.js";
import type { LabRecord } from "./store.js";
import { labChecks } from "./checks.js";
import { BrowserJourneyCheckSchema } from "./browser-journey-schema.js";
import { journeySourceSnapshot, journeyInputsDigest, journeyEnvironmentDigest } from "./browser-journey-evidence.js";
import { browserCheckDirectory, readBrowserScreenshot } from "./browser-artifacts.js";
import { ownedBrowserEndpoint } from "./browser-network.js";
import { probeDockerBrowser } from "./browser-docker.js";
import { productDigest } from "../verification/product-spec.js";
import { ProductCandidateSchema } from "../verification/product-evidence.js";
/** Service-owned evidence binding; caller/model flags cannot substitute for live revalidation. */
export async function resolveCurrentJourneyCandidate(manager: LabManager, lab: LabRecord, specDigest: string, signal: AbortSignal) {
  // A newer failed/cancelled/stale run supersedes prior passes. Never search backwards
  // until a convenient green result appears for the same active specification.
  const newest = labChecks(manager.store, lab.id).find(check => check.journey?.specDigest === specDigest);
  const checks = newest ? [newest] : [];
  for (const check of checks) {
    const evidence = check.journey;
    if (!evidence || check.exitCode !== 0 || check.killed || evidence.status !== "passed" || evidence.cleanup !== "complete" || !evidence.scriptsEnabled || !evidence.isolation || !evidence.browser || evidence.specDigest !== specDigest || !evidence.fixtureAfterDigest)
      continue;
    try {
      signal.throwIfAborted();
      const spec = BrowserJourneyCheckSchema.parse(lab.recipe.checks[check.name]);
      if (spec.specDigest !== specDigest || productDigest(spec.steps) !== evidence.testDigest || productDigest(lab.recipe) !== evidence.recipeDigest || evidence.steps.length !== spec.steps.length || evidence.steps.some(step => !step.passed) || evidence.violations.length || evidence.pageErrors.length)
        continue;
      if (evidence.steps.some((step, index) => step.id !== spec.steps[index]!.id || step.action !== spec.steps[index]!.action || productDigest(step.criterionIds) !== productDigest(spec.steps[index]!.criterionIds)))
        continue;
      const current = await journeySourceSnapshot(lab, signal);
      if (productDigest(current.heads) !== productDigest(evidence.heads) || productDigest(current.trees) !== productDigest(evidence.trees) || current.dependencyDigest !== evidence.dependencyDigest)
        continue;
      // Data may legitimately mutate within the journey. Match its observed final state,
      // while candidate.fixtureDigest retains the exact tested initial input identity.
      if (await journeyInputsDigest(lab, spec, signal) !== evidence.fixtureAfterDigest)
        continue;
      const endpoint = await ownedBrowserEndpoint(manager, lab, spec.service);
      if (productDigest(endpoint) !== evidence.serviceIdentities.at(-1))
        continue;
      const actual = await probeDockerBrowser(spec.isolation, browserCheckDirectory(lab, check.id), signal);
      if (actual.engineId !== evidence.isolation.engineId || actual.imageId !== evidence.isolation.imageId || journeyEnvironmentDigest(evidence) !== evidence.environmentDigest)
        continue;
      for (const screenshot of evidence.artifacts)
        readBrowserScreenshot(lab, check.id, screenshot);
      const candidate = ProductCandidateSchema.parse({ repositories: Object.fromEntries(Object.keys(current.heads).map(alias => [alias, { head: current.heads[alias], tree: current.trees[alias] }])), testDigest: evidence.testDigest, recipeDigest: evidence.recipeDigest, environmentDigest: evidence.environmentDigest, dependencyDigest: evidence.dependencyDigest, fixtureDigest: evidence.fixtureDigest, browserGeneration: evidence.isolation.generation });
      return { candidate, check };
    }
    catch (error) {
      if (signal.aborted)
        throw error; /* Missing/changed runtime is stale evidence, never a preserved pass. */
    }
  }
  return null;
}
