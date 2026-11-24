# Material foundations (v0.2)

This standalone subsystem provides bulk-material primitives for future world rules.
It is not yet wired into world ticks, legacy inventory counts, crafting or combustion.

## Catalog and units

| ID | Supported phase | Density (kg/m³) | Specific heat (J/kg·K) | Data quality |
| --- | --- | ---: | ---: | --- |
| wood | solid | 600 | 1700 | Approximate generic relatively dry wood |
| stone | solid | 2700 | 790 | Approximate dense rock |
| water | liquid | 998.2 | 4182 | Rounded reference values at 20 °C, atmospheric pressure |
| charcoal | solid | 250 | 1000 | Approximate porous-piece apparent density |
| ash | solid | 500 | 800 | Approximate loose mineral ash bulk density |

Water values are checked against the [Applied Fluids water-properties table](https://kdusling.github.io/teaching/Applied-Fluids/WaterProperties?T=20C).
These are reference values at one condition, not exact constants at every temperature.
All other numerical entries are provisional simulation approximations, not verified
measurements of a particular species, mineral, charcoal batch or ash composition.
Wood/charcoal fuel potential is a qualitative flag; it implies no burn rate,
ignition threshold, reaction products or energy release.

## API

Import from `src/sim/materials/index.ts` (use the project's .js import specifiers).
The catalog is frozen and its IDs are stable. A sample has `materialId`, `massKg`,
`temperatureC` and `phase` (solid, liquid or gas).

- `getMaterial(id)` returns a definition; unknown IDs throw.
- `validateQuantity(value)` accepts finite non-negative numbers.
- `validateSample(sample)` checks ID, mass, supported phase and temperature
  (finite, at least -273.15 °C).
- `massToVolumeM3(id, massKg, phase?)` divides by density;
  `volumeToMassKg(id, volumeM3, phase?)` multiplies by density.
  Omitted phase uses the catalog phase.
- `thermalEquilibriumC(a, b)` computes a common temperature for two samples
  in ideal insulated thermal contact, even with different material IDs.
- `combineSamples(a, b)` returns a fresh homogeneous sample with summed mass
  and equilibrium temperature, only for identical material IDs and phases.

With heat capacities C1 = m1*c1 and C2 = m2*c2, equilibrium temperature is
(C1*T1 + C2*T2)/(C1 + C2). Temperature differences in Celsius and kelvin are equal.
The implementation normalizes heat capacities before calculating a weighted
temperature to avoid unnecessary intermediate overflow. It does not model time
to equilibrium. Under these assumptions sensible heat is conserved within
floating-point tolerance.

Zero mass/volume is valid. A zero-mass sample contributes no thermal capacity;
two empty samples have no defined equilibrium and cannot be combined.
Invalid ranges, unsupported phases, incompatible combinations, overflowing
quantities, conversions that underflow to zero, and a combined mass that
entirely loses a positive input to floating-point rounding are rejected.
Other rounding is inherent in JavaScript numbers; results are not exact decimals.

## Limits and future work

Only one phase per material has properties in this milestone. The phase type
includes gas for future extension, but no gas properties or ice are supplied.
Phase is explicit, not inferred from temperature: a fixed-phase model can
produce temperatures outside real-world stability ranges. No automatic freezing,
boiling, decomposition, chemical reactions, latent heat, pressure effects,
temperature-dependent coefficients, heat loss or particle simulation is present.
Ash bulk volume includes void space, whereas charcoal uses apparent piece volume;
mixing/compaction/packing is not modeled. Combining is accounting for compatible
homogeneous bulk samples, not a physical mixing or assembly simulation.

The existing world state and its abstract inventory/heat units are unchanged.
Future processes should explicitly account for mass and energy exchanges and
define phase transitions before introducing them into the simulation.
