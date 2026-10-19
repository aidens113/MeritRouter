/** Optional panel login: enabled only when SWITCHYARD_PANEL_TOKEN is set. */
export const TOKEN_ENV = "SWITCHYARD_PANEL_TOKEN";
export const SESSION_COOKIE = "sy_panel_session";

export function panelToken(): string | null {
  const t = process.env[TOKEN_ENV];
  return t && t.length > 0 ? t : null;
}

/** Cookie value derived from the token, so the token itself is never stored in the browser. */
export async function sessionValue(token: string): Promise<string> {
  const data = new TextEncoder().encode(`switchyard-panel-session:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
