import { combineSamples, validateQuantity, validateSample } from '../materials/index.js';
import type { MaterialSample } from '../materials/index.js';
import { createResourceConverter } from '../physics/index.js';
import type { ResourceCalibration } from '../physics/index.js';
import { sensibleEnergyJ, stepThermalContact } from '../thermal/index.js';
import type { ThermalContact } from '../thermal/index.js';

/** World-scoped monotonic ID. Owner IDs are caller-defined, namespaced strings. */
export type SampleId = number;
export type OwnerId = string;

export interface OwnedMaterial extends MaterialSample {
  readonly ownerId: OwnerId;
}
export interface PersistentSample extends OwnedMaterial {
  readonly sampleId: SampleId;
}
export interface LegacyMaterial {
  readonly ownerId: OwnerId;
  readonly resourceId: string;
  readonly units: number;
  readonly temperatureC: number;
}
export interface InventorySnapshot {
  readonly version: 1;
  readonly revision: number;
  readonly nextSampleId: SampleId;
  readonly samples: readonly PersistentSample[];
}
export type InventoryOperation =
  | { readonly kind: 'transfer'; readonly sampleId: SampleId; readonly fromOwnerId: OwnerId; readonly toOwnerId: OwnerId }
  | { readonly kind: 'split'; readonly sampleId: SampleId; readonly massKg: number }
  | { readonly kind: 'combine'; readonly a: SampleId; readonly b: SampleId }
  | { readonly kind: 'heat'; readonly a: SampleId; readonly b: SampleId; readonly contact: ThermalContact };

export interface HeatReceipt {
  readonly a: SampleId;
  readonly b: SampleId;
  readonly transferredEnergyJ: number;
}
export interface InventoryReceipt {
  readonly revision: number;
  readonly createdIds: readonly SampleId[];
  readonly retiredIds: readonly SampleId[];
  readonly heat: readonly HeatReceipt[];
}

function integer(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError('Invalid inventory integer');
}
function owner(value: OwnerId): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Invalid owner ID');
}
function record(sample: OwnedMaterial, sampleId: SampleId): PersistentSample {
  validateSample(sample);
  owner(sample.ownerId);
  integer(sampleId, 1);
  if (sample.massKg === 0) throw new RangeError('Persistent samples must have positive mass');
  sensibleEnergyJ(sample); // Reject unrepresentable modeled energy/capacity at entry.
  return Object.freeze({
    sampleId, ownerId: sample.ownerId, materialId: sample.materialId,
    massKg: sample.massKg, temperatureC: sample.temperatureC === 0 ? 0 : sample.temperatureC,
    phase: sample.phase,
  });
}
function conserved(before: number, after: number, name: string): void {
  validateQuantity(before);
  validateQuantity(after);
  const tolerance = Math.max(8 * Number.MIN_VALUE, 16 * Number.EPSILON * Math.max(before, after));
  if (Math.abs(before - after) > tolerance) throw new RangeError(name + ' not conserved');
}
function pairEnergy(a: MaterialSample, b: MaterialSample): number {
  const total = sensibleEnergyJ(a) + sensibleEnergyJ(b);
  validateQuantity(total);
  return total;
}
// In addition to pair conservation, reject severely distorted small mass
// movements even when the total's floating-point tolerance would hide them.
function resolvedMass(actual: number, requested: number): void {
  if (actual <= 0 || Math.abs(actual - requested) / requested > 1e-9) {
    throw new RangeError('Mass movement below numerical resolution');
  }
}

/**
 * One authoritative registry per simulation world. Owners are views of this
 * registry, not independent stockpiles. Mutation is only via a synchronous,
 * revision-checked, all-or-nothing transaction. No creation after bootstrap
 * except by splitting/combining existing material.
 */
export class PhysicalInventory {
  #samples = new Map<SampleId, PersistentSample>();
  // Derived membership only: the registry remains the sole physical authority.
  #ownerSamples = new Map<OwnerId, Set<SampleId>>();
  #nextSampleId = 1;
  #revision = 0;
  private constructor() {}

