const LOCAL = /^[a-z0-9._%+-]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// Decides whether an email address is acceptable for signup.
export function checkAddress(email) {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  return LOCAL.test(email.slice(0, at)) && DOMAIN.test(email.slice(at + 1));
}
