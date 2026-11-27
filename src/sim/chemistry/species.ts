/** Pure-species reference identities, not the heterogeneous material catalog.
 * Abridged CIAAW atomic weights and NIST standard formation enthalpies.
 * See docs/CHEMISTRY.md for references and approximation boundaries.
 */
export type ElementId = 'C' | 'O';
export type SpeciesId = 'carbon-graphite' | 'oxygen' | 'carbon-dioxide' | 'carbon-monoxide';
export type SpeciesPhase = 'solid' | 'gas';

export const ELEMENT_IDS: readonly ElementId[] = Object.freeze(['C', 'O'] as const);
export const SPECIES_IDS: readonly SpeciesId[] = Object.freeze([
  'carbon-graphite', 'carbon-dioxide', 'carbon-monoxide', 'oxygen',
] as const);

/** Integer mg/mol, derived from rounded atomic weights in g/mol. */
export const ATOMIC_MASS_MG_PER_MOL: Readonly<Record<ElementId, number>> = Object.freeze({
  C: 12011, O: 15999,
});

export const CHEMICAL_REFERENCE = Object.freeze({
  temperatureK: 298.15, pressurePa: 100000,
  convention: 'standard-formation-enthalpy' as const,
});

export interface ChemicalSpecies {
  readonly id: SpeciesId;
  readonly formula: string;
  readonly phase: SpeciesPhase;
  readonly atoms: Readonly<Record<ElementId, number>>;
  readonly molarMassMgPerMol: number;
  readonly molarMassKgPerMol: number;
  readonly formationEnthalpyJPerMol: number;
}

function species(id: SpeciesId, formula: string, phase: SpeciesPhase,
  C: number, O: number, formationEnthalpyJPerMol: number): ChemicalSpecies {
  const atoms = Object.freeze({ C, O });
  const molarMassMgPerMol = C * ATOMIC_MASS_MG_PER_MOL.C + O * ATOMIC_MASS_MG_PER_MOL.O;
  return Object.freeze({ id, formula, phase, atoms, molarMassMgPerMol,
    molarMassKgPerMol: molarMassMgPerMol / 1e6, formationEnthalpyJPerMol });
}

export const SPECIES: Readonly<Record<SpeciesId, ChemicalSpecies>> = Object.freeze({
  'carbon-graphite': species('carbon-graphite', 'C', 'solid', 1, 0, 0),
  oxygen: species('oxygen', 'O2', 'gas', 0, 2, 0),
  'carbon-dioxide': species('carbon-dioxide', 'CO2', 'gas', 1, 2, -393510),
  'carbon-monoxide': species('carbon-monoxide', 'CO', 'gas', 1, 1, -110530),
});

export function getSpecies(id: SpeciesId): ChemicalSpecies {
  if (typeof id !== 'string' || !Object.hasOwn(SPECIES, id)) {
    throw new RangeError('Unsupported chemical species');
  }
  return SPECIES[id];
}