  /** Publish validated final records only, after the entire transaction stages.
   * Membership is changed only when an ID enters, leaves or changes owner. */
  #publish(id: SampleId, sample: PersistentSample | null): void {
    const previous = this.#samples.get(id);
    if (previous && previous.ownerId !== sample?.ownerId) {
      const ids = this.#ownerSamples.get(previous.ownerId)!;
      ids.delete(id);
      if (ids.size === 0) this.#ownerSamples.delete(previous.ownerId);
    }
    if (sample) {
      if (previous?.ownerId !== sample.ownerId) {
        let ids = this.#ownerSamples.get(sample.ownerId);
        if (!ids) {
          ids = new Set<SampleId>();
          this.#ownerSamples.set(sample.ownerId, ids);
        }
        ids.add(id);
      }
      this.#samples.set(id, sample);
    } else {
      this.#samples.delete(id);
    }
  }

  static initialize(samples: readonly OwnedMaterial[] = []): PhysicalInventory {
    if (!Array.isArray(samples)) throw new TypeError('Expected initial samples');
    const store = new PhysicalInventory();
    for (const sample of samples) {
      const id = store.#nextSampleId;
      integer(id + 1, 1);
      store.#publish(id, record(sample, id));
      store.#nextSampleId++;
    }
    return store;
  }

  /** One-time migration of explicitly calibrated, positive legacy quantities. */
  static initializeLegacy(
    entries: readonly LegacyMaterial[], calibrations: readonly ResourceCalibration[],
  ): PhysicalInventory {
    if (!Array.isArray(entries)) throw new TypeError('Expected legacy entries');
    const converter = createResourceConverter(calibrations);
    return PhysicalInventory.initialize(entries.map(entry => ({
      ...converter.toSample(entry.resourceId, entry.units, entry.temperatureC),
      ownerId: entry.ownerId,
    })));
  }

  static restore(snapshot: InventorySnapshot): PhysicalInventory {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.samples)) {
      throw new TypeError('Invalid inventory snapshot version or samples');
    }
    integer(snapshot.revision, 0);
    integer(snapshot.nextSampleId, 1);
    const store = new PhysicalInventory();
    for (const sample of snapshot.samples) {
      const copy = record(sample, sample.sampleId);
      if (copy.sampleId >= snapshot.nextSampleId || store.#samples.has(copy.sampleId)) {
        throw new RangeError('Duplicate or unallocated sample ID');
      }
      store.#publish(copy.sampleId, copy);
    }
    store.#revision = snapshot.revision;
    store.#nextSampleId = snapshot.nextSampleId;
    return store;
  }

  get revision(): number { return this.#revision; }
  /** Read-only allocation cursor for revision-checked transaction planning. */
  get nextSampleId(): SampleId { return this.#nextSampleId; }
  get(sampleId: SampleId): PersistentSample | undefined {
    integer(sampleId, 1);
    return this.#samples.get(sampleId);
  }
  forOwner(ownerId: OwnerId): readonly PersistentSample[] {
    owner(ownerId);
    const ids = this.#ownerSamples.get(ownerId);
    return Object.freeze(ids ? [...ids].sort((a, b) => a - b)
      .map(id => this.#samples.get(id)!) : []);
  }
  snapshot(): InventorySnapshot {
    return Object.freeze({
      version: 1, revision: this.#revision, nextSampleId: this.#nextSampleId,
      samples: Object.freeze([...this.#samples.values()].sort((a, b) => a.sampleId - b.sampleId)),
    });
  }

  /** Execute operations in supplied order. Only touched IDs are staged; failure
   * changes neither records, revision nor allocation cursor. A successful call
   * advances revision once, even for a valid no-op heat contact. */
  transact(expectedRevision: number, operations: readonly InventoryOperation[]): InventoryReceipt {
    integer(expectedRevision, 0);
    if (expectedRevision !== this.#revision) throw new RangeError('Stale inventory revision');
    integer(this.#revision + 1, 0);
    if (!Array.isArray(operations) || operations.length === 0) throw new TypeError('Expected operations');

    const staged = new Map<SampleId, PersistentSample | null>();
    const createdIds: SampleId[] = [];
    const retiredIds: SampleId[] = [];
    const heat: HeatReceipt[] = [];
    let nextId = this.#nextSampleId;
    const read = (id: SampleId): PersistentSample => {
      integer(id, 1);
      const sample = staged.has(id) ? staged.get(id) : this.#samples.get(id);
      if (!sample) throw new RangeError('Unknown or retired sample ID: ' + id);
      return sample;
    };
    const create = (sample: OwnedMaterial): void => {
      integer(nextId + 1, 1);
      staged.set(nextId, record(sample, nextId));
      createdIds.push(nextId++);
    };
    const retire = (id: SampleId): void => {
      staged.set(id, null);
      retiredIds.push(id);
    };
    for (const op of operations as readonly InventoryOperation[]) {
      if (!op || typeof op !== 'object') throw new TypeError('Invalid inventory operation');
      switch (op.kind) {
        case 'transfer': {
          const sample = read(op.sampleId);
          owner(op.fromOwnerId);
          owner(op.toOwnerId);
          if (sample.ownerId !== op.fromOwnerId || op.fromOwnerId === op.toOwnerId) {
            throw new RangeError('Invalid transfer ownership');
          }
          staged.set(sample.sampleId, record({ ...sample, ownerId: op.toOwnerId }, sample.sampleId));
          break;
        }
        case 'split': {
          const sample = read(op.sampleId);
          validateQuantity(op.massKg);
          if (op.massKg === 0 || op.massKg >= sample.massKg) throw new RangeError('Invalid split mass');
          const remainder = sample.massKg - op.massKg;
          if (remainder <= 0 || remainder === sample.massKg) throw new RangeError('Unrepresentable split');
          resolvedMass(sample.massKg - remainder, op.massKg);
          resolvedMass(sample.massKg - op.massKg, remainder);
          const left = record({ ...sample, massKg: remainder }, sample.sampleId);
          const right = { ...sample, massKg: op.massKg };
          conserved(sample.massKg, left.massKg + right.massKg, 'Mass');
          conserved(sensibleEnergyJ(sample), pairEnergy(left, right), 'Sensible energy');
          staged.set(left.sampleId, left);
          create(right);
          break;
        }
        case 'combine': {
          if (op.a === op.b) throw new RangeError('Cannot combine a sample with itself');
          const a = read(op.a), b = read(op.b);
          if (a.ownerId !== b.ownerId) throw new RangeError('Transfer to a common owner before combining');
          const merged = combineSamples(a, b);
          resolvedMass(merged.massKg - Math.max(a.massKg, b.massKg), Math.min(a.massKg, b.massKg));
          conserved(a.massKg + b.massKg, merged.massKg, 'Mass');
          conserved(pairEnergy(a, b), sensibleEnergyJ(merged), 'Sensible energy');
          retire(a.sampleId);
          retire(b.sampleId);
          create({ ...merged, ownerId: a.ownerId });
          break;
        }
        case 'heat': {
          if (op.a === op.b) throw new RangeError('Cannot heat a sample with itself');
          const a = read(op.a), b = read(op.b);
          const result = stepThermalContact(a, b, op.contact);
          // Retain identity, ownership, mass, material and phase.
          const left = record({ ...a, temperatureC: result.a.temperatureC }, a.sampleId);
          const right = record({ ...b, temperatureC: result.b.temperatureC }, b.sampleId);
          conserved(pairEnergy(a, b), pairEnergy(left, right), 'Sensible energy');
          staged.set(a.sampleId, left);
          staged.set(b.sampleId, right);
          heat.push(Object.freeze({ a: a.sampleId, b: b.sampleId, transferredEnergyJ: result.transferredEnergyJ }));
          break;
        }
        default: throw new TypeError('Unsupported inventory operation');
      }
    }
    // Prepare receipt before publication; no user callbacks during commit.
    const receipt = Object.freeze({
      revision: expectedRevision + 1,
      createdIds: Object.freeze(createdIds),
      retiredIds: Object.freeze(retiredIds),
      heat: Object.freeze(heat),
    });
    if (this.#revision !== expectedRevision) throw new RangeError('Stale inventory revision');
    for (const [id, sample] of staged) {
      this.#publish(id, sample);
    }
    this.#nextSampleId = nextId;
    this.#revision = receipt.revision;
    return receipt;
  }
}
