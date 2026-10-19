const UNITS = [
  ["h", 3600],
  ["m", 60],
  ["s", 1],
];

/** Format seconds as a compact duration, e.g. 5400 -> "1h30m". */
export function formatDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) throw new RangeError("seconds must be a non-negative integer");
  if (seconds === 0) return "0s";
  let rest = seconds;
  let out = "";
  for (const [unit, size] of UNITS) {
    const n = Math.floor(rest / size);
    if (n) out += `${n}${unit}`;
    rest -= n * size;
  }
  return out;
}
