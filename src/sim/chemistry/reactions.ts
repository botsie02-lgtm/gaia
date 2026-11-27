import { ELEMENT_IDS, SPECIES_IDS, getSpecies } from './species.js';
import type { ElementId, SpeciesId } from './species.js';

export interface StoichiometricTerm {
  readonly speciesId: SpeciesId;
  readonly coefficient: number;
}
export interface ReactionEquation {
  readonly id: string;
  readonly reactants: readonly StoichiometricTerm[];
  readonly products: readonly StoichiometricTerm[];
}
export interface BalancedReaction extends ReactionEquation {
  readonly massMgPerMolExtent: number;
  readonly deltaEnthalpyJPerMolExtent: number;
}
export interface SpeciesAmount {
  readonly speciesId: SpeciesId;
  readonly amountMol: number;
}
export interface ReactionQuantity extends SpeciesAmount {
  readonly massKg: number;
}
export interface ReactionResult {
  readonly reaction: BalancedReaction;
  readonly requestedExtentMol: number;
  readonly maximumExtentMol: number;
  readonly extentMol: number;
  readonly limitingReactants: readonly SpeciesId[];
  readonly consumed: readonly ReactionQuantity[];
  /** All original species, including unreacted feed and existing products.
   * Newly produced material is separate; retain BOTH arrays on commit. */
  readonly remaining: readonly ReactionQuantity[];
  readonly produced: readonly ReactionQuantity[];
  readonly consumedMassKg: number;
  readonly producedMassKg: number;
  readonly chemicalEnthalpyChangeJ: number;
  readonly referenceEnergyReleaseJ: number;
  readonly referenceEnergyRequiredJ: number;
}

const MIN_NORMAL = 2 ** -1022;
const ROUND_TOL = 32 * Number.EPSILON;

function quantity(value: number): number {
  if (!Number.isFinite(value) || value < 0 || (value > 0 && value < MIN_NORMAL)) {
    throw new RangeError('Quantity must be finite, nonnegative and normal or zero');
  }
  return value === 0 ? 0 : value;
}
function product(a: number, b: number): number {
  const value = quantity(a * b);
  if (a > 0 && b > 0 && value === 0) throw new RangeError('Quantity underflow');
  return value;
}
function quotient(a: number, b: number): number {
  const value = quantity(a / b);
  if (a > 0 && value === 0) throw new RangeError('Quantity underflow');
  return value;
}
function add(a: number, b: number): number {
  const result = quantity(a + b);
  if (a > 0 && b > 0 && (result === a || result === b)) {
    throw new RangeError('Quantity sum loses a positive term');
  }
  return result;
}
function conserved(a: number, b: number): void {
  const scale = Math.max(a, b);
  if (scale > 0 && Math.abs(a - b) / scale > ROUND_TOL) {
    throw new RangeError('Reaction conservation exceeds numerical tolerance');
  }
}
function resolved(before: number, after: number, change: number): void {
  if (change > 0 && (before <= after || Math.abs((before - after) - change) / change > 1e-9)) {
    throw new RangeError('Consumption below numerical resolution');
  }
}

export function molesToMassKg(id: SpeciesId, amountMol: number): number {
  return product(quantity(amountMol), getSpecies(id).molarMassKgPerMol);
}
export function massKgToMoles(id: SpeciesId, massKg: number): number {
  return quotient(quantity(massKg), getSpecies(id).molarMassKgPerMol);
}
function snapshotSide(terms: readonly StoichiometricTerm[]): readonly StoichiometricTerm[] {
  if (!Array.isArray(terms) || terms.length === 0) throw new TypeError('Empty reaction side');
  const seen = new Set<SpeciesId>();
  const output: StoichiometricTerm[] = [];
  for (const term of terms) {
    if (!term || typeof term !== 'object') throw new TypeError('Invalid reaction term');
    getSpecies(term.speciesId);
    if (seen.has(term.speciesId) || !Number.isSafeInteger(term.coefficient) || term.coefficient <= 0) {
      throw new RangeError('Coefficients must be positive safe integers; species must be unique per side');
    }
    seen.add(term.speciesId);
    output.push(Object.freeze({ speciesId: term.speciesId, coefficient: term.coefficient }));
  }
  return Object.freeze(output.sort((a, b) => SPECIES_IDS.indexOf(a.speciesId) - SPECIES_IDS.indexOf(b.speciesId)));
}
function exactTotal(terms: readonly StoichiometricTerm[], value: (id: SpeciesId) => number): bigint {
  return terms.reduce((sum, t) => sum + BigInt(t.coefficient) * BigInt(value(t.speciesId)), 0n);
}
function safeNumber(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError('Equation totals exceed safe integer resolution');
  return n;
}

