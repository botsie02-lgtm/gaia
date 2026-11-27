/** Privileged World adapter: physical samples are authoritative, never policy inputs. */
import type { Inventory, Material, World, Hearth } from './model.js';
import type { ResourceCalibration } from './physics/index.js';
import type { EventDetails } from './history/events.js';
import {
  migrateLegacyResources, resourceOwnerId, resourceUnits, transferResources,
} from './resource-actions/index.js';
import type {
  LegacyResourceHolding, ResourceOwnerId, ResourceTransferReceipt,
} from './resource-actions/index.js';

export type ResourceMode = 'legacy' | 'physical';
export interface PhysicalResourceConfig {
  readonly calibration: readonly ResourceCalibration[];
  readonly initialTemperatureC: Readonly<Inventory>;
}
export const MATERIALS = ['wood', 'stone'] as const;
export const DEFAULT_KG_PER_UNIT: Readonly<Inventory> = Object.freeze({ wood: 2, stone: 3 });
export const DEFAULT_INITIAL_TEMPERATURE_C: Readonly<Inventory> = Object.freeze({ wood: 20, stone: 15 });

/** Scenario masses use bounded binary fractions so integer gameplay units
 * remain exact even after repeated splitting and aggregation. */
export function physicalConfig(kgPerUnit: Readonly<Inventory> = DEFAULT_KG_PER_UNIT,
  initialTemperatureC: Readonly<Inventory> = DEFAULT_INITIAL_TEMPERATURE_C): PhysicalResourceConfig {
  const calibration = MATERIALS.map(materialId => {
    const kg = kgPerUnit[materialId];
    if (!Number.isFinite(kg) || kg <= 0 || kg > 1024 || !Number.isSafeInteger(kg * 1024)) {
      throw new RangeError('Calibration must be a positive multiple of 1/1024 kg, at most 1024 kg');
    }
    const temperature = initialTemperatureC[materialId];
    if (!Number.isFinite(temperature) || temperature < -273.15) throw new RangeError('Invalid starting temperature');
    return Object.freeze({ resourceId: materialId, materialId, kgPerUnit: kg });
  });
  return Object.freeze({ calibration: Object.freeze(calibration),
    initialTemperatureC: Object.freeze({ wood: initialTemperatureC.wood, stone: initialTemperatureC.stone }) });
}

function owners(world: World): ResourceOwnerId[] {
  return [
    resourceOwnerId('hub', world.hub.id),
    ...world.deposits.map(d => resourceOwnerId('deposit', d.id)),
    ...world.agents.map(a => resourceOwnerId('agent', a.id)),
    ...world.structures.map(s => resourceOwnerId('structure', s.id)),
  ];
}

/** A projection is not authorization. A retained reference to a depleted
 * deposit still reads zero after the entity is removed. */
function units(world: World, owner: ResourceOwnerId, material: Material): number {
  return resourceUnits(world.physicalInventory!, [owner], owner, material, world.physicalConfig!.calibration);
}
function view(world: World, owner: ResourceOwnerId): Inventory {
  return Object.freeze({
    get wood() { return units(world, owner, 'wood'); },
    get stone() { return units(world, owner, 'stone'); },
  });
}
function getter(object: object, name: string, get: () => unknown): void {
  Object.defineProperty(object, name, { get, enumerable: true, configurable: false });
}
function fixed(object: object, name: string, value: unknown): void {
  Object.defineProperty(object, name, { value, enumerable: true, configurable: false, writable: false });
}
export function bindHearth(world: World, hearth: Hearth): void {
  const owner = resourceOwnerId('structure', hearth.id);
  getter(hearth, 'fuel', () => units(world, owner, 'wood'));
  getter(hearth, 'stoneUsed', () => units(world, owner, 'stone'));
  fixed(hearth, 'heat', 0);
}

/** Called exactly once, after all initial stable IDs have been allocated.
 * Initial legacy values are discarded, not synchronized. */
export function initializePhysicalWorld(world: World): void {
  if (world.resourceMode !== 'physical' || world.physicalInventory !== null || !world.physicalConfig) {
    throw new RangeError('Not an uninitialized physical world');
  }
  const holdings: LegacyResourceHolding[] = [];
  const add = (ownerId: ResourceOwnerId, resourceId: Material, amount: number) => {
    holdings.push({ ownerId, resourceId, units: amount,
      temperatureC: world.physicalConfig!.initialTemperatureC[resourceId] });
  };
  for (const d of world.deposits) add(resourceOwnerId('deposit', d.id), d.material, d.amount);
  for (const a of world.agents) for (const m of MATERIALS) add(resourceOwnerId('agent', a.id), m, a.cargo[m]);
  for (const m of MATERIALS) add(resourceOwnerId('hub', world.hub.id), m, world.inventory[m]);
  for (const h of world.structures) {
    add(resourceOwnerId('structure', h.id), 'wood', h.fuel);
    add(resourceOwnerId('structure', h.id), 'stone', h.stoneUsed);
  }
  const inventory = migrateLegacyResources(null, owners(world), holdings, world.physicalConfig.calibration);
  fixed(world, 'physicalInventory', inventory);
  fixed(world, 'physicalConfig', world.physicalConfig);
  fixed(world, 'resourceMode', world.resourceMode);
  fixed(world, 'inventory', view(world, resourceOwnerId('hub', world.hub.id)));
  for (const a of world.agents) fixed(a, 'cargo', view(world, resourceOwnerId('agent', a.id)));
  for (const d of world.deposits) {
    const owner = resourceOwnerId('deposit', d.id);
    const material = d.material;
    getter(d, 'amount', () => units(world, owner, material));
  }
  for (const h of world.structures) bindHearth(world, h);
}

/** The World has already authorized the action. A prospective structure ID is
 * registered only for this atomic construction transaction. */
export function movePhysical(world: World, from: ResourceOwnerId, to: ResourceOwnerId,
  amount: Readonly<Inventory>, proposedStructure = false): ResourceTransferReceipt | undefined {
  const inventory = world.physicalInventory;
  const config = world.physicalConfig;
  if (!inventory || !config) throw new Error('Physical authority missing');
  const registry = owners(world);
  if (proposedStructure) registry.push(to);
  const quantities = config.calibration.filter(c => amount[c.materialId as Material] > 0)
    .map(c => ({ materialId: c.materialId, massKg: amount[c.materialId as Material] * c.kgPerUnit }));
  try {
    return transferResources(inventory, inventory.revision, registry, from, to, quantities);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/** Use plain JSON records to preserve actual transfer facts in the ledger. */
export function physicalDetails(receipt: ResourceTransferReceipt | undefined): EventDetails {
  if (!receipt) return {};
  return { physical: {
    fromOwnerId: receipt.fromOwnerId, toOwnerId: receipt.toOwnerId, revision: receipt.revision,
    createdSampleIds: [...receipt.createdSampleIds],
    materials: receipt.materials.map(m => ({ materialId: m.materialId, massKg: m.massKg,
      samples: m.samples.map(s => ({ sourceSampleId: s.sourceSampleId,
        transferredSampleId: s.transferredSampleId, massKg: s.massKg })) })),
  } };
}
