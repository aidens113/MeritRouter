import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Billing classes now belong to each provider key (providers.<id>.keys[].billing_class). */
export async function POST() {
  return handle(async () => {
    throw new HttpError(410, "Set billing_class on the key under providers in the config.");
  });
}
