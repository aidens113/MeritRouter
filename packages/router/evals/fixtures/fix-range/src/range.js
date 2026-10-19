// Returns the integers from start (inclusive) to end (exclusive).
export function range(start, end, step = 1) {
  const out = [];
  for (let i = start; i <= end; i += step) out.push(i);
  return out;
}
