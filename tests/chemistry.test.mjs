import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIES, CHEMICAL_REFERENCE, getSpecies, molesToMassKg, massKgToMoles,
  createReaction, planReaction, CARBON_OXIDATION,
} from '../.sim-test/chemistry/index.js';

const C = 'carbon-graphite', O = 'oxygen', D = 'carbon-dioxide', M = 'carbon-monoxide';
const q = (speciesId, amountMol) => ({ speciesId, amountMol });
const t = (speciesId, coefficient) => ({ speciesId, coefficient });
const eq = (reactants, products) => ({ id: 'test-equation', reactants, products });
const find = (records, id) => records.find(x => x.speciesId === id);
function near(actual, expected, rel = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= rel * Math.max(Math.abs(actual), Math.abs(expected)),
    `${actual} != ${expected}`);
}
function atoms(records, element) {
  return records.reduce((s, x) => s + x.amountMol * getSpecies(x.speciesId).atoms[element], 0);
}
function mass(records) { return records.reduce((s, x) => s + molesToMassKg(x.speciesId, x.amountMol), 0); }

test('referenced species have consistent compositions, molar masses and standard states', () => {
  assert.deepEqual(Object.keys(SPECIES).sort(), [D, C, M, O]);
  assert.deepEqual(SPECIES[C].atoms, { C: 1, O: 0 });
  assert.deepEqual(SPECIES[O].atoms, { C: 0, O: 2 });
  assert.deepEqual(SPECIES[D].atoms, { C: 1, O: 2 });
  assert.deepEqual(SPECIES[M].atoms, { C: 1, O: 1 });
  assert.deepEqual([C,O,D,M].map(id => getSpecies(id).molarMassMgPerMol), [12011,31998,44009,28010]);
  assert.deepEqual([C,O,D,M].map(id => getSpecies(id).formationEnthalpyJPerMol), [0,0,-393510,-110530]);
  assert.deepEqual([C,O,D,M].map(id => getSpecies(id).phase), ['solid','gas','gas','gas']);
  assert.deepEqual(CHEMICAL_REFERENCE, { temperatureK: 298.15, pressurePa: 100000, convention: 'standard-formation-enthalpy' });
  assert.ok(Object.isFrozen(SPECIES) && Object.isFrozen(SPECIES[D]) && Object.isFrozen(SPECIES[D].atoms));
});

test('mol and kg conversions use consistent species masses', () => {
  for (const id of [C,O,D,M]) for (const n of [0,0.125,1,3.7,100000]) {
    near(massKgToMoles(id, molesToMassKg(id,n)),n);
  }
  near(molesToMassKg(D,1),0.044009);
});

test('reaction validation derives exact balance and reference enthalpy', () => {
  assert.equal(CARBON_OXIDATION.massMgPerMolExtent,44009);
  assert.equal(CARBON_OXIDATION.deltaEnthalpyJPerMolExtent,-393510);
  const scaled = createReaction(eq([t(C,2),t(O,2)],[t(D,2)]));
  assert.equal(scaled.massMgPerMolExtent,88018);
  assert.equal(scaled.deltaEnthalpyJPerMolExtent,-787020);
  const oxidation = createReaction(eq([t(M,2),t(O,1)],[t(D,2)]));
  assert.equal(oxidation.deltaEnthalpyJPerMolExtent,-565960);
});

test('unbalanced and malformed equations are rejected even for a zero request', () => {
  for (const rule of [
    eq([t(C,1)],[t(D,1)]), eq([t(C,1),t(O,2)],[t(D,1)]),
    eq([t(C,1),t(O,1)],[t(M,1)]), eq([t(C,1),t(C,1),t(O,2)],[t(D,2)]),
    eq([t(C,1)],[t(C,1)]), eq([t(C,1)],[]), eq([],[t(D,1)]),
    eq([t('wood',1),t(O,1)],[t(D,1)]),
    eq([t(C,1),t(O,1)],[t(D,1),t(D,1)]),
  ]) {
    assert.throws(() => createReaction(rule));
    assert.throws(() => planReaction(rule,[],0));
  }
  for (const bad of [0,-1,0.5,NaN,Infinity,2**53,'1']) {
    assert.throws(() => createReaction(eq([t(C,bad),t(O,1)],[t(D,1)])));
  }
  assert.throws(() => createReaction(eq([t(C,Number.MAX_SAFE_INTEGER),t(O,Number.MAX_SAFE_INTEGER)],[t(D,Number.MAX_SAFE_INTEGER)])));
});

