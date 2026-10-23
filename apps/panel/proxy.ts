import { NextResponse, type NextRequest } from "next/server";
import { panelToken, safeEqual, sessionValue, SESSION_COOKIE } from "./lib/auth";
import { LAST_PROJECT_COOKIE, PATH_HEADER, SLUG_RE, slugOfPath } from "./lib/links";

const OPEN = ["/login", "/api/login"];

/** The sign-in gate: null lets the request through, otherwise the response that stops it. */
async function gate(req: NextRequest): Promise<NextResponse | null> {
  const token = panelToken();
  if (!token) return null;
  const { pathname, search } = req.nextUrl;
  if (OPEN.includes(pathname)) return null;
  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  if (cookie && safeEqual(cookie, await sessionValue(token))) return null;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export async function proxy(req: NextRequest) {
  // Settings and operator approvals are human authority. A page on another origin must
  // never be able to submit them with the user's panel session (or loopback access).
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    // Next normalizes nextUrl's host to localhost on loopback deployments. The browser
    // sends its actual request authority in Host; compare against that authority.
    let sameOrigin = origin === null;
    if (origin !== null) {
      try { sameOrigin = origin === new URL(`${req.nextUrl.protocol}//${req.headers.get("host") ?? req.nextUrl.host}`).origin; }
      catch { sameOrigin = false; }
    }
    if (!sameOrigin || site === "cross-site") {
      return NextResponse.json({ ok: false, error: "Cross-origin actions are not allowed" }, { status: 403 });
    }
  }
  const stopped = await gate(req);
  if (stopped) return stopped;
  // The request's path, for layouts (they are not given it): app/p/[slug]/layout.tsx lets an
  // archived project's settings page through and 404s its other pages. Always overwritten here.
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, req.nextUrl.pathname);
  const res = NextResponse.next({ request: { headers } });
  // Remember the project being opened, so the old project-less URLs (/jobs, /tasks, ...) can
  // redirect to it. The pages themselves 404 an unknown or archived slug, and the redirects check
  // the remembered slug again before using it.
  const slug = slugOfPath(req.nextUrl.pathname);
  if (slug && SLUG_RE.test(slug) && req.cookies.get(LAST_PROJECT_COOKIE)?.value !== slug) {
    res.cookies.set(LAST_PROJECT_COOKIE, slug, { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
