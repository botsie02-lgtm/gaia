import './style.css';
import { createWorld, stepWorld } from './sim/world.js';
import { drawWorld, TILE } from './ui/draw.js';
import type { World } from './sim/model.js';
import { resourceOwnerId } from './sim/resource-actions/index.js';
import type { OwnerKind } from './sim/resource-actions/index.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

app.innerHTML = `
  <header class="topbar"><div><p class="eyebrow">GAIA / EXPERIMENT 001</p>
    <h1>A world that runs itself.</h1><p class="subhead">Seeded agents · finite resources · emergent construction</p></div>
    <div class="state-pill" id="mode">RUNNING</div></header>
  <main class="shell"><section class="world-panel">
    <div class="panel-head"><strong>World view</strong><span id="readout">Tick 0</span></div>
    <canvas id="world" aria-label="Top-down simulated world"></canvas>
    <div class="controls">
      <button id="pause">Pause</button><button id="step">Step +1</button>
      <label>Ticks / second <select id="speed"><option value="5">5</option><option value="10" selected>10</option><option value="30">30</option><option value="60">60</option></select></label>
      <label>World seed <input id="seed" type="number" value="12345" /></label>
      <label>Agent policy <select id="agent-policy"><option value="knowledge" selected>Knowledge-limited</option><option value="legacy">Legacy</option></select></label>
      <label>Resources <select id="resource-mode"><option value="physical" selected>Physical matter</option><option value="legacy">Legacy units</option></select></label>
      <label><input id="thermal" type="checkbox" /> Thermal contacts (physical)</label>
      <label><input id="visibility" type="checkbox" /> Selected agent sight</label>
      <button id="reset" class="secondary">Regenerate</button>
    </div>
  </section><aside class="sidebar">
    <section class="panel"><div class="section-label">SIMULATION</div><div id="stats" class="stats"></div></section>
    <section class="panel"><div class="section-label">INSPECTOR</div><div id="inspector" class="inspector">Click a tile to inspect its terrain and entities.</div></section>
    <section class="panel"><div class="section-label">RECENT EVENTS</div><div id="recent-events" class="inspector">No events yet.</div><p class="small" id="history-count"></p></section>
    <section class="panel"><div class="section-label">RULES IN EFFECT</div><p>Agents choose resources, gather finite deposits, return cargo to the hub, rest when tired, and construct a hearth from wood and stone.</p><p id="hearth-rule"></p><p class="small">This is an abstract material process, not atomic physics or a learned intelligence system yet.</p></section>
    <section class="panel legend"><div class="section-label">LEGEND</div><div><span class="mark wood"></span>Wood <span class="mark stone"></span>Stone <span class="mark agent"></span>Agent <span class="mark hearth"></span>Hearth</div></section>
  </aside></main>
  <footer>GAIA simulation prototype 0.2 · deterministic fixed-step core · browser is a viewer</footer>`;

const get = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element as T;
};
const canvas = get<HTMLCanvasElement>('world');
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D unavailable');
const pauseButton = get<HTMLButtonElement>('pause');
const mode = get<HTMLDivElement>('mode');
const readout = get<HTMLSpanElement>('readout');
const stats = get<HTMLDivElement>('stats');
const inspector = get<HTMLDivElement>('inspector');
const recentEvents = get<HTMLDivElement>('recent-events');
const historyCount = get<HTMLParagraphElement>('history-count');
const speed = get<HTMLSelectElement>('speed');
const seedInput = get<HTMLInputElement>('seed');
const policySelect = get<HTMLSelectElement>('agent-policy');
const visibility = get<HTMLInputElement>('visibility');
const resourceSelect = get<HTMLSelectElement>('resource-mode');
const chosenResourceMode = () => resourceSelect.value === 'legacy' ? 'legacy' as const : 'physical' as const;
const thermalSelect = get<HTMLInputElement>('thermal');
const chosenThermal = () => chosenResourceMode() === 'physical' && thermalSelect.checked;
const chosenMode = () => policySelect.value === 'legacy' ? 'legacy' as const : 'knowledge' as const;
let world: World = createWorld(12345, { agentMode: chosenMode(), resourceMode: chosenResourceMode(), thermal: chosenThermal() });
let selectedAgentId: number | null = null;
let running = true;
let selected: { x: number; y: number } | null = null;
let lastTime = performance.now();
let accumulatedMs = 0;

