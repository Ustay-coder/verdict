/** Returns a prefixed opaque identifier; injected clock and entropy allow deterministic callers. */
export function newId(prefix: string, now = Date.now(), random = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32) {
  return `${prefix}_${now.toString(36)}${random.toString(36).slice(2, 10)}`;
}
