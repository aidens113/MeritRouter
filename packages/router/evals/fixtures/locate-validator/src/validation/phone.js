export function checkPhone(phone) {
  return /^\+?[0-9 ]{7,15}$/.test(phone);
}
