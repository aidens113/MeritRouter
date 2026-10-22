export { blockedAddress, checkHostResolves, checkWebUrl, guardedLookup, SsrfRefusal, systemResolver, urlHost, type Resolver } from "./address-guard.js";
export { ollamaFetch, searchWith, SEARCH_SERVICE_BASE, WebBackendError, type BackendIO, type FetchResult, type SearchResult, type SearchTarget } from "./backends.js";
export { secretFingerprint, WebBackendState, type WebKeyState, type WebKeyStatus } from "./backend-state.js";
export { decodeEntities, htmlToText, type PageText } from "./html-text.js";
export { fetchPage, nodeTransport, type FetchedPage, type PageFetchOptions, type PageResponse, type PageTransport } from "./page-fetch.js";
export { utcDayStart, utcMonth, WebLedger, type AttemptInput, type ReserveOutcome, type WebBudget, type WebRequestKind, type WebRequestRow, type WebRequestStatus } from "./ledger.js";
export {
  OLLAMA_WEB_PROVIDER,
  WEB_REQUEST_EVENT,
  WebAccess,
  type WebAccessDeps,
  type WebAttempt,
  type WebBackendStatus,
  type WebBackendView,
  type WebCaller,
  type WebKeyView,
  type WebStatus,
} from "./access.js";
export {
  isSearchService,
  SEARCH_SERVICE_IDS,
  SEARCH_SERVICES,
  WEB_BACKEND_NAMES,
  WEB_FETCH_BACKENDS,
  WEB_SEARCH_BACKEND_SETTINGS,
  WEB_SEARCH_BACKENDS,
  WEB_SEARCH_STRATEGIES,
  type SearchServiceId,
  type WebFetchBackend,
  type WebSearchBackend,
  type WebSearchBackendSetting,
  type WebSearchStrategy,
} from "./services.js";
