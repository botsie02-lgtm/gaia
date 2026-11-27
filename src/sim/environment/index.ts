/** Isolated, deterministic, budgeted contact processing for stationary stores. */
import type { World, Position } from '../model.js';
import { resourceOwnerId } from '../resource-actions/index.js';
import type { EventValue } from '../history/events.js';

export interface ThermalConfig {
  readonly tickDurationSeconds: number;
  readonly conductanceWPerK: number;
  readonly maxContactsPerTick: number;
  readonly eventThresholdJ: number;
}
export interface ThermalState {
  readonly config: ThermalConfig;
  /** Last considered edge's unique anchor sample ID, not an array index. */
  cursor: number;
}
export const DEFAULT_THERMAL_CONFIG: ThermalConfig = Object.freeze({
  tickDurationSeconds: 1, conductanceWPerK: 100, maxContactsPerTick: 8, eventThresholdJ: 1,
});

export function createThermalState(options: Partial<ThermalConfig> = {}): ThermalState {
  const config = Object.freeze({ ...DEFAULT_THERMAL_CONFIG, ...options });
  if (!Number.isFinite(config.tickDurationSeconds) || config.tickDurationSeconds <= 0 ||
      !Number.isFinite(config.conductanceWPerK) || config.conductanceWPerK < 0 ||
      !Number.isSafeInteger(config.maxContactsPerTick) || config.maxContactsPerTick < 1 ||
      config.maxContactsPerTick > 256 ||
      !Number.isFinite(config.eventThresholdJ) || config.eventThresholdJ < 0)
    throw new RangeError('Invalid thermal configuration');
  return { config, cursor: 0 };
}

interface Edge { a: number; b: number; ownerId: string; entityId: number }
function validPosition(world: World, p: Position): boolean {
  return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 &&
    p.x < world.width && p.y < world.height && world.terrain[p.y * world.width + p.x] !== 'water';
}

/** Each registered, stationary container is a separate, well-defined contact group.
 * Sorted IDs form a sparse ring (one edge for two samples). No cross-owner contact. */
export function thermalContacts(world: World): readonly Edge[] {
  const inventory = world.physicalInventory;
  if (!inventory || world.resourceMode !== 'physical') return [];
  const edges: Edge[] = [];
  const groups = [{ kind: 'hub' as const, entity: world.hub },
    ...world.structures.map(entity => ({ kind: 'structure' as const, entity }))];
  for (const {kind, entity} of groups) {
    if (!validPosition(world, entity)) continue;
    const ownerId = resourceOwnerId(kind, entity.id);
    const samples = inventory.forOwner(ownerId);
    const n = samples.length;
    if (n < 2) continue;
    const count = n === 2 ? 1 : n;
    for (let i = 0; i < count; i++) {
      edges.push({ a: samples[i]!.sampleId, b: samples[(i+1)%n]!.sampleId,
        ownerId, entityId: entity.id });
    }
  }
  return edges.sort((a,b) => a.a-b.a);
}

/** A contact consumes one slot even if equal-temperature, zero-G or rejected.
 * Each successful pair commits independently; subsequent edges see fresh temperatures. */
export function processThermalContacts(world: World): { considered: number; committed: number; rejected: number } {
  const state = world.thermal;
  const inventory = world.physicalInventory;
  const result = { considered: 0, committed: 0, rejected: 0 };
  if (!state || !inventory || world.resourceMode !== 'physical' || state.config.conductanceWPerK === 0) return result;
  const edges = thermalContacts(world);
  if (!edges.length) return result;
  const first = edges.findIndex(edge => edge.a > state.cursor);
  const start = first < 0 ? 0 : first;
  const count = Math.min(edges.length, state.config.maxContactsPerTick);
  const events: EventValue[] = [];
  for (let i = 0; i < count; i++) {
    const edge = edges[(start+i)%edges.length]!;
    state.cursor = edge.a;
    result.considered++;
    const a = inventory.get(edge.a), b = inventory.get(edge.b);
    if (!a || !b || a.ownerId !== edge.ownerId || b.ownerId !== edge.ownerId ||
        a.temperatureC === b.temperatureC) continue;
    let q: number;
    try {
      const receipt = inventory.transact(inventory.revision, [{
        kind: 'heat', a: edge.a, b: edge.b,
        contact: { conductanceWPerK: state.config.conductanceWPerK,
          tickDurationSeconds: state.config.tickDurationSeconds },
      }]);
      q = receipt.heat[0]!.transferredEnergyJ;
    } catch (error) {
      // Invalid or numerically unrepresentable exchanges leave the inventory untouched.
      if (!(error instanceof RangeError)) throw error;
      result.rejected++;
      continue;
    }
    result.committed++;
    const afterA = inventory.get(edge.a)!, afterB = inventory.get(edge.b)!;
    if (q !== 0 && Math.abs(q) >= state.config.eventThresholdJ &&
        (a.temperatureC !== afterA.temperatureC || b.temperatureC !== afterB.temperatureC)) {
      events.push({ ownerId: edge.ownerId, entityId: edge.entityId, a: edge.a, b: edge.b,
        beforeAC: a.temperatureC, beforeBC: b.temperatureC,
        afterAC: afterA.temperatureC, afterBC: afterB.temperatureC,
        transferredEnergyJ: q, revision: inventory.revision });
    }
  }
  // At most one event per tick; no event for failed or insignificant exchanges.
  if (events.length) world.history.append({ tick: world.tick, kind: 'thermal.contact',
    details: { contacts: events } });
  return result;
}
