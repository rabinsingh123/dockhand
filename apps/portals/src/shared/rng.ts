// Seeded, deterministic randomness. Same seed + same salt = same sequence, on server and client.

export type Rng = () => number;

/** FNV-1a 32-bit string hash. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An independent stream per (seed, salt) so adding one decision never shifts the others. */
export function rngFor(seed: number, salt: string): Rng {
  return mulberry32(hash32(`${seed}|${salt}`));
}

export function randInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

export function pick<T>(items: readonly T[], rng: Rng): T {
  if (items.length === 0) throw new Error("pick() needs a non-empty list");
  return items[randInt(rng, items.length)] as T;
}

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function token(rng: Rng, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += ALPHABET.charAt(randInt(rng, ALPHABET.length));
  return s;
}
