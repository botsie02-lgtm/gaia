import type { MaterialId, MaterialPhase } from '../../materials/index.js';
import type { InventoryOperation, OwnerId, PersistentSample, PhysicalInventory, SampleId } from '../index.js';

/** Maximum combine operations, not a bound on owner discovery or exclusion validation. */
export const MAX_CONSOLIDATION_PAIRS = 256;

export interface ConsolidationRequest {
  readonly ownerId: OwnerId;
  readonly maxPairs: number;
  /** Mandatory caller-supplied union of live reserved, referenced or otherwise protected IDs.
   * Empty means the privileged caller certifies no such IDs need protection. */
  readonly excludedSampleIds: readonly SampleId[];
}

export interface ConsolidationLineage {
  readonly sourceIds: readonly [SampleId, SampleId];
  readonly sourceMassKg: readonly [number, number];
  readonly resultId: SampleId;
  readonly ownerId: OwnerId;
  readonly materialId: MaterialId;
  readonly phase: MaterialPhase;
  readonly temperatureC: number;
  readonly resultMassKg: number;
}

export interface ConsolidationReceipt {
  readonly ownerId: OwnerId;
  readonly previousRevision: number;
  readonly revision: number;
  readonly retiredIds: readonly SampleId[];
  readonly createdIds: readonly SampleId[];
  readonly lineage: readonly ConsolidationLineage[];
}

/**
 * Explicit controller-only compaction. Select disjoint pairs from the ascending
 * owner view, pairing each next eligible sample with the earliest unmatched
 * sample of the exact same material, phase and temperature. New results are not
 * eligible again until another explicit call. No automatic World integration.
 * All operations are validated by one existing inventory transaction, or none
 * are committed. The controller must authorize identity retirement and ensure
 * the supplied exclusion list covers all reservations and external references.
 */
export function consolidateSamples(
  inventory: PhysicalInventory, expectedRevision: number, request: ConsolidationRequest,
): ConsolidationReceipt {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      inventory.revision !== expectedRevision) throw new RangeError('Stale or invalid inventory revision');
  if (!request || typeof request !== 'object') throw new TypeError('Expected consolidation request');
  const { ownerId, maxPairs, excludedSampleIds } = request;
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('Invalid owner ID');
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 1 || maxPairs > MAX_CONSOLIDATION_PAIRS)
    throw new RangeError('Invalid consolidation budget');
  if (!Array.isArray(excludedSampleIds)) throw new TypeError('Expected explicit excluded sample IDs');
  const excluded = new Set<SampleId>();
  for (const id of excludedSampleIds) {
    if (!Number.isSafeInteger(id) || id <= 0 || !inventory.get(id) || excluded.has(id))
      throw new RangeError('Invalid, nonlive or duplicate excluded sample ID');
    excluded.add(id);
  }

  const unmatched = new Map<string, PersistentSample>();
  const operations: InventoryOperation[] = [];
  const lineage: ConsolidationLineage[] = [];
  let nextId = inventory.nextSampleId;
  for (const sample of inventory.forOwner(ownerId)) {
    if (excluded.has(sample.sampleId)) continue;
    // Stored temperatures are finite and zero is canonicalized by the inventory.
    // JSON tuple encoding is injective for these catalog strings and finite numbers.
    const key = JSON.stringify([sample.materialId, sample.phase, sample.temperatureC]);
    const first = unmatched.get(key);
    if (!first) {
      unmatched.set(key, sample);
      continue;
    }
    unmatched.delete(key);
    if (!Number.isSafeInteger(nextId + 1)) throw new RangeError('Sample IDs exhausted');
    operations.push({ kind: 'combine', a: first.sampleId, b: sample.sampleId });
    lineage.push(Object.freeze({
      sourceIds: Object.freeze([first.sampleId, sample.sampleId] as const),
      sourceMassKg: Object.freeze([first.massKg, sample.massKg] as const),
      resultId: nextId++, ownerId, materialId: sample.materialId, phase: sample.phase,
      temperatureC: sample.temperatureC, resultMassKg: first.massKg + sample.massKg,
    }));
    if (operations.length === maxPairs) break;
  }
  const frozenLineage = Object.freeze(lineage);
  if (inventory.revision !== expectedRevision) throw new RangeError('Stale inventory revision');
  if (operations.length === 0) {
    return Object.freeze({ ownerId, previousRevision: expectedRevision, revision: expectedRevision,
      retiredIds: Object.freeze([]), createdIds: Object.freeze([]), lineage: frozenLineage });
  }
  // The underlying transaction validates all numeric limits and exact pair
  // conservation before publication. Its combine allocates exactly one fresh
  // ID per operation, in the supplied order. No second numerical solver.
  const receipt = inventory.transact(expectedRevision, operations);
  return Object.freeze({ ownerId, previousRevision: expectedRevision, revision: receipt.revision,
    retiredIds: receipt.retiredIds, createdIds: receipt.createdIds, lineage: frozenLineage });
}
