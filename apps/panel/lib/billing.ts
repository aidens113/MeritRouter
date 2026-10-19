/** Billing classes and money formatting shared by server and client components. */
export const BILLING_CLASSES = ["free_tier", "paid_credits", "paid_postpaid", "trial"] as const;
export type BillingClass = (typeof BILLING_CLASSES)[number];

export const BILLING_LABEL: Record<string, string> = {
  free_tier: "Free tier",
  paid_credits: "Paid credits (prepaid)",
  paid_postpaid: "Billed to card",
  trial: "Trial credits",
};

/** USD with enough precision for sub-cent amounts. */
export function usd(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined) return "–";
  return `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? digits : 2)}`;
}
