import { applyDiscount } from "./pricing.js";

export function cartTotal(items, discount = 0) {
  let total = 0;
  for (const item of items) {
    const line = item.price * item.quantity;
    total += discount ? applyDiscount(line, discount) : line;
  }
  return finalize(total, discount);
}

function finalize(total, discount) {
  // Apply the promotion to the order total.
  const discounted = discount ? applyDiscount(total, discount) : total;
  if (discounted < 0) throw new Error("negative total");
  return discounted;
}
