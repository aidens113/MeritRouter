import { cartTotal } from "./cart.js";

export function checkout(cart) {
  const total = cartTotal(cart.items, cart.discount);
  return { charged: total, currency: "USD" };
}
