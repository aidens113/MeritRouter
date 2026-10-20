import { permanentRedirect } from "next/navigation";

/** Paid keys and spend moved to Provider keys; paid policy and budgets live in Settings. */
export default function PaidPage() {
  permanentRedirect("/keys#paid");
}
