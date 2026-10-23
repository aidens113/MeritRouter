import { LockKeyhole } from "lucide-react";
import { buttonClass } from "@/components/ui";
import { panelToken, TOKEN_ENV } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  const failed = sp.error !== undefined;
  const enabled = panelToken() !== null;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form method="post" action="/api/login" className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
            <LockKeyhole size={18} aria-hidden />
          </span>
          <div>
            <h1 className="text-base font-semibold text-ink">Sign in to MeritRouter</h1>
            <p className="text-xs text-ink-3">Enter the panel token ({TOKEN_ENV}).</p>
          </div>
        </div>
        {!enabled ? <p className="mb-3 text-sm text-ink-2">Login is not enabled: {TOKEN_ENV} is not set, so the panel is open on localhost.</p> : null}
        <input type="hidden" name="next" value={next} />
        <label className="block text-sm font-medium text-ink" htmlFor="token">
          Panel token
        </label>
        <input id="token" name="token" type="password" autoComplete="current-password" autoFocus required={enabled} className="field mt-1" aria-invalid={failed} />
        {failed ? <p className="mt-2 text-xs text-bad-ink" role="alert">That token is not correct.</p> : null}
        <button type="submit" className={`${buttonClass("primary")} mt-4 w-full`}>
          {enabled ? "Sign in" : "Continue"}
        </button>
      </form>
    </div>
  );
}
