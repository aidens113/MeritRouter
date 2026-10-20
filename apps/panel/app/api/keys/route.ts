import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Adding keys through the removed external gateway is gone; the vault-backed key page comes in P3. */
export async function POST() {
  return handle(async () => {
    throw new HttpError(410, "Provider keys are set under providers in the config until the panel's key page is rebuilt.");
  });
}