let historyWorld: World | undefined;
let historyTick = -1;

function renderRecentEvents(): void {
  // The browser observes history; it never publishes simulation events.
  if (historyWorld === world && historyTick === world.tick) return;
  historyWorld = world;
  historyTick = world.tick;
  const events = world.history.query().slice(-8).reverse();
  recentEvents.textContent = events.length === 0 ? 'No events yet.' : events.map(event => {
    const actor = event.actorId === undefined ? '' : ' actor #' + event.actorId;
    const target = event.targetId === undefined ? '' : ' target #' + event.targetId;
    const details = Object.entries(event.details ?? {}).filter(([key]) => key !== 'unit')
      .map(([key, value]) => key + '=' + (key === 'proficiency' && typeof value === 'number'
        ? (value * 100).toFixed(1) + '%' : typeof value === 'object' ? JSON.stringify(value) : String(value))).join(', ');
    return '#' + event.eventId + ' · tick ' + event.tick + '\n' + event.kind + actor + target +
      (details ? '\n' + details : '');
  }).join('\n\n');
  historyCount.textContent = 'Latest ' + events.length + ' · retained ' + world.history.size +
    ' / ' + world.history.capacity + ' · units and physical transfer receipts where applicable';
}

function physicalLines(kind: OwnerKind, id: number): string[] {
  if (!world.physicalInventory) return [];
  const owner = resourceOwnerId(kind, id);
  const samples = world.physicalInventory.forOwner(owner);
  const mass = samples.reduce((sum, s) => sum + s.massKg, 0);
  return [owner + ': ' + mass.toFixed(3) + ' kg · ' + samples.length + ' samples',
    ...samples.map(s => '  #' + s.sampleId + ' ' + s.materialId + ' ' + s.massKg + ' kg · ' +
      s.temperatureC.toFixed(3) + ' °C · ' + s.phase)];
}

function inspect(): void {
  if (!selected) return;
  const tracked = world.agents.find(a => a.id === selectedAgentId);
  const { x, y } = tracked ?? selected;
  const terrain = world.terrain[y * world.width + x];
  const deposits = world.deposits.filter((p) => p.x === x && p.y === y);
  const agents = world.agents.filter((p) => p.x === x && p.y === y);
  const structures = world.structures.filter((p) => p.x === x && p.y === y);
  const lines = [`Tile (${x}, ${y}) · ${terrain}`];
  for (const deposit of deposits) lines.push(`${deposit.material} deposit #${deposit.id}: ${deposit.amount} remaining`);
  for (const agent of agents) lines.push(`${agent.faction} #${agent.id}: energy ${agent.energy.toFixed(0)}, cargo ${agent.cargo.wood} wood / ${agent.cargo.stone} stone${agent.resting ? ' (resting)' : ''}`);
  for (const agent of agents) {
    const skill = agent.skills.gathering;
    if (world.agentMode === 'knowledge') {
      const obs = agent.observation;
      lines.push('  Intention: ' + (agent.decision?.intention ?? 'Awaiting first tick'));
      lines.push('  Memory: ' + agent.memory.size + ' / ' + agent.memory.capacity);
      lines.push('  Perception: ' + (obs ? 'tick ' + obs.tick + ' · ' + obs.terrain.length +
        ' tiles · ' + obs.deposits.length + ' deposits · ' + obs.agents.length +
        ' other agents · hub ' + (obs.hub ? 'visible' : 'not visible') : 'not yet sampled'));
      for (const m of agent.memory.query({ kind: 'deposit' })) {
        if (m.value.kind === 'deposit') lines.push('    ' + m.value.material + ' #' + m.value.id +
          ' (' + m.value.x + ',' + m.value.y + ') ' + m.value.amount + ' last seen · ' +
          m.status + ' · tick ' + m.lastObservedTick);
      }
    }
    lines.push('  Gathering #' + agent.id + ': ' + (skill.proficiency * 100).toFixed(1) +
      '% · ' + skill.attempts + ' practices · ' + skill.experience + ' XP');
  }
  for (const structure of structures) lines.push(`Hearth #${structure.id}: heat ${structure.heat.toFixed(1)}, fuel ${structure.fuel}`);
  if (world.hub.x === x && world.hub.y === y) {
    lines.push('Hub #' + world.hub.id + ': ' + world.inventory.wood + ' wood / ' + world.inventory.stone + ' stone');
    lines.push(...physicalLines('hub', world.hub.id));
  }
  for (const d of deposits) lines.push(...physicalLines('deposit', d.id));
  for (const a of agents) lines.push(...physicalLines('agent', a.id));
  for (const h of structures) lines.push(...physicalLines('structure', h.id));
  if (lines.length === 1) lines.push('No entities on this tile.');
  inspector.textContent = lines.join('\n');
}

