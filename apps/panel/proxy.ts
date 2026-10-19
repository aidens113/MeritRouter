import { NextResponse, type NextRequest } from "next/server";
import { panelToken, safeEqual, sessionValue, SESSION_COOKIE } from "./lib/auth";

const OPEN = ["/login", "/api/login"];

export async function proxy(req: NextRequest) {
  const token = panelToken();
  if (!token) return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (OPEN.includes(pathname)) return NextResponse.next();
  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  if (cookie && safeEqual(cookie, await sessionValue(token))) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
