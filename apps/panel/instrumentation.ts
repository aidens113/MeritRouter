/** Start the saved local listener with the panel, without waiting for a page visit. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startPanelConnections } = await import("./lib/sy");
  startPanelConnections();
}
