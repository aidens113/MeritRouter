export { Switchyard, type SwitchyardOptions, type TaskStatus, type AwaitOutcome } from "./core/service.js";
export { loadConfig, parseConfig, resolveConfigPath, CONFIG_ENV, DEFAULT_CONFIG_NAME, type ResolvedConfig } from "./config/load.js";
export * from "./config/schema.js";
export { ProjectConfigSchema, PROJECT_TEAM_KEYS, PROJECT_CODING_KEYS, PROJECT_SUPERVISOR_KEYS, type ProjectConfig } from "./projects/schema.js";
export { ProjectLimitsSchema, projectLimits, type ProjectLimits } from "./projects/schema.js";
export { resolveProjects, deepMerge, type ResolvedProject, type ProjectsResolution, type ProjectOverrides } from "./projects/resolve.js";
export { projectContext, repoKey, splitRepoKey, type ProjectContext, type ProjectInfo } from "./projects/context.js";
export { ProjectRegistry, type ProjectRow } from "./projects/registry.js";
export { LabManager, type LabStatus, type LabManagerOptions } from "./labs/lab.js";
export { LabsConfigSchema, LabRecipeSchema, ProjectLabsSchema, LabNameSchema, type LabsConfig, type LabRecipe } from "./labs/recipe.js";
export { type LabRecord, type LabServiceRecord } from "./labs/store.js";
export { type LabCheckResult } from "./labs/checks.js";
export { backfillProjects } from "./projects/backfill.js";
export {
  WorkerTaskSchema,
  WorkerResultSchema,
  TASK_STATES,
  isTerminal,
  AcceptanceCriterionSchema,
  AcceptanceStatusSchema,
  VerificationStatusSchema,
  VerificationRecordSchema,
  SupervisorDecisionSchema,
  CheckOutcomeSchema,
  CriterionOutcomeSchema,
  CriterionVerifySchema,
  ACCEPTANCE_STATUSES,
  VERIFICATION_STATUSES,
  CHECK_OUTCOMES,
  CRITERION_OUTCOMES,
  CRITERION_VERIFY_KINDS,
  autoCriterionId,
  criteria,
  criterionTexts,
  type WorkerTask,
  type WorkerTaskInput,
  type WorkerResult,
  type TaskState,
  type Usage,
  type Criterion,
  type CriterionVerify,
  type AcceptanceCriterionInput,
  type AcceptanceStatus,
  type VerificationStatus,
  type VerificationRecord,
  type SupervisorDecision,
  type CheckOutcome,
  type CriterionOutcome,
  ReviewRecordSchema,
  type ReviewRecord,
} from "./core/task.js";
export type { AcceptanceDecisionInput, AcceptanceDecisionOutcome, RetryContext } from "./runners/types.js";
export {
  AcceptanceContractSchema,
  BudgetAllocationSchema,
  ContractStore,
  allocateBudget,
  canonicalContractJson,
  compileContract,
  contractDigest,
  executionCap,
  repairCap,
  reviewAllowance,
  reviewCap,
  reviewReserveAdjustment,
  type RequestsUsed,
  type AcceptanceContract,
  type BudgetAllocation,
  type BudgetInput,
  type CompileInput,
  type CompileResult,
  type StoredContract,
} from "./verification/contract.js";
export { BUILTIN_RULES, LEVEL_RANK, evaluatePolicy, policyFingerprint, reevaluateOnResult, resolveLevel, strongerLevel, type PolicyEvaluation, type PolicyInput, type Reevaluation, type ResolvedLevel, type ResolvedReview } from "./verification/policy.js";
export { IMPORTANCE_RANK, effectiveImportance, formatImportanceSource, strongerImportance, type EffectiveImportance, type ImportanceSource } from "./verification/importance.js";
export { NAMED_CHECKS, checkRunOutcome, runNamedChecks, selfReportFromOutput, type CheckReport, type CriterionResult, type NamedCheckResult, type SelfReportEntry } from "./verification/checks.js";
export { applySupervisorDecision, decide as decideVerification, verificationRecord, type Decision as VerificationDecision, type ReviewOutcome, type SupervisorDecisionInput, type SupervisorDecisionResult } from "./verification/decide.js";
export {
  RECOMMENDED_ACTIONS,
  SUBMIT_VERDICT_DEF,
  VERDICTS,
  VERDICT_CONTRACT,
  VERDICT_JSON_SCHEMA,
  VerdictSchema,
  answerDigest,
  renderEvidencePackage,
  reviewOutcomeOf,
  reviewProfile,
  reviewResult,
  runReviewSession,
  submitVerdictTool,
  validateVerdict,
  type EvidenceInput,
  type ReviewPhaseResult,
  type Verdict,
  type VerdictExpectations,
} from "./verification/review.js";
export { repairRetryContext, runTargetedChecks, submittedRevisionStart, targetedCheckAllowed } from "./verification/followup.js";
export {
  SIGNAL_KINDS,
  VERDICT_PURPOSES,
  calibratedReview,
  calibrationUndoHook,
  cachedVerdict,
  judgedContractDigest,
  INTEGRATION_RECORDED_EVENT,
  recordIntegration,
  recordJobCheck,
  recordSignal,
  recordVerdict,
  resultRevision,
  reviewCacheKey,
  sameRevision,
  taskConfirmation,
  verdictCacheKey,
  verdictOutcome,
  verdictRecords,
  type CacheQuery,
  type ConfirmationStatus,
  type SignalKind,
  type StoredVerdict,
  type TaskConfirmation,
  type VerdictCacheKeyParts,
  type VerdictInput,
  type VerdictOutcome,
  type VerdictPurpose,
} from "./verification/calibration.js";
export { Auditor, auditCapacityShortfall, auditSampled, type AuditDecision, type AuditHost, type AuditStart } from "./verification/audit.js";
export { PROMOTION_RUBRIC, PROMOTION_RUBRIC_VERSION, PromotionReviewer } from "./verification/promotion-review.js";
export { GlobalPromotions, PROMOTION_STATUSES, projectSpecificIssues, type PromotionOutcome, type PromotionRecord, type PromotionStatus, type PromotionReviewPort } from "./brain/promotion.js";
export { systemManaged, isBrainIndex } from "./brain/access.js";
export { projectIndexPath } from "./brain/brain.js";
export { REQUEST_PURPOSES, budgetInputFor, purposeCategory, verificationTotal, carvedRequests, carvesOf, childRequestBudget, heldRequests, type RequestPurpose, type BudgetCarve } from "./admission/admission.js";
export { BUDGET_APPROVERS, BUDGET_REQUEST_STATUSES, BudgetRequests, defaultTaskGrant, jobPool, type BudgetApprover, type BudgetRequest, type BudgetRequestStatus, type JobPool } from "./admission/budget-requests.js";
export { extraRequests, grantOf, grantsOf, workerHeld, type TaskGrant } from "./admission/job-pool.js";
export { REVIEW_FAMILY, reviewerQualification } from "./qualification/stats.js";
export { gradeReview, reviewEvalPackage } from "./qualification/runner.js";
export { QUALIFICATION_PROJECT } from "./qualification/registry.js";
export { SwitchyardError, ConfigError, TaskValidationError, AdmissionDenied, GatewayError, PAID_BUDGET_DENIALS } from "./core/errors.js";
export { Catalog, endpointIdFor, EndpointOverrideSchema, RoutingOverrideSchema, type ModelEndpoint, type EndpointOverride, type RoutingOverride, type EndpointStatus, type ParamEvidence, NATIVE_WEB_SEARCH_VIAS, type NativeWebSearch, type NativeWebSearchVia } from "./models/catalog.js";
export { modelFamily, planRoute, type RoutePlan, type CandidateExplanation, type ReviewerQualificationRequirement } from "./routing/select.js";
export { DEFAULT_RULEBOOK, RulebookSchema, TAG_GROUPS, type Rulebook } from "./scoring/rulebook.js";
export type { Classification, ScoreLine } from "./scoring/score.js";
export type { ChatRequest, ChatResponse, ProviderStatus, WebCitation, NativeWebSearchOutcome } from "./gateway/types.js";
// Providers: registry, key vault, credentials, client, key state, limits, health, discovery.
export * from "./providers/index.js";
export { isPaid, freeKeyOnly, requestPaid, planSearch } from "./routing/select.js";
export { nativeSearchUse, alwaysSearches, type NativeSearchUse } from "./routing/native-search.js";
export { detectNativeWebSearch, type NativeSearchRequest, type ListedWebSearch } from "./providers/native-search.js";
export type { UsageSummary } from "./storage/usage.js";
export type { ScanSummary } from "./models/scanner.js";
export * as insights from "./admin/insights.js";
export type { BrainCommitDetail, BrainHistoryEntry } from "./admin/brain-entities.js";
export type { PlanRecoveryEvidence, PlanRecoveryView } from "./admin/plan-recovery.js";
export type { JobPlanView, PlanNodeView, PlanEdge, PlanWait, PlanLeaseView, PlanVersionSummary } from "./admin/job-plans.js";
export { jobMetrics, teamMetrics, agentTimeline, parallelismSeries, seriesStats, longestChain, WAIT_REASONS, WAITING_FOR_PROVIDER_SLOT, type JobMetrics, type JobMetricsSummary, type ParallelismPoint, type AgentTimeline, type WaitReason } from "./admin/job-metrics.js";
export { planComparison, runComparison, comparisons, comparison, comparisonRequestsToday, ComparisonGoalsSchema, COMPARISON_PURPOSE, DEFAULT_TEAM_FACTOR, type ComparisonPlan, type ComparisonGoal, type ComparisonRecord, type ComparisonResult, type ComparisonRunRecord, type MetricsSnapshot } from "./qualification/comparison.js";
export {
  PlanStore,
  PlanNodeSchema,
  assertPlanGraph,
  criticalPath,
  nodeWeight,
  defaultRequiresAcceptedInputs,
  requiresAcceptedInputs,
  TIER_WEIGHT,
  DEFAULT_NODE_WEIGHT,
  MAX_PLAN_NODES,
  PLAN_DIFFICULTIES,
  PLAN_LABEL_RE,
  MAX_REDUNDANCY,
  REDUNDANT_DIFFICULTIES,
  redundancyFor,
  type JobPlan,
  type PlanNode,
  type PlanNodeInput,
  type PlanDifficulty,
  type CriticalPath,
} from "./storage/plans.js";
export { FileLeaseStore, LEASE_MODES, globsOverlap, writeGlobs, type FileLease, type LeaseMode } from "./storage/file-leases.js";
export { AWAITING_ACCEPTANCE, WAITING_FOR_FILE_LEASE, WAITING_FOR_PROJECT_CAP, projectCapReason } from "./storage/tasks.js";
export { UPSTREAM_CONTEXT_EVENT, UPSTREAM_RESULTS_KIND, INTEGRATED_EVENT, type UpstreamContext, type UpstreamPackage, type UpstreamEntry, type BaseChoice } from "./context/upstream.js";
export { SessionStore, CreateSessionInputSchema, SESSIONS_DIR, PROCESS_DIED, type CreateSessionInput, type SessionRecord, type SessionListFilter, type SessionEventsPage, type ReopenOptions } from "./sessions/store.js";
export { SessionRecorder, type ModelRequestInput, type ModelErrorInput, type ToolIntentInput, type ToolOutcomeInput } from "./sessions/recorder.js";
export {
  SessionEventSchema,
  SessionStatusSchema,
  SessionWorkspaceSchema,
  ToolSideEffectSchema,
  SESSION_STATUSES,
  SESSION_EVENT_TYPES,
  TOOL_SIDE_EFFECTS,
  TOOL_OUTPUT_CAP_BYTES,
  ResumeActionSchema,
  RecoverEditsPolicySchema,
  type ResumeAction,
  type ResumeToolRef,
  type RecoverEditsPolicy,
  type SessionEvent,
  type SessionEventOf,
  type SessionEventData,
  type SessionEventType,
  type SessionStatus,
  type SessionEndStatus,
  type SessionWorkspace,
  type WorkspaceRepo,
  type ToolSideEffect,
  type CorruptLine,
} from "./sessions/events.js";
export {
  planResume,
  replayTranscript,
  pendingIntentsFrom,
  editRecoveryMessage,
  RESUME_TEXT,
  type PendingIntent,
  type PlanResumeOptions,
  type ResumePlan,
  type TranscriptReplay,
} from "./sessions/resume.js";
export { createCodingRunner } from "./runners/coding/index.js";
// Agent teams (T2): sub-jobs, the merge queue, the team channel, redundant execution.
export { jobDepth, subJobSection, type SupervisorState, type IntegrationRepo } from "./harness/supervisor-tools.js";
export { prepareRepository, folderState, preparationHint, DEFAULT_GITIGNORE, type PrepareResult, type PrepareAction, type PrepareErrorKind, type FolderState } from "./workspaces/repository-prepare.js";
export { prepareProjectRepositories, repositoryNotices, repositoryProblems, REPOSITORY_PREPARE_EVENT, type RepositoryPreparation } from "./projects/repository-setup.js";
export { MergeQueue, MERGE_STATES, ACTIVE_MERGE_STATES, MAX_MERGE_ATTEMPTS, type MergeItem, type MergeState, type MergeHooks, type MergeConflict, type MergeAcceptance } from "./workspaces/merge-queue.js";
export {
  ChannelStore,
  ChannelError,
  ChannelPostInputSchema,
  CHANNEL_KINDS,
  CHANNEL_MAX_TEXT_CHARS,
  CHANNEL_MAX_REFS,
  CHANNEL_READ_LIMIT,
  type ChannelKind,
  type ChannelPost,
  type ChannelAuthor,
  type ChannelReadFilter,
} from "./storage/channel.js";
export { channelTools, renderChannelPost, mirrorChannel } from "./harness/channel-tools.js";
export { REDUNDANCY_STARTED, REDUNDANCY_SKIPPED, REDUNDANCY_SETTLED, SUPERSEDED, type RedundancyPlan } from "./core/redundancy.js";
export { WATCHDOG_CHECK_RUNNING_TOOLS, WATCHDOG_EXEMPT_TOOLS, WATCHDOG_MARGIN_MS, watchdogVerdict, type WatchdogVerdict, type SessionProgress } from "./core/watchdog.js";
export { commitsMatching, commitsOfTasks, type CommitInfo } from "./attribution/index.js";
export { markPanelStopped, panelStopFile, turnPanelOff } from "./operations/panel.js";
export * from "./web/index.js";
export { webTools } from "./harness/web-tools.js";
