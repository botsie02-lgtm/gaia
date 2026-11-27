import { PhysicalInventory } from '../../inventory/index.js';
import type { InventoryOperation, SampleId } from '../../inventory/index.js';
import { resourceOwnerId } from '../../resource-actions/index.js';
import type { OwnerKind, ResourceOwnerId } from '../../resource-actions/index.js';
import { advanceBiology, applyConsumptionOutcome, restoreBiologicalState } from '../index.js';
import type { ActivityOutcome, BiologicalState, BiologyConfig } from '../index.js';

/** Exact binary mass grid, matching the current physical World's calibration.
 * All public masses are kg, never prototype units or physiological scores. */
export const CONSUMPTION_MASS_QUANTUM_KG = 1 / 1024;
export type BodyWaterOwnerId = `body-water:${number}`;

export interface DrinkingConfig {
  readonly capacityKg: number;
  /** Abstract normalized thirst score reduction per kg of liquid water. */
  readonly thirstReliefPerKg: number;
}
export interface BodyRegistration {
  readonly agentId: number;
  readonly config: DrinkingConfig;
  readonly physiology: BiologicalState;
}
export interface BodyConsumptionState extends BodyRegistration {
  readonly reservoirOwnerId: BodyWaterOwnerId;
  /** Last committed drinking sequence; zero before the first drink. */
  readonly lastSequence: number;
}
export interface ConsumptionSnapshot {
  readonly version: 1;
  readonly inventoryRevision: number;
  readonly sourceOwners: readonly ResourceOwnerId[];
  readonly bodies: readonly BodyConsumptionState[];
}
interface ConsumptionRequest {
  readonly agentId: number;
  readonly sourceOwnerId: ResourceOwnerId;
  readonly expectedInventoryRevision: number;
  /** Exactly lastSequence + 1; retry a failed request with the same sequence. */
  readonly sequence: number;
  readonly massKg: number;
}
export interface DrinkingRequest extends ConsumptionRequest {
  readonly kind: 'drink';
  readonly materialId: 'water';
  readonly phase: 'liquid';
}
/** Future interface only. A validated species-specific food profile and
 * digestion/physical transaction implementation are prerequisites.
 * No currently catalogued material is accepted as food by this module. */
export interface FeedingRequest extends ConsumptionRequest {
  readonly kind: 'feed';
  readonly foodProfileId: string;
}
export interface DrinkingMovement {
  readonly sourceSampleId: SampleId;
  readonly transferredSampleId: SampleId;
  readonly massKg: number;
}
export interface DrinkingReceipt {
  readonly version: 1;
  readonly kind: 'drink';
  readonly status: 'succeeded';
  readonly agentId: number;
  readonly sequence: number;
  readonly inventoryRevision: number;
  readonly sourceOwnerId: ResourceOwnerId;
  readonly reservoirOwnerId: BodyWaterOwnerId;
  readonly materialId: 'water';
  readonly phase: 'liquid';
  readonly massKg: number;
  readonly reservoirMassKgAfter: number;
  /** Mapped relief, capped at one, before clamping to the individual's thirst. */
  readonly mappedRelief: number;
  /** Actual normalized thirst reduction, not a physical quantity. */
  readonly thirstRelief: number;
  readonly movements: readonly DrinkingMovement[];
  readonly physiology: BiologicalState;
}

function object(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid ' + label);
  }
}
function integer(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError('Invalid ' + label);
}
function units(massKg: number, allowZero: boolean): number {
  if (typeof massKg !== 'number' || !Number.isFinite(massKg) || massKg < 0 ||
      (!allowZero && massKg === 0)) throw new RangeError('Invalid consumption mass in kg');
  const count = massKg * 1024;
  if (!Number.isSafeInteger(count)) throw new RangeError('Mass outside exact consumption grid');
  return count === 0 ? 0 : count;
}
const kg = (count: number): number => count / 1024;

export function bodyWaterOwnerId(agentId: number): BodyWaterOwnerId {
  integer(agentId, 1, 'agent ID');
  return `body-water:${agentId}`;
}
function validateSourceOwner(id: ResourceOwnerId): void {
  if (typeof id !== 'string') throw new TypeError('Invalid source owner');
  const match = /^(deposit|agent|hub|structure):([1-9][0-9]*)$/.exec(id);
  if (!match || resourceOwnerId(match[1] as OwnerKind, Number(match[2])) !== id) {
    throw new RangeError('Invalid source owner');
  }
}
function copyConfig(config: DrinkingConfig): DrinkingConfig {
  object(config, 'drinking configuration');
  const capacityKg = kg(units(config.capacityKg, true));
  const rate = config.thirstReliefPerKg;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
    throw new RangeError('Invalid thirst relief per kg');
  }
  // Ensure any admissible drink within this body's capacity maps to finite relief.
  if (!Number.isFinite(capacityKg * rate)) throw new RangeError('Relief mapping overflows');
  return Object.freeze({ capacityKg, thirstReliefPerKg: rate === 0 ? 0 : rate });
}
function copyBody(body: BodyRegistration, sequence: number): BodyConsumptionState {
  object(body, 'body registration');
  const agentId = body.agentId;
  const reservoirOwnerId = bodyWaterOwnerId(agentId);
  integer(sequence, 0, 'consumption sequence');
  return Object.freeze({ agentId, reservoirOwnerId, config: copyConfig(body.config),
    physiology: restoreBiologicalState(body.physiology), lastSequence: sequence });
}

