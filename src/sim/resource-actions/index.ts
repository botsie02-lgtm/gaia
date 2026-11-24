import { getMaterial, validateQuantity } from '../materials/index.js';
import type { MaterialId } from '../materials/index.js';
import { PhysicalInventory } from '../inventory/index.js';
import type { InventoryOperation, LegacyMaterial, SampleId } from '../inventory/index.js';
import { createResourceConverter } from '../physics/index.js';
import type { ResourceCalibration } from '../physics/index.js';

export type OwnerKind = 'deposit' | 'agent' | 'hub' | 'structure';
export type ResourceOwnerId = `${OwnerKind}:${number}`;

/** Namespaces use stable world entity IDs, never coordinates or array indices. */
export function resourceOwnerId(kind: OwnerKind, entityId: number): ResourceOwnerId {
  if (kind !== 'deposit' && kind !== 'agent' && kind !== 'hub' && kind !== 'structure') {
    throw new TypeError('Invalid resource owner kind');
  }
  if (!Number.isSafeInteger(entityId) || entityId <= 0) throw new RangeError('Invalid entity ID');
  return `${kind}:${entityId}`;
}

function validateOwnerId(id: ResourceOwnerId): void {
  if (typeof id !== 'string') throw new TypeError('Invalid resource owner');
  const match = /^(deposit|agent|hub|structure):([1-9][0-9]*)$/.exec(id);
  if (!match || resourceOwnerId(match[1] as OwnerKind, Number(match[2])) !== id) {
    throw new RangeError('Invalid resource owner');
  }
}

/** Supplied by the privileged world controller, including currently empty owners.
 * The inventory does not own the world entity registry. */
function ownerSet(owners: readonly ResourceOwnerId[]): ReadonlySet<ResourceOwnerId> {
  if (!Array.isArray(owners)) throw new TypeError('Expected owner registry');
  const result = new Set<ResourceOwnerId>();
  for (const id of owners) {
    validateOwnerId(id);
    if (result.has(id)) throw new RangeError('Duplicate registered owner');
    result.add(id);
  }
  return result;
}

function requireOwner(owners: ReadonlySet<ResourceOwnerId>, id: ResourceOwnerId): void {
  validateOwnerId(id);
  if (!owners.has(id)) throw new RangeError('Unregistered resource owner');
}

function converterFor(calibrations: readonly ResourceCalibration[]) {
  const converter = createResourceConverter(calibrations);
  const materials = new Set<MaterialId>();
  for (const calibration of calibrations) {
    // Without this constraint a reverse projection could count the same mass twice.
    if (materials.has(calibration.materialId)) throw new RangeError('Ambiguous material calibration');
    materials.add(calibration.materialId);
  }
  return converter;
}

export interface LegacyResourceHolding extends LegacyMaterial {
  readonly ownerId: ResourceOwnerId;
}

/** Bootstrap only. The controller supplies null only before the world has a
 * physical registry; thereafter it must retain/restore that registry, not
 * reconstruct it from derived counts. No operation can seed a live store. */
