/** True when `s` reads the same forwards and backwards, ignoring case and non-alphanumerics. */
export function isPalindrome(s: string): boolean {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === [...cleaned].reverse().join("");
}