test('one mole of oxidation explicitly consumes oxygen and produces CO2 gas mass', () => {
  const r = planReaction(CARBON_OXIDATION,[q(C,1),q(O,1)],1);
  assert.equal(r.extentMol,1);
  assert.deepEqual(r.limitingReactants,[C,O]);
  near(find(r.consumed,C).massKg,0.012011);
  near(find(r.consumed,O).massKg,0.031998);
  near(find(r.produced,D).massKg,0.044009);
  near(r.consumedMassKg,r.producedMassKg);
  assert.ok(r.remaining.every(x => x.amountMol === 0));
  assert.equal(r.chemicalEnthalpyChangeJ,-393510);
  assert.equal(r.referenceEnergyReleaseJ,393510);
  assert.equal(r.referenceEnergyRequiredJ,0);
  assert.ok(!Object.hasOwn(r,'temperatureC'));
});

test('oxygen-limited conversion retains excess carbon and preexisting products', () => {
  const feed = [q(C,2),q(O,0.75),q(D,0.5),q(M,0.25)];
  const r = planReaction(CARBON_OXIDATION,feed,2);
  assert.equal(r.maximumExtentMol,0.75);
  assert.equal(r.extentMol,0.75);
  assert.deepEqual(r.limitingReactants,[O]);
  assert.equal(find(r.remaining,C).amountMol,1.25);
  assert.equal(find(r.remaining,O).amountMol,0);
  assert.equal(find(r.remaining,D).amountMol,0.5);
  assert.equal(find(r.remaining,M).amountMol,0.25);
  assert.equal(find(r.produced,D).amountMol,0.75);
  near(mass(feed),mass([...r.remaining,...r.produced]));
  for (const e of ['C','O']) near(atoms(feed,e),atoms([...r.remaining,...r.produced],e));
});

test('carbon limitation and requested partial extent are distinguished', () => {
  const feed = [q(C,2),q(O,5)];
  const limited = planReaction(CARBON_OXIDATION,feed,3);
  assert.deepEqual(limited.limitingReactants,[C]);
  assert.equal(limited.extentMol,2);
  assert.equal(find(limited.remaining,O).amountMol,3);
  const requested = planReaction(CARBON_OXIDATION,feed,0.125);
  assert.equal(requested.maximumExtentMol,2);
  assert.equal(requested.extentMol,0.125);
  assert.equal(find(requested.remaining,C).amountMol,1.875);
  assert.equal(find(requested.remaining,O).amountMol,4.875);
});

test('missing oxygen or zero extent cannot create matter or energy', () => {
  for (const [feed,request] of [[[q(C,2)],2],[[],5],[[q(C,1),q(O,1)],0],[[q(O,2)],2]]) {
    const r = planReaction(CARBON_OXIDATION,feed,request);
    assert.equal(r.extentMol,0);
    assert.equal(r.chemicalEnthalpyChangeJ,0);
    assert.equal(r.referenceEnergyReleaseJ,0);
    assert.equal(r.referenceEnergyRequiredJ,0);
    assert.ok(r.consumed.every(x=>x.amountMol===0) && r.produced.every(x=>x.amountMol===0));
    assert.equal(mass(r.remaining),mass(feed));
  }
});

test('non-unit coefficients and multiple products retain stoichiometry', () => {
  const rule = eq([t(M,2),t(O,1)],[t(D,2)]);
  const r = planReaction(rule,[q(M,3),q(O,2)],3);
  assert.equal(r.extentMol,1.5);
  assert.equal(find(r.consumed,M).amountMol,3);
  assert.equal(find(r.consumed,O).amountMol,1.5);
  assert.equal(find(r.produced,D).amountMol,3);
  assert.equal(r.referenceEnergyReleaseJ,848940);
  const reverse = planReaction(eq([t(D,2)],[t(M,2),t(O,1)]),[q(D,3)],3);
  assert.equal(reverse.extentMol,1.5);
  assert.equal(reverse.referenceEnergyRequiredJ,848940);
  near(reverse.producedMassKg,reverse.consumedMassKg);
});