function render(): void {
  canvas.width = world.width * TILE;
  canvas.height = world.height * TILE;
  drawWorld(context!, world, visibility.checked ?
    world.agents.find(a => a.id === selectedAgentId)?.observation : undefined);
  readout.textContent = `Tick ${world.tick.toLocaleString()} · ${world.width} × ${world.height}`;
  mode.textContent = running ? 'RUNNING' : 'PAUSED';
  mode.classList.toggle('paused', !running);
  pauseButton.textContent = running ? 'Pause' : 'Resume';
  const average = world.agents.reduce((sum, agent) => sum + agent.energy, 0) / world.agents.length;
  get<HTMLParagraphElement>('hearth-rule').textContent = world.resourceMode === 'physical' ?
    'Physical hearth retains fuel; combustion and abstract heat are disabled.' :
    'Once built, the hearth burns wood to generate and lose abstract heat over time.';
  stats.innerHTML = [
    ['Resource mode', world.resourceMode],
    ['Thermal contacts', world.thermal ? 'Enabled' : 'Disabled'],
    ...(world.thermal ? [
      ['Modeled seconds / tick', world.thermal.config.tickDurationSeconds],
      ['Contact conductance (W/K)', world.thermal.config.conductanceWPerK],
      ['Contacts / tick budget', world.thermal.config.maxContactsPerTick],
      ['Event threshold (J)', world.thermal.config.eventThresholdJ],
    ] : []),
    ['Agents', world.agents.length], ['Average energy', `${average.toFixed(0)} / 100`],
    ['Wood stored', world.inventory.wood], ['Stone stored', world.inventory.stone],
    ['Wood harvested', world.stats.woodHarvested], ['Stone harvested', world.stats.stoneHarvested],
    ['Hearths', world.stats.hearthsBuilt],
    ['Hearth heat', world.structures[0] ? world.structures[0].heat.toFixed(1) : '—'],
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
  inspect();
  renderRecentEvents();
}

function frame(now: number): void {
  const dt = Math.min(now - lastTime, 200);
  lastTime = now;
  if (running) {
    accumulatedMs += dt;
    const tickMs = 1000 / Number(speed.value);
    let steps = 0;
    while (accumulatedMs >= tickMs && steps < 10) {
      stepWorld(world);
      accumulatedMs -= tickMs;
      steps++;
    }
    if (steps === 10) accumulatedMs = 0; // Never spiral when the tab is inactive.
  }
  render();
  requestAnimationFrame(frame);
}

pauseButton.addEventListener('click', () => { running = !running; accumulatedMs = 0; });
get<HTMLButtonElement>('step').addEventListener('click', () => {
  running = false;
  accumulatedMs = 0;
  stepWorld(world);
  render();
});
function regenerate(): void {
  const seed = Number(seedInput.value);
  if (!Number.isFinite(seed)) { seedInput.value = '12345'; return; }
  world = createWorld(Math.trunc(seed), { agentMode: chosenMode(), resourceMode: chosenResourceMode(), thermal: chosenThermal() });
  selectedAgentId = null;
  selected = null;
  inspector.textContent = 'Click a tile to inspect its terrain and entities.';
  accumulatedMs = 0;
  render();
 }
get<HTMLButtonElement>('reset').addEventListener('click', regenerate);
policySelect.addEventListener('change', regenerate);
resourceSelect.addEventListener('change', () => {
  thermalSelect.disabled = chosenResourceMode() === 'legacy';
  regenerate();
});
thermalSelect.addEventListener('change', regenerate);
visibility.addEventListener('change', render);
canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) * canvas.width / rect.width / TILE);
  const y = Math.floor((event.clientY - rect.top) * canvas.height / rect.height / TILE);
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;
  selected = { x, y };
  selectedAgentId = world.agents.filter(a => a.x === x && a.y === y)
    .sort((a,b) => a.id-b.id)[0]?.id ?? null;
  inspect();
});
render();
requestAnimationFrame(frame);