export function migrateLegacyResources(
  existing: PhysicalInventory | null,
  owners: readonly ResourceOwnerId[],
  holdings: readonly LegacyResourceHolding[],
  calibrations: readonly ResourceCalibration[],
): PhysicalInventory {
  if (existing !== null) throw new RangeError('Physical inventory already initialized');
  const known = ownerSet(owners);
  const converter = converterFor(calibrations);
  if (!Array.isArray(holdings)) throw new TypeError('Expected legacy holdings');
  const seen = new Set<string>();
  const entries: LegacyResourceHolding[] = [];
  for (const holding of holdings) {
    requireOwner(known, holding.ownerId);
    const key = JSON.stringify([holding.ownerId, holding.resourceId]);
    if (seen.has(key)) throw new RangeError('Duplicate legacy holding');
    seen.add(key);
    // Validate even zero holdings, then omit them from positive sample storage.
    converter.toSample(holding.resourceId, holding.units, holding.temperatureC);
    if (holding.units > 0) entries.push({ ...holding });
  }
  // Canonical ordering independent of the input collection ordering.
  entries.sort((a, b) => compare(a.ownerId, b.ownerId) || compare(a.resourceId, b.resourceId));
  return PhysicalInventory.initializeLegacy(entries, calibrations);
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Fail rather than silently lose a positive operand or overflow a projection. */
function addMass(a: number, b: number): number {
  const sum = a + b;
  validateQuantity(sum);
  if (a > 0 && b > 0 && (sum === a || sum === b)) throw new RangeError('Mass sum below numerical resolution');
  return sum;
}

export interface ResourceQuantity {
  readonly materialId: MaterialId;
  readonly massKg: number;
}

export interface SampleMovement {
  readonly sourceSampleId: SampleId;
  readonly transferredSampleId: SampleId;
  readonly massKg: number;
}

export interface MaterialMovement extends ResourceQuantity {
  readonly samples: readonly SampleMovement[];
}

export interface ResourceTransferReceipt {
  readonly fromOwnerId: ResourceOwnerId;
  readonly toOwnerId: ResourceOwnerId;
  readonly revision: number;
  readonly materials: readonly MaterialMovement[];
  readonly createdSampleIds: readonly SampleId[];
}

/** Atomic transfer of one or more distinct materials between two owners.
 * The controller authorizes proximity, capacity, construction and entity life.
 * No merging, thermal exchange or phase conversion takes place. */
export function transferResources(
  inventory: PhysicalInventory,
  expectedRevision: number,
  owners: readonly ResourceOwnerId[],
  fromOwnerId: ResourceOwnerId,
  toOwnerId: ResourceOwnerId,
  quantities: readonly ResourceQuantity[],
): ResourceTransferReceipt {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      expectedRevision !== inventory.revision) throw new RangeError('Stale or invalid inventory revision');
  const known = ownerSet(owners);
  requireOwner(known, fromOwnerId);
  requireOwner(known, toOwnerId);
  if (fromOwnerId === toOwnerId) throw new RangeError('Cannot transfer to same owner');
  if (!Array.isArray(quantities) || quantities.length === 0) throw new TypeError('Expected resource quantities');

  const seen = new Set<MaterialId>();
  for (const quantity of quantities) {
    getMaterial(quantity.materialId);
    validateQuantity(quantity.massKg);
    if (quantity.massKg === 0 || seen.has(quantity.materialId)) throw new RangeError('Zero or duplicate transfer quantity');
    seen.add(quantity.materialId);
  }
  const ordered = [...quantities].sort((a, b) => compare(a.materialId, b.materialId));
  const available = inventory.forOwner(fromOwnerId); // already in ascending sample ID order
  let nextId = inventory.snapshot().nextSampleId;
  const operations: InventoryOperation[] = [];
  const materials: MaterialMovement[] = [];
  for (const quantity of ordered) {
    let remaining = quantity.massKg;
    let transferred = 0;
    const movements: SampleMovement[] = [];
    for (const sample of available) {
      if (remaining === 0) break;
      if (sample.materialId !== quantity.materialId) continue;
      const massKg = Math.min(remaining, sample.massKg);
      const rest = remaining - massKg;
      if (rest === remaining || Math.abs((remaining - rest) - massKg) / massKg > 1e-9) {
        throw new RangeError('Requested movement below numerical resolution');
      }
      let id = sample.sampleId;
      if (massKg < sample.massKg) {
        if (!Number.isSafeInteger(nextId + 1)) throw new RangeError('Sample IDs exhausted');
        id = nextId++;
        operations.push({ kind: 'split', sampleId: sample.sampleId, massKg });
      }
      operations.push({ kind: 'transfer', sampleId: id, fromOwnerId, toOwnerId });
      movements.push(Object.freeze({ sourceSampleId: sample.sampleId, transferredSampleId: id, massKg }));
      transferred = addMass(transferred, massKg);
      remaining = rest;
    }
    // No epsilon grant or silent top-up for an insufficient holding.
    if (remaining !== 0) throw new RangeError('Insufficient resource: ' + quantity.materialId);
    if (Math.abs(transferred - quantity.massKg) / quantity.massKg > 1e-9) {
      throw new RangeError('Transfer quantity exceeds numerical tolerance');
    }
    materials.push(Object.freeze({ materialId: quantity.materialId, massKg: transferred,
      samples: Object.freeze(movements) }));
  }
  // Preflight plans never mutate the registry. Any late split failure rolls
  // back all earlier staged operations, including ID allocations.
  const committed = inventory.transact(expectedRevision, operations);
  return Object.freeze({ fromOwnerId, toOwnerId, revision: committed.revision,
    materials: Object.freeze(materials), createdSampleIds: committed.createdIds });
}

/** Read-only mass projection; zero means no matching live samples. */
export function resourceMassKg(
  inventory: PhysicalInventory, owners: readonly ResourceOwnerId[],
  ownerId: ResourceOwnerId, materialId: MaterialId,
): number {
  requireOwner(ownerSet(owners), ownerId);
  getMaterial(materialId);
  return inventory.forOwner(ownerId).reduce((sum, sample) =>
    sample.materialId === materialId ? addMass(sum, sample.massKg) : sum, 0);
}

/** Fractional prototype units, derived on demand; never an independent stock. */
export function resourceUnits(
  inventory: PhysicalInventory, owners: readonly ResourceOwnerId[],
  ownerId: ResourceOwnerId, resourceId: string, calibrations: readonly ResourceCalibration[],
): number {
  const converter = converterFor(calibrations);
  const template = converter.toSample(resourceId, 0, 0);
  const massKg = resourceMassKg(inventory, owners, ownerId, template.materialId);
  return converter.toUnits(resourceId, { ...template, massKg });
}
