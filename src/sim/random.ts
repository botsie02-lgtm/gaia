import type { World } from './model.js';

/** Seeded PRNG: identical seed + actions => identical world state. */
export function random(world: World): number {
  let n = world.randomState >>> 0;
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  world.randomState = n >>> 0;
  return world.randomState / 4294967296;
}

export function initialRandomState(seed: number): number {
  return (seed >>> 0) || 0x9e3779b9;
}
