import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST() {
  return handle(async (sy) => {
    if (!sy.admin) {
      throw new HttpError(
        409,
        `Scanning needs a FreeLLMAPI dashboard token. Set ${sy.cfg.gateway.admin_token_env} in the environment that runs the panel, then restart it.`,
      );
    }
    const summary = await sy.scan();
    return { summary };
  });
}
