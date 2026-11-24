import type { Agent, Deposit, Hearth, Position, Terrain, World } from '../model.js';

/** Only the fields this privileged projection needs; no history, RNG or inventories. */
export interface PerceptionWorld {
  readonly tick: number;
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly Terrain[];
  readonly agents: readonly Readonly<Pick<Agent, 'id' | 'kind' | 'faction' | 'x' | 'y'>>[];
  readonly deposits: readonly Readonly<Pick<Deposit, 'id' | 'kind' | 'material' | 'amount' | 'x' | 'y'>>[];
  readonly structures: readonly Readonly<Pick<Hearth, 'id' | 'kind' | 'structure' | 'x' | 'y'>>[];
  readonly hub: Readonly<World['hub']>;
}

export interface PerceptionOptions {
  /** Inclusive Manhattan distance in tiles. Default: 6. */
  readonly range?: number;
  /** Terrain that blocks sight beyond its tile. Default: none. */
  readonly opaqueTerrain?: readonly Terrain[];
}

export const DEFAULT_PERCEPTION_RANGE = 6;
export type ObservedAgent = PerceptionWorld['agents'][number];
export type ObservedDeposit = PerceptionWorld['deposits'][number];
export type ObservedStructure = PerceptionWorld['structures'][number];
export type ObservedTile = Readonly<Position & { terrain: Terrain }>;
export type ObservedHub = Readonly<World['hub'] & { kind: 'hub' }>;

export interface Observation {
  readonly tick: number;
  readonly observer: ObservedAgent;
  readonly range: number;
  readonly terrain: readonly ObservedTile[];
  /** Other visible agents only. Faction is a label, not a relationship policy. */
  readonly agents: readonly ObservedAgent[];
  readonly deposits: readonly ObservedDeposit[];
  readonly structures: readonly ObservedStructure[];
  readonly hub: ObservedHub | null;
}

function validPosition(world: PerceptionWorld, p: Readonly<Position>): boolean {
  return Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y) &&
    p.x >= 0 && p.y >= 0 && p.x < world.width && p.y < world.height;
}

function terrainAt(world: PerceptionWorld, x: number, y: number): Terrain {
  const value = world.terrain[y * world.width + x];
  if (value !== 'grass' && value !== 'dirt' && value !== 'water') {
    throw new RangeError('Invalid terrain at visible tile');
  }
  return value;
}

/**
 * Center-to-center grid traversal. At a corner crossing, either side cell
 * blocks sight (conservative supercover). The source and target are exempt.
 */
function unobstructed(world: PerceptionWorld, from: Readonly<Position>,
  to: Readonly<Position>, opaque: ReadonlySet<Terrain>): boolean {
  if (opaque.size === 0) return true;
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = Math.abs(to.y - y);
  const sx = Math.sign(to.x - x);
  const sy = Math.sign(to.y - y);
  let ix = 0;
  let iy = 0;
  const blocked = (px: number, py: number): boolean =>
    !(px === to.x && py === to.y) && opaque.has(terrainAt(world, px, py));

  while (ix < dx || iy < dy) {
    // Exact integer comparison of the next vertical/horizontal boundary.
    const vertical = (2 * ix + 1) * dy;
    const horizontal = (2 * iy + 1) * dx;
    if (vertical === horizontal) {
      if (blocked(x + sx, y) || blocked(x, y + sy)) return false;
      x += sx;
      y += sy;
      ix++;
      iy++;
    } else if (vertical < horizontal) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    if (blocked(x, y)) return false;
  }
  return true;
}

function agentView(a: ObservedAgent): ObservedAgent {
  return Object.freeze({ id: a.id, kind: a.kind, faction: a.faction, x: a.x, y: a.y });
}

function byId(a: { readonly id: number }, b: { readonly id: number }): number {
  return a.id - b.id;
}

/**
 * Privileged, synchronous world-to-local projection. Pass only the result to
 * future agent policies; the world argument is not an agent capability.
 * Assumes the world maintains its normal unique IDs and valid entity records.
 */
export function observeAgent(world: PerceptionWorld, observerId: number,
  options: PerceptionOptions = {}): Observation {
  const range = options.range ?? DEFAULT_PERCEPTION_RANGE;
  if (!Number.isSafeInteger(range) || range < 0) {
    throw new RangeError('Perception range must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(observerId) || observerId <= 0) {
    throw new RangeError('Invalid observer ID');
  }
  if (!Number.isSafeInteger(world.tick) || world.tick < 0 ||
      !Number.isSafeInteger(world.width) || world.width <= 0 ||
      !Number.isSafeInteger(world.height) || world.height <= 0 ||
      world.terrain.length !== world.width * world.height) {
    throw new RangeError('Invalid perception world dimensions or tick');
  }
  const opaque = new Set<Terrain>(options.opaqueTerrain ?? []);
  for (const tile of opaque) {
    if (tile !== 'grass' && tile !== 'dirt' && tile !== 'water') {
      throw new RangeError('Unknown opaque terrain');
    }
  }
  const source = world.agents.find(a => a.id === observerId);
  if (!source || !validPosition(world, source)) {
    throw new RangeError('Observer not present at a valid world position');
  }

  const tiles: ObservedTile[] = [];
  const visible = new Set<number>();
  // Clip the search to world bounds; huge valid ranges cannot expand the grid.
  for (let y = Math.max(0, source.y - range); y <= Math.min(world.height - 1, source.y + range); y++) {
    const horizontal = range - Math.abs(y - source.y);
    for (let x = Math.max(0, source.x - horizontal); x <= Math.min(world.width - 1, source.x + horizontal); x++) {
      if (!unobstructed(world, source, { x, y }, opaque)) continue;
      tiles.push(Object.freeze({ x, y, terrain: terrainAt(world, x, y) }));
      visible.add(y * world.width + x);
    }
  }
  const seen = (p: Readonly<Position>): boolean =>
    validPosition(world, p) && visible.has(p.y * world.width + p.x);

  const agents = world.agents.filter(a => a.id !== observerId && seen(a))
    .map(agentView).sort(byId);
  const deposits = world.deposits.filter(d => seen(d)).map(d =>
    Object.freeze({ id: d.id, kind: d.kind, material: d.material, amount: d.amount, x: d.x, y: d.y }))
    .sort(byId);
  const structures = world.structures.filter(s => seen(s)).map(s =>
    Object.freeze({ id: s.id, kind: s.kind, structure: s.structure, x: s.x, y: s.y }))
    .sort(byId);
  const hub: ObservedHub | null = seen(world.hub) ? Object.freeze({
    id: world.hub.id, kind: 'hub', x: world.hub.x, y: world.hub.y,
  }) : null;

  return Object.freeze({
    tick: world.tick, observer: agentView(source), range,
    terrain: Object.freeze(tiles), agents: Object.freeze(agents),
    deposits: Object.freeze(deposits), structures: Object.freeze(structures), hub,
  });
}
