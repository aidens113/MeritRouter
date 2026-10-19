export function applyDiscount(amount, discount) {
  return Math.round(amount * (1 - discount) * 100) / 100;
}
