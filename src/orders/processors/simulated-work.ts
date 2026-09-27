/** Uniform random duration in [minMs, maxMs]. */
export function simulatedWorkMs(
  minMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}
