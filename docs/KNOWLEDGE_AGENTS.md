# Knowledge-limited agents (v0.3 integration)

The simulation now offers two policies. Headless createWorld(seed) remains legacy
for regression compatibility. createWorld(seed, { agentMode: 'knowledge',
perceptionRange: 6, memoryCapacity: 512 }) enables the new policy; the browser
starts in knowledge mode. Changing the browser policy regenerates the same seed
rather than mixing incompatible policy histories. All agents own a bounded
AgentMemory; legacy mode leaves it empty.

## Tick and authority

After incrementing the logical world tick, knowledge mode captures observeAgent
for each agent, updates its individual AgentMemory exactly once, and calls
decideAgent with the immutable observation and memory snapshot, a detached copy
of its energy/rest/cargo, and public grid dimensions and cargo limit. No actions
execute until all decisions are formed. The executor resolves requests in
ascending stable agent ID order, checking adjacency, passability, deposit ID,
location, available amount, cargo capacity, hub ID/location and rest state.
Failed requests do not transfer units or award practice; the next observation
can correct the agent's outdated evidence. Neither global stockpile, other
agents' internal state, event history, hidden hub/deposits, seed, nor global
pathfinder is a policy input. This is an architectural boundary, not a security
sandbox. No knowledge sharing or faction-specific decision branches exist.

Legacy mode continues to use the existing privileged policy. Both modes use the
same harvest, delivery, rest, event and gathering-practice rules. Construction,
fuel burning and stockpile refueling remain privileged world rules in prototype
units, not a new physical inventory integration.

## Decisions

A BFS traverses only observed or remembered non-water tiles, with current
observation overriding stale entries. Deposits with positive observed amount
and hubs are eligible from sight or memory; absent records are excluded.
Agents prefer their carried material or a deterministic ID-parity preference,
then shortest known distance and stable ID. Full cargo returns to a reachable
known hub; partial cargo is delivered if gathering is unavailable. A hub must
be seen before it can be remembered; agents near the initial spawn may see it
immediately. If a target is unreachable or unavailable, explore the nearest
reachable known tile adjacent to unknown in-bounds terrain, with fixed
east/south/west/north BFS tie order. Unknown terrain itself is never used
as a planned route. If there is no reachable frontier, idle and resample next
tick. A zero perception range cannot explore without remembered terrain.

The browser inspector follows the lowest-ID agent on a clicked occupied tile.
It shows the last intention, memory size, remembered deposit amount/status/tick
and latest perception summary. Optional yellow overlay highlights actual
recorded pre-action visible tiles, with an outline at the observation origin.
It is not a fog-of-war security mechanism; the world viewer is omniscient.
After movement the displayed observation is from before that tick's action.
No extra observation or memory update occurs during rendering.

## Limits

This is deterministic heuristics, not general intelligence, autonomous learning
or planning over unobserved facts. Exact visible quantities and public world
bounds are scenario assumptions. No communication, diplomacy or combat.
Memory eviction can disconnect known routes or erase the hub; agents may need
to rediscover it. Small memories or closed terrain can cause repeated exploration,
idle states or failure to return; there is no guarantee of complete exploration.
No route caching or spatial index; each tick scans entities per observer,
sorts memory evidence, and performs one BFS over reachable known tiles per active
agent. Retained memory O(N*C), plus latest observation per agent; BFS O(C+V)
where V is current visible tiles, plus resource candidate sorting. Browser
overlay and inspector are not performance benchmarks.

World JSON now includes mode/config, memory snapshots and latest decision and
observation. Legacy snapshots are additive schema changes; full world save/load
is not implemented. AgentMemory.fromSnapshot restores memory alone. Future work:
profile and index sensing, improve exploration/retention, persist world snapshots,
add action feedback and deliberate knowledge sharing, integrate physical resource
transactions separately. No dependency on Developer 12.
