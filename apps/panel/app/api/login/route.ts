import { NextResponse } from "next/server";
import { panelToken, safeEqual, sessionValue, SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  const token = panelToken();
  const form = await req.formData().catch(() => null);
  const next = String(form?.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  // Relative Location headers: the request URL may say "localhost" while the panel binds 127.0.0.1.
  const go = (to: string) => new NextResponse(null, { status: 303, headers: { location: to } });
  if (!token) return go(safeNext);
  const given = String(form?.get("token") ?? "");
  if (!given || !safeEqual(await sessionValue(given), await sessionValue(token))) {
    return go(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
  }
  const res = go(safeNext);
  res.cookies.set(SESSION_COOKIE, await sessionValue(token), { httpOnly: true, sameSite: "strict", path: "/", secure: false, maxAge: 60 * 60 * 24 * 30 });
  return res;
}
