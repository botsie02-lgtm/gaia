# Balanced chemical reaction foundation — Specialist Sprint 001

This is a headless, deterministic **accounting planner**, not a World action,
combustion simulator, thermodynamic equilibrium solver or agent knowledge store.
It has no imports from other simulation modules. It does not consume real
inventory, supply oxygen, heat samples, ignite fuel or advance time.

## Scientific reference data

The species registry intentionally distinguishes pure carbon (graphite) from
heterogeneous wood, charcoal and ash. Gas phase identities are not yet usable
as physical material samples in GAIA's existing catalog.

| Species ID | Formula/phase | Molar mass (g/mol) | Standard formation enthalpy (kJ/mol) |
| --- | --- | ---: | ---: |
| carbon-graphite | C(s), graphite | 12.011 | 0 |
| oxygen | O2(g) | 31.998 | 0 |
| carbon-dioxide | CO2(g) | 44.009 | -393.510 |
| carbon-monoxide | CO(g) | 28.010 | -110.530 |

Sources:
- [CIAAW abridged standard atomic weights](https://ciaaw.org/abridged-atomic-weights.htm):
  C 12.011 and O 15.999. Species molar masses are derived consistently from
  those rounded values, not separately rounded molecular weights.
- [NIST Chemistry WebBook SRD 69, carbon dioxide](https://webbook.nist.gov/cgi/cbook.cgi?ID=C124389&Mask=D):
  CODATA review value (Cox, Wagman et al., 1984), -393.51 +/- 0.13 kJ/mol.
- [NIST Chemistry WebBook SRD 69, carbon monoxide](https://webbook.nist.gov/cgi/cbook.cgi?ID=C630080&Mask=57):
  CODATA review value -110.53 +/- 0.17 kJ/mol.
- [NIST-JANAF carbon reference](https://janaf.nist.gov/tables/C-002.html)
  and [oxygen reference](https://janaf.nist.gov/tables/O-029.html):
  reference temperature 298.15 K, standard pressure 0.1 MPa.
  Elements in their reference forms have zero standard formation enthalpy
  by convention.

The reference data are real-world rounded values, not exact isotope-resolved
masses or universal heating values. The simulation approximation is to use
these fixed numbers (with no uncertainty propagation), idealized pure species,
and standard formation enthalpies only. No fictitious reaction heat is authored.

## API and conservation

Import from `src/sim/chemistry/index.ts` with .js import specifiers.

- `getSpecies(id)`, `molesToMassKg(id, mol)`, `massKgToMoles(id, kg)`
  validate supported identities and quantities.
- `createReaction({id, reactants, products})` validates nonempty net equations.
  Terms contain a speciesId and a positive safe-integer coefficient; duplicate
  species and species present on both sides are rejected. Each side is
  canonicalized by stable species order and detached/frozen.
  Atom counts and mass per mole of extent in integer mg are checked exactly
  with BigInt, not a mass-loss tolerance. Enthalpy per mole extent is derived
  using integer J/mol data; unsafe integer totals are rejected.
- `planReaction(equation, available, requestedExtentMol)` revalidates the
  equation (including cached or externally provided equations), accepts one
  nonnegative mole quantity per species, and treats missing species as zero.
  Maximum extent = min(available reactant moles / coefficient).
  Actual extent = min(requested, maximum), conservatively rounded down
  if a quotient would overconsume. Limiting reactants identify equal minimum
  floating-point ratios even when the requested extent is lower.
- Consumed and produced moles = respective coefficient times actual extent.
  Remaining records retain all supplied species including unreacted fuel,
  unused oxygen and previously present products. New products are separate
  from remaining stocks; both must be retained in a future commit. Zero rows
  are bookkeeping only, not physical samples. Every quantity includes kg.
  All returned structures, including the equation, are frozen and detached.
- The planner checks mass and elemental conservation both across the reacted
  portions and the whole feed/output ledger, and checks the formation
  enthalpy ledger. Input ordering does not alter results.
  It does not claim that arbitrary balanced equations are physically possible.

## Thermochemical convention

At 298.15 K (25 C) and standard pressure 100 kPa, signed chemical enthalpy
change per mole extent is sum(products coefficient * formation enthalpy)
minus sum(reactants coefficient * formation enthalpy). The result reports
chemicalEnthalpyChangeJ = extent * that value; referenceEnergyReleaseJ =
max(0, -change), referenceEnergyRequiredJ = max(0, change).
These last two fields are mutually exclusive views of the same change,
not independent energy sources. Positive required energy is a demand, not
evidence the energy exists. A future transaction must obtain/debit it from
an authorized reservoir or refuse the reaction.

Formation enthalpy is not sensible thermal energy. The thermal module's
current arbitrary absolute-zero reference (constant c_p) is different.
At standard conditions and constant pressure with only pressure-volume
work, the reaction enthalpy is the heat exchanged with the surroundings
for an isothermal reaction. This planner neither sets a temperature nor
credits any reservoir; the release is only a reference-state budget.
Do not add it to every product or both chemical and thermal balances.
At other temperatures use consistent phase-specific sensible enthalpy
increments relative to 298.15 K and account for heat losses, phase changes
and work. For constant-volume modeling, use internal energy and a consistent
pressure-volume correction; do not assume enthalpy equals internal energy.

## Demonstration

C(s, graphite) + O2(g) -> CO2(g).
One mol extent consumes 0.012011 kg carbon and 0.031998 kg oxygen,
produces 0.044009 kg carbon dioxide, and changes reference chemical
enthalpy by -393510 J. No matter disappears and no oxygen is generated.
For two mol carbon and 0.75 mol oxygen with requested extent 2 mol,
actual extent is 0.75 mol, 1.25 mol carbon remains, oxygen is exhausted,
0.75 mol CO2 is produced and reference release is 295132.5 J.
This is incomplete conversion of available fuel, not a prediction of
incomplete combustion products. CO is a separately referenced species;
the planner does not choose whether CO or CO2 forms.

## Numerical limitations

Coefficients and per-extent integer totals must fit safe integer limits;
atom and mass equality are checked with exact BigInt arithmetic.
Extent and quantities use IEEE-754 doubles. Nonfinite/negative quantities,
positive subnormal quantities, underflow to zero, overflowing totals and
sums that entirely lose a positive contribution are rejected. Consumption
must be available without topping up by tolerance; subtraction in both
moles and derived mass must resolve the requested movement within 1e-9
relative to the movement. Conservation compares positive totals to 32
machine epsilons relative to their scale (no fixed absolute mass allowance).
This is a conservative finite-range model, not arbitrary precision:
very disparate amounts may need smaller isolated batches or higher
precision. Repeated plans accumulate ordinary floating-point roundoff.
Only C and O and four pure species are supported; isotope variation,
mass-energy equivalence, charged species and mixtures are not modeled.

## Proposed transactional integration (future, not this PR)

1. Chemistry & Materials and Physics: add explicit catalog identities for
   graphite, O2, CO2 and CO. Gas density needs pressure/temperature or an
   equation of state, and heat capacities need phase-specific validated data
   with explicit approximation ranges. Do not alias charcoal to graphite or
   silently use liquid/solid properties for gas. Align thermal and chemical
   reference states before any energy exchange.
2. World Systems / Physics: introduce explicit finite oxygen-containing
   reservoirs and transport/mixing; make product gas storage and movement
   authoritative. There is no implicit atmosphere in this implementation.
3. Inventory: introduce revision-checked atomic transformation operations
   that select authorized stable sample IDs, reserve and consume exact
   positive masses, preserve remainders, retire fully consumed IDs and
   allocate new product IDs at explicit owners. Translate via species/mass
   adapters and recheck actual staged kg/moles/element balance. Stage
   chemical, sensible, external energy and process state together;
   validate nonnegative energy and rollback on any failure. Emit receipts
   and events only after commit, with replay protection. Do not use the
   existing per-material-conserving physics bridge as a chemistry shortcut.
4. Engineering & Technology: define actual contact, oxygen transport,
   ignition and kinetic/energy conditions; choose requested extent from
   physical rules, not automatic maximum extent. Add product heat,
   pressure/work and environmental loss models. A balanced equation and
   negative standard enthalpy do not establish spontaneity, ignition,
   rate, flame propagation or complete combustion.
5. Biology: extend the registry for H/N and validated water, nutrients and
   other metabolites when needed; use the same conservation and reservoir
   rules, not free biological energy.
6. Knowledge remains authoritative engine data. Agents may discover
   chemical properties only through future perception, experiments,
   learning and communication; no predefined agent knowledge is exposed.

Wood contains cellulose, hemicellulose, lignin, extractives, variable
moisture and minerals. Charcoal also has variable fixed carbon, volatiles
and ash. Wood combustion requires measured or explicitly calibrated
elemental composition, moisture and mineral fractions, formation
enthalpies or consistently defined heating values (water phase matters),
pyrolysis/char formation, oxygen/air supply and transport, CO/CO2,
water vapour, residual char/ash and other relevant products. Fuel-bound
oxygen must be counted. No universal wood equation or calorific value
is implied by this pure-graphite demonstration.