/** Exact integer atom and modeled molar mass balance. No authored heat value. */
export function createReaction(equation: ReactionEquation): BalancedReaction {
  if (!equation || typeof equation.id !== 'string' || !equation.id.trim()) {
    throw new TypeError('Invalid reaction ID');
  }
  const reactants = snapshotSide(equation.reactants);
  const products = snapshotSide(equation.products);
  if (reactants.some(a => products.some(b => b.speciesId === a.speciesId))) {
    throw new RangeError('Use net equations; species cannot occur on both sides');
  }
  for (const element of ELEMENT_IDS) {
    const atoms = (id: SpeciesId) => getSpecies(id).atoms[element];
    if (exactTotal(reactants, atoms) !== exactTotal(products, atoms)) {
      throw new RangeError('Unbalanced element: ' + element);
    }
  }
  const mass = (id: SpeciesId) => getSpecies(id).molarMassMgPerMol;
  const inputMass = exactTotal(reactants, mass);
  if (inputMass !== exactTotal(products, mass)) throw new RangeError('Unbalanced molar mass');
  const enthalpy = (id: SpeciesId) => getSpecies(id).formationEnthalpyJPerMol;
  const beforeH = exactTotal(reactants, enthalpy);
  const afterH = exactTotal(products, enthalpy);
  safeNumber(beforeH);
  safeNumber(afterH);
  return Object.freeze({ id: equation.id, reactants, products,
    massMgPerMolExtent: safeNumber(inputMass),
    deltaEnthalpyJPerMolExtent: safeNumber(afterH - beforeH) });
}

export const CARBON_OXIDATION = createReaction({
  id: 'carbon-oxidation',
  reactants: [
    { speciesId: 'carbon-graphite', coefficient: 1 },
    { speciesId: 'oxygen', coefficient: 1 },
  ],
  products: [{ speciesId: 'carbon-dioxide', coefficient: 1 }],
});

function record(speciesId: SpeciesId, amountMol: number): ReactionQuantity {
  return Object.freeze({ speciesId, amountMol: quantity(amountMol), massKg: molesToMassKg(speciesId, amountMol) });
}
function totalMass(records: readonly ReactionQuantity[]): number {
  return records.reduce((total, q) => add(total, q.massKg), 0);
}
function atomTotal(records: readonly ReactionQuantity[], element: ElementId): number {
  return records.reduce((total, q) => add(total, product(q.amountMol, getSpecies(q.speciesId).atoms[element])), 0);
}
function formationMagnitude(records: readonly ReactionQuantity[]): number {
  // All supported formation enthalpies are nonpositive. Positive sums avoid cancellation.
  return records.reduce((sum, q) => add(sum, product(q.amountMol, -getSpecies(q.speciesId).formationEnthalpyJPerMol)), 0);
}

/** Pure accounting plan, NOT a committed reaction, kinetics or authorization.
 * Supply actual available moles, one record per species. Missing species = zero.
 * No temperature or sensible-energy state is changed. Endothermic plans require
 * a future caller to supply the reported reference energy before committing.
 */
