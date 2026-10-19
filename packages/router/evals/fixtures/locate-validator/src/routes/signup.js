import { normalizeEmail } from "../validation/normalize.js";
import { checkAddress } from "../validation/address.js";

export function handleSignup(body) {
  const email = normalizeEmail(body.email ?? "");
  if (!checkAddress(email)) return { status: 400, error: "invalid email" };
  return { status: 201, email };
}
