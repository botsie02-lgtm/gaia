/** Stable identifiers for the material subsystem, independent of legacy inventory units. */
export type MaterialId = 'wood' | 'stone' | 'water' | 'charcoal' | 'ash';
export type MaterialPhase = 'solid' | 'liquid' | 'gas';

export interface MaterialDefinition {
  readonly id: MaterialId;
  readonly densityKgPerM3: number;
  readonly specificHeatJPerKgK: number;
  /** Only this phase has density and heat capacity data in v0.2. */
  readonly phase: MaterialPhase;
  /** Qualitative fuel potential, not a combustion rule or ignition condition. */
  readonly combustible: boolean;
  readonly dataQuality: 'reference' | 'approximation';
  readonly dataNotes: string;
}

/** A homogeneous bulk sample, not a particle or a legacy inventory count. */
export interface MaterialSample {
  readonly materialId: MaterialId;
  readonly massKg: number;
  readonly temperatureC: number;
  readonly phase: MaterialPhase;
}

export const MATERIALS: Readonly<Record<MaterialId, MaterialDefinition>> = Object.freeze({
  wood: Object.freeze({
    id: 'wood', densityKgPerM3: 600, specificHeatJPerKgK: 1700,
    phase: 'solid', combustible: true, dataQuality: 'approximation',
    dataNotes: 'Generic relatively dry wood; species and moisture vary.',
  }),
  stone: Object.freeze({
    id: 'stone', densityKgPerM3: 2700, specificHeatJPerKgK: 790,
    phase: 'solid', combustible: false, dataQuality: 'approximation',
    dataNotes: 'Generic dense rock; mineral composition and porosity vary.',
  }),
  water: Object.freeze({
    id: 'water', densityKgPerM3: 998.2, specificHeatJPerKgK: 4182,
    phase: 'liquid', combustible: false, dataQuality: 'reference',
    dataNotes: 'Rounded liquid-water reference at 20 C and atmospheric pressure; see docs/MATERIALS.md.',
  }),
  charcoal: Object.freeze({
    id: 'charcoal', densityKgPerM3: 250, specificHeatJPerKgK: 1000,
    phase: 'solid', combustible: true, dataQuality: 'approximation',
    dataNotes: 'Porous charcoal apparent density, not packed-bed or pure-carbon density.',
  }),
  ash: Object.freeze({
    id: 'ash', densityKgPerM3: 500, specificHeatJPerKgK: 800,
    phase: 'solid', combustible: false, dataQuality: 'approximation',
    dataNotes: 'Idealized loose mineral ash bulk density; composition and packing vary.',
  }),
});

export function getMaterial(materialId: MaterialId): MaterialDefinition {
  if (typeof materialId !== 'string' || !Object.hasOwn(MATERIALS, materialId)) {
    throw new RangeError('Unknown material ID');
  }
  return MATERIALS[materialId];
}