// One live consumption authority per inventory object. Weak keys do not retain
// abandoned worlds. This is a lifecycle guard, not a security or save signature.
const authorities = new WeakSet<PhysicalInventory>();

/** Privileged, independent controller. Inventory remains the sole mass store;
 * this controller owns physiological states and their replay cursors.
 * Do not also maintain a writable copy of those states elsewhere. */
export class PhysicalConsumption {
  readonly #inventory: PhysicalInventory;
  readonly #sources: Set<ResourceOwnerId>;
  readonly #bodies = new Map<number, BodyConsumptionState>();

  private constructor(inventory: PhysicalInventory, sourceOwners: readonly ResourceOwnerId[],
    bodies: readonly BodyConsumptionState[]) {
    if (!(inventory instanceof PhysicalInventory)) throw new TypeError('Expected physical inventory');
    if (authorities.has(inventory)) throw new RangeError('Consumption authority already exists');
    if (!Array.isArray(sourceOwners) || !Array.isArray(bodies)) throw new TypeError('Invalid owner registry');
    this.#inventory = inventory;
    this.#sources = new Set();
    for (const source of sourceOwners) {
      validateSourceOwner(source);
      if (this.#sources.has(source)) throw new RangeError('Duplicate source owner');
      this.#sources.add(source);
    }
    for (const body of bodies) {
      if (this.#bodies.has(body.agentId)) throw new RangeError('Duplicate body registration');
      this.#reservoirUnits(body);
      this.#bodies.set(body.agentId, body);
    }
    authorities.add(inventory);
  }

  /** Trusted bootstrap only; no samples are created, including body water. */
  static initialize(inventory: PhysicalInventory, sourceOwners: readonly ResourceOwnerId[],
    registrations: readonly BodyRegistration[]): PhysicalConsumption {
    if (!Array.isArray(registrations)) throw new TypeError('Expected body registrations');
    return new PhysicalConsumption(inventory, sourceOwners, registrations.map(body => copyBody(body, 0)));
  }

  /** Restore alongside the matching trusted inventory snapshot, not by
   * reinitializing replay cursors. No receipt can be applied separately. */
  static restore(inventory: PhysicalInventory, snapshot: ConsumptionSnapshot): PhysicalConsumption {
    object(snapshot, 'consumption snapshot');
    if (!(inventory instanceof PhysicalInventory)) throw new TypeError('Expected physical inventory');
    if (snapshot.version !== 1 || snapshot.inventoryRevision !== inventory.revision ||
        !Array.isArray(snapshot.bodies)) throw new RangeError('Incompatible consumption snapshot');
    const bodies = snapshot.bodies.map(body => {
      object(body, 'body snapshot');
      const copy = copyBody(body, body.lastSequence);
      if (copy.reservoirOwnerId !== body.reservoirOwnerId ||
          copy.lastSequence > inventory.revision) throw new RangeError('Invalid body snapshot cursor or owner');
      return copy;
    });
    // Every committed drink consumes one distinct inventory revision.
    let remainingRevisions = inventory.revision;
    for (const body of bodies) {
      if (body.lastSequence > remainingRevisions) throw new RangeError('Impossible total consumption sequences');
      remainingRevisions -= body.lastSequence;
    }
    return new PhysicalConsumption(inventory, snapshot.sourceOwners, bodies);
  }

  getBody(agentId: number): BodyConsumptionState {
    integer(agentId, 1, 'agent ID');
    const body = this.#bodies.get(agentId);
    if (!body) throw new RangeError('Unregistered body');
    return body;
  }

  #reservoirUnits(body: BodyConsumptionState): number {
    let remaining = units(body.config.capacityKg, true);
    const capacity = remaining;
    for (const sample of this.#inventory.forOwner(body.reservoirOwnerId)) {
      if (sample.materialId !== 'water' || sample.phase !== 'liquid') {
        throw new RangeError('Body water reservoir contains incompatible material');
      }
      const count = units(sample.massKg, false);
      if (count > remaining) throw new RangeError('Body water reservoir exceeds capacity');
      remaining -= count;
    }
    return capacity - remaining;
  }

  reservoirMassKg(agentId: number): number {
    return kg(this.#reservoirUnits(this.getBody(agentId)));
  }

  snapshot(): ConsumptionSnapshot {
    const bodies = [...this.#bodies.values()].sort((a, b) => a.agentId - b.agentId);
    for (const body of bodies) this.#reservoirUnits(body);
    return Object.freeze({ version: 1, inventoryRevision: this.#inventory.revision,
      sourceOwners: Object.freeze([...this.#sources].sort()), bodies: Object.freeze(bodies) });
  }

  /** Optional pure-biological time progression, retaining the consumption
   * cursor. Caller owns logical interval ordering, as in advanceBiology. */
  advanceIndividual(agentId: number, durationSeconds: number, activity: ActivityOutcome,
    config?: BiologyConfig): BodyConsumptionState {
    const body = this.getBody(agentId);
    const next = Object.freeze({ ...body,
      physiology: advanceBiology(body.physiology, durationSeconds, activity, config) });
    this.#bodies.set(agentId, next);
    return next;
  }

  /** Execute, do not merely intend, a drink. Full requested mass or no change.
   * Source authorization (reach, potable supply, permissions) is the caller's
   * responsibility. Registered reservoir owners are never eligible sources.
   * All validation and successor construction precede the single transaction.
   * Only after it commits is the physiological successor/cursor published. */
  drink(request: DrinkingRequest): DrinkingReceipt {
    object(request, 'drinking request');
    const { kind, materialId, phase, agentId, sourceOwnerId,
      expectedInventoryRevision, sequence, massKg } = request;
    if (kind !== 'drink' || materialId !== 'water' || phase !== 'liquid') {
      throw new RangeError('Only liquid water drinking is supported');
    }
    const body = this.getBody(agentId);
    integer(sequence, 1, 'consumption sequence');
    if (sequence !== body.lastSequence + 1) throw new RangeError('Duplicate or out-of-order consumption sequence');
    integer(expectedInventoryRevision, 0, 'inventory revision');
    if (expectedInventoryRevision !== this.#inventory.revision) throw new RangeError('Stale inventory revision');
    integer(expectedInventoryRevision + 1, 1, 'next inventory revision');
    validateSourceOwner(sourceOwnerId);
    if (!this.#sources.has(sourceOwnerId)) throw new RangeError('Unregistered source owner');
    const requested = units(massKg, false);
    const before = this.#reservoirUnits(body);
    if (requested > units(body.config.capacityKg, true) - before) {
      throw new RangeError('Insufficient body reservoir capacity');
    }

    // The owner view is already sorted by stable sample ID. At most one split
    // is necessary. Non-water samples are never selected, even at the same owner.
    let remaining = requested;
    const operations: InventoryOperation[] = [];
    const movements: DrinkingMovement[] = [];
    for (const sample of this.#inventory.forOwner(sourceOwnerId)) {
      if (remaining === 0) break;
      if (sample.materialId !== 'water' || sample.phase !== 'liquid') continue;
      const available = units(sample.massKg, false);
      const take = Math.min(available, remaining);
      let id = sample.sampleId;
      if (take < available) {
        id = this.#inventory.nextSampleId;
        operations.push({ kind: 'split', sampleId: sample.sampleId, massKg: kg(take) });
      }
      operations.push({ kind: 'transfer', sampleId: id, fromOwnerId: sourceOwnerId,
        toOwnerId: body.reservoirOwnerId });
      movements.push(Object.freeze({ sourceSampleId: sample.sampleId,
        transferredSampleId: id, massKg: kg(take) }));
      remaining -= take;
    }
    if (remaining !== 0) throw new RangeError('Insufficient liquid water');

    const rawRelief = kg(requested) * body.config.thirstReliefPerKg;
    if (!Number.isFinite(rawRelief) ||
        (rawRelief === 0 && body.config.thirstReliefPerKg > 0)) {
      throw new RangeError('Unrepresentable thirst relief');
    }
    const mappedRelief = Math.min(1, rawRelief);
    // Pure preflight: this candidate has no effect unless the physical commit succeeds.
    const physiology = applyConsumptionOutcome(body.physiology, {
      kind: 'drink', status: 'succeeded', relief: mappedRelief,
    });
    const next = Object.freeze({ ...body, physiology, lastSequence: sequence });
    const receipt: DrinkingReceipt = Object.freeze({
      version: 1, kind: 'drink', status: 'succeeded', agentId, sequence,
      inventoryRevision: expectedInventoryRevision + 1, sourceOwnerId,
      reservoirOwnerId: body.reservoirOwnerId, materialId: 'water', phase: 'liquid',
      massKg: kg(requested), reservoirMassKgAfter: kg(before + requested),
      mappedRelief, thirstRelief: body.physiology.thirst - physiology.thirst,
      movements: Object.freeze(movements), physiology,
    });

    // A failed split/transfer publishes neither records nor physiological state.
    // No callbacks, user code or further validation between commit/publication.
    this.#inventory.transact(expectedInventoryRevision, operations);
    this.#bodies.set(agentId, next);
    return receipt;
  }
}