test('reverse reaction reports energy demand, not free heat or an executed action', () => {
  const r = planReaction(eq([t(D,1)],[t(C,1),t(O,1)]),[q(D,2)],1);
  assert.equal(r.chemicalEnthalpyChangeJ,393510);
  assert.equal(r.referenceEnergyReleaseJ,0);
  assert.equal(r.referenceEnergyRequiredJ,393510);
  assert.equal(find(r.remaining,D).amountMol,1);
});

test('formation enthalpy is derived rather than trusted from a forged rule', () => {
  const forged = {...CARBON_OXIDATION,deltaEnthalpyJPerMolExtent:1,massMgPerMolExtent:1};
  const r = planReaction(forged,[q(C,1),q(O,1)],1);
  assert.equal(r.chemicalEnthalpyChangeJ,-393510);
  assert.equal(r.reaction.massMgPerMolExtent,44009);
});

test('unknown species, duplicate feed and invalid quantities reject including no-ops', () => {
  for (const id of ['wood','charcoal','__proto__','constructor','',null]) {
    assert.throws(()=>getSpecies(id));
    assert.throws(()=>planReaction(CARBON_OXIDATION,[q(id,0)],0));
  }
  for (const n of [-1,NaN,Infinity,-Infinity,'1',null,undefined,Number.MIN_VALUE]) {
    assert.throws(()=>planReaction(CARBON_OXIDATION,[q(C,n)],0));
    assert.throws(()=>planReaction(CARBON_OXIDATION,[],n));
    assert.throws(()=>molesToMassKg(C,n));
    assert.throws(()=>massKgToMoles(C,n));
  }
  assert.throws(()=>planReaction(CARBON_OXIDATION,[q(C,1),q(C,2)],0));
  assert.throws(()=>planReaction(CARBON_OXIDATION,[null],0));
});

test('numeric overflow, underflow and unresolved consumption reject', () => {
  assert.throws(()=>massKgToMoles(C,Number.MAX_VALUE));
  assert.throws(()=>molesToMassKg(C,2**-1022));
  assert.throws(()=>planReaction(CARBON_OXIDATION,[q(C,Number.MAX_VALUE),q(O,Number.MAX_VALUE)],Number.MAX_VALUE));
  assert.throws(()=>planReaction(CARBON_OXIDATION,[q(C,1e20),q(O,1)],1));
  assert.throws(()=>planReaction(CARBON_OXIDATION,[q(C,1e12),q(O,0.1)],0.1));
});

test('canonical immutable results are independent of input ordering and later mutation', () => {
  const rule=eq([t(O,1),t(C,1)],[t(D,1)]);
  const feed=[q(O,2),q(C,3),q(M,0.5)];
  const r=planReaction(rule,feed,0.75);
  for(let i=0;i<40;i++) {
    const reversed=eq([...rule.reactants].reverse(),[...rule.products]);
    assert.deepEqual(planReaction(reversed,[...feed].reverse(),0.75),r);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
  rule.reactants[0].coefficient=3; feed[0].amountMol=99;
  assert.equal(r.extentMol,0.75);
  assert.equal(find(r.remaining,O).amountMol,1.25);
  for(const x of [r,r.reaction,r.reaction.reactants,r.reaction.reactants[0],r.consumed,r.consumed[0],r.remaining,r.remaining[0],r.produced,r.produced[0],r.limitingReactants]) assert.ok(Object.isFrozen(x));
});

test('varied positive batches conserve elemental amounts, mass and reference energy', () => {
  for (let i=1;i<=50;i++) {
    const feed=[q(C,i/7),q(O,(51-i)/13),q(D,0.25)];
    const r=planReaction(CARBON_OXIDATION,feed,i/19);
    const after=[...r.remaining,...r.produced];
    for (const e of ['C','O']) near(atoms(feed,e),atoms(after,e));
    near(mass(feed),mass(after));
    near(r.referenceEnergyReleaseJ,r.extentMol*393510);
    assert.ok(find(r.consumed,C).amountMol<=feed[0].amountMol);
    assert.ok(find(r.consumed,O).amountMol<=feed[1].amountMol);
  }
});