export function planReaction(
  equation: ReactionEquation, available: readonly SpeciesAmount[], requestedExtentMol: number,
): ReactionResult {
  // Recompute rather than trusting cached or forged derived fields.
  const reaction = createReaction(equation);
  const request = quantity(requestedExtentMol);
  if (!Array.isArray(available)) throw new TypeError('Expected species inventory');
  const feed = new Map<SpeciesId, ReactionQuantity>();
  for (const item of available) {
    if (!item || typeof item !== 'object') throw new TypeError('Invalid species amount');
    getSpecies(item.speciesId);
    if (feed.has(item.speciesId)) throw new RangeError('Duplicate available species');
    feed.set(item.speciesId, record(item.speciesId, item.amountMol));
  }
  const limits = reaction.reactants.map(t => ({
    speciesId: t.speciesId, extent: quotient(feed.get(t.speciesId)?.amountMol ?? 0, t.coefficient),
  }));
  const maximumExtentMol = Math.min(...limits.map(l => l.extent));
  const limitingReactants = Object.freeze(limits.filter(l => l.extent === maximumExtentMol).map(l => l.speciesId));
  let extentMol = Math.min(request, maximumExtentMol);
  // A rounded quotient can be slightly above exact availability. Round down
  // conservatively; never manufacture the missing amount by clamping consumption.
  if (reaction.reactants.some(t => extentMol * t.coefficient > (feed.get(t.speciesId)?.amountMol ?? 0))) {
    extentMol = quantity(extentMol * (1 - Number.EPSILON));
    if (extentMol === 0) throw new RangeError('Extent underflow');
  }
  const consumed = Object.freeze(reaction.reactants.map(t => record(t.speciesId, product(extentMol, t.coefficient))));
  const produced = Object.freeze(reaction.products.map(t => record(t.speciesId, product(extentMol, t.coefficient))));
  const remaining = Object.freeze(SPECIES_IDS.filter(id => feed.has(id)).map(id => {
    const original = feed.get(id)!;
    const take = consumed.find(q => q.speciesId === id);
    const rest = record(id, quantity(original.amountMol - (take?.amountMol ?? 0)));
    resolved(original.amountMol, rest.amountMol, take?.amountMol ?? 0);
    resolved(original.massKg, rest.massKg, take?.massKg ?? 0);
    conserved(original.massKg, add(rest.massKg, take?.massKg ?? 0));
    return rest;
  }));
  // Ensure even an absent species cannot be consumed after rounding.
  for (const q of consumed) {
    if (q.amountMol > (feed.get(q.speciesId)?.amountMol ?? 0)) throw new RangeError('Insufficient reactant');
  }
  const consumedMassKg = totalMass(consumed);
  const producedMassKg = totalMass(produced);
  conserved(consumedMassKg, producedMassKg);
  const before = SPECIES_IDS.filter(id => feed.has(id)).map(id => feed.get(id)!);
  const after = [...remaining, ...produced];
  conserved(totalMass(before), totalMass(after));
  for (const element of ELEMENT_IDS) {
    conserved(atomTotal(consumed, element), atomTotal(produced, element));
    conserved(atomTotal(before, element), atomTotal(after, element));
  }

  const delta = reaction.deltaEnthalpyJPerMolExtent;
  const magnitude = product(extentMol, Math.abs(delta));
  const chemicalEnthalpyChangeJ = magnitude === 0 ? 0 : delta < 0 ? -magnitude : magnitude;
  const referenceEnergyReleaseJ = delta < 0 ? magnitude : 0;
  const referenceEnergyRequiredJ = delta > 0 ? magnitude : 0;
  // H_products - H_reactants is the negative of the formation magnitude change.
  const hBefore = formationMagnitude(consumed);
  const hAfter = formationMagnitude(produced);
  const ledgerBefore = add(hBefore, referenceEnergyReleaseJ);
  const ledgerAfter = add(hAfter, referenceEnergyRequiredJ);
  conserved(ledgerBefore, ledgerAfter);
  return Object.freeze({ reaction, requestedExtentMol: request, maximumExtentMol, extentMol,
    limitingReactants, consumed, remaining, produced, consumedMassKg, producedMassKg,
    chemicalEnthalpyChangeJ, referenceEnergyReleaseJ, referenceEnergyRequiredJ });
}
