import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, '..', 'artifacts', 'architecture.excalidraw');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function uid() {
  // deterministic within session but unique
  _seq++;
  return (randomUUID().replace(/-/g, '').slice(0, 8) + _seq.toString(16).padStart(2, '0')).slice(0, 10);
}

function base(type, x, y, w, h, extra = {}) {
  return {
    id: uid(),
    type,
    x, y, width: w, height: h,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...extra,
  };
}

function createBox(x, y, w, h, bg, extra = {}) {
  return base('rectangle', x, y, w, h, {
    backgroundColor: bg,
    fillStyle: 'solid',
    strokeWidth: 1,
    ...extra,
  });
}

function createZone(x, y, w, h) {
  return base('rectangle', x, y, w, h, {
    strokeColor: '#5c7cfa',
    backgroundColor: '#e7f5ff',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'dashed',
    roundness: { type: 3 },
  });
}

function createText(x, y, text, fontSize = 14, fontFamily = 1, extra = {}) {
  return base('text', x, y, 0, 0, {
    type: 'text',
    text,
    fontSize,
    fontFamily,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: null,
    originalText: text,
    ...extra,
  });
}

function createZoneTitle(zoneX, zoneW, y, text) {
  return createText(zoneX + zoneW / 2, y, text, 20, 1, { textAlign: 'center', verticalAlign: 'top' });
}

function createArrow(x, y, points, label, labelExtra = {}) {
  const dx = points[points.length - 1][0];
  const dy = points[points.length - 1][1];
  return base('arrow', x, y, Math.abs(dx) || 1, Math.abs(dy) || 1, {
    type: 'arrow',
    points,
    startArrowhead: null,
    endArrowhead: 'arrow',
    strokeColor: '#5c7cfa',
    strokeWidth: 2,
    roundness: null,
  });
}

function createBidiArrow(x, y, points, label) {
  const dx = points[points.length - 1][0];
  const dy = points[points.length - 1][1];
  return base('arrow', x, y, Math.abs(dx) || 1, Math.abs(dy) || 1, {
    type: 'arrow',
    points,
    startArrowhead: 'arrow',
    endArrowhead: 'arrow',
    strokeColor: '#5c7cfa',
    strokeWidth: 2,
    roundness: null,
  });
}

function createLabel(x, y, text, fontSize = 14) {
  return createText(x, y, text, fontSize, 1, { textAlign: 'center', verticalAlign: 'middle' });
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const elements = [];

// ===== ZONE 1: ENTRY POINT =====
const z1x = 40, z1y = 40, z1w = 520, z1h = 140;
elements.push(createZone(z1x, z1y, z1w, z1h));
elements.push(createZoneTitle(z1x, z1w, z1y + 5, 'ENTRY POINT'));

// User box
elements.push(createBox(65, 80, 110, 55, '#d0bfff'));
elements.push(createText(120, 107, 'User', 16, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// run.sh box
elements.push(createBox(220, 70, 300, 80, '#d0bfff'));
elements.push(createText(370, 90, 'harness/run.sh', 16, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(370, 120, 'parses args, init/resume state,\nspawns manager, monitors bus', 12, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// ===== ZONE 2: CORE LOOP =====
const z2x = 600, z2y = 40, z2w = 520, z2h = 140;
elements.push(createZone(z2x, z2y, z2w, z2h));
elements.push(createZoneTitle(z2x, z2w, z2y + 5, 'CORE LOOP'));

// Manager Agent box
elements.push(createBox(640, 80, 440, 70, '#ffd8a8'));
elements.push(createText(860, 98, 'Manager Agent', 16, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(860, 122, 'agents/manager.md', 12, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(860, 136, 'classify → drive rounds → resolve deadlocks', 11, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// ===== ZONE 3: COMMUNICATION BUS =====
const z3x = 40, z3y = 220, z3w = 1080, z3h = 130;
elements.push(createZone(z3x, z3y, z3w, z3h));
elements.push(createZoneTitle(z3x, z3w, z3y + 5, 'COMMUNICATION BUS'));

// bus/messages.jsonl box
elements.push(createBox(80, 258, 240, 55, '#b2f2bb'));
elements.push(createText(200, 278, 'bus/messages.jsonl', 15, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(200, 298, 'append-only JSONL', 11, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// validate.mjs
elements.push(createBox(350, 260, 120, 28, '#b2f2bb'));
elements.push(createText(410, 274, 'validate.mjs', 12, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// schema.md
elements.push(createBox(490, 260, 120, 28, '#b2f2bb'));
elements.push(createText(550, 274, 'schema.md', 12, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// bus subtext
elements.push(createText(z3x + z3w / 2, z3y + z3h - 18, 'All agents communicate exclusively through the bus', 12, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// ===== ZONE 4: STATE & ARTIFACTS =====
const z4x = 40, z4y = 390, z4w = 520, z4h = 150;
elements.push(createZone(z4x, z4y, z4w, z4h));
elements.push(createZoneTitle(z4x, z4w, z4y + 5, 'STATE & ARTIFACTS'));

// state/session.json
elements.push(createBox(60, 425, 220, 45, '#ffc9c9'));
elements.push(createText(170, 440, 'state/session.json', 14, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(170, 460, 'phase, round_count, complexity,\ndeadlock_count, history', 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// artifacts/
elements.push(createBox(300, 425, 230, 45, '#ffc9c9'));
elements.push(createText(415, 447, 'artifacts/ (NIP docs)', 14, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// workspace/
elements.push(createBox(60, 485, 200, 40, '#ffc9c9'));
elements.push(createText(160, 505, 'workspace/', 14, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// ===== ZONE 5: PRIMARY AGENTS =====
const z5x = 600, z5y = 390, z5w = 520, z5h = 150;
elements.push(createZone(z5x, z5y, z5w, z5h));
elements.push(createZoneTitle(z5x, z5w, z5y + 5, 'PRIMARY AGENTS'));

// Architect box
elements.push(createBox(620, 422, 480, 50, '#a5d8ff'));
elements.push(createText(860, 435, 'Architect', 15, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(860, 455, 'agents/architect.md', 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(860, 467, 'system design, spec writing, delegates to planner', 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// Engineer box
elements.push(createBox(620, 485, 480, 45, '#a5d8ff'));
elements.push(createText(860, 497, 'Engineer', 15, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(860, 515, 'agents/engineer.md', 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(860, 527, 'feasibility analysis, implementation, delegates to coder', 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// ===== ZONE 6: STATELESS SUBAGENTS =====
const z6x = 600, z6y = 580, z6w = 520, z6h = 130;
elements.push(createZone(z6x, z6y, z6w, z6h));
elements.push(createZoneTitle(z6x, z6w, z6y + 5, 'STATELESS SUBAGENTS'));

// Five small boxes
const subNames = ['planner', 'executor\n(coder)', 'verifier', 'browser', 'web-search'];
const subW = 90, subGap = 7;
const totalSubW = subNames.length * subW + (subNames.length - 1) * subGap;
const subStartX = z6x + (z6w - totalSubW) / 2;
subNames.forEach((name, i) => {
  const sx = subStartX + i * (subW + subGap);
  elements.push(createBox(sx, z6y + 40, subW, 35, '#e9ecef'));
  elements.push(createText(sx + subW / 2, z6y + 40 + 17, name, 12, 1, { textAlign: 'center', verticalAlign: 'middle' }));
});

// subtext
elements.push(createText(z6x + z6w / 2, z6y + z6h - 18, 'Fresh session per call — called by manager/agents', 11, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// ===== ZONE 7: FRONTEND SERVER =====
const z7x = 40, z7y = 580, z7w = 520, z7h = 180;
elements.push(createZone(z7x, z7y, z7w, z7h));
elements.push(createZoneTitle(z7x, z7w, z7y + 5, 'FRONTEND SERVER'));

// Express + WebSocket
elements.push(createBox(60, 620, 480, 38, '#fff3bf'));
elements.push(createText(300, 639, 'Express + WebSocket :3333', 14, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// Five smaller boxes
const feNames = ['Session\nManagement', 'Discord\nBridge', 'Token\nTracker', 'Session\nRouter', 'Session\nSearch'];
const feW = 90, feGap = 6;
const totalFeW = feNames.length * feW + (feNames.length - 1) * feGap;
const feStartX = z7x + (z7w - totalFeW) / 2;
feNames.forEach((name, i) => {
  const fx = feStartX + i * (feW + feGap);
  elements.push(createBox(fx, z7y + 80, feW, 35, '#fff3bf'));
  elements.push(createText(fx + feW / 2, z7y + 80 + 17, name, 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));
});

// ===== ZONE 8: PI AGENT CORE =====
const z8x = 40, z8y = 800, z8w = 520, z8h = 140;
elements.push(createZone(z8x, z8y, z8w, z8h));
elements.push(createZoneTitle(z8x, z8w, z8y + 5, 'PI AGENT CORE'));

// Orchestrator Mode box
elements.push(createBox(60, 835, 480, 32, '#d0bfff'));
elements.push(createText(300, 851, 'Orchestrator Mode', 14, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(300, 867, 'AGENTS.md', 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// Four tool boxes
const toolNames = ['read', 'write', 'edit', 'bash'];
const toolW = 75, toolGap = 15;
const totalToolW = toolNames.length * toolW + (toolNames.length - 1) * toolGap;
const toolStartX = z8x + (z8w - totalToolW) / 2;
toolNames.forEach((name, i) => {
  const tx = toolStartX + i * (toolW + toolGap);
  elements.push(createBox(tx, z8y + 98, toolW, 28, '#d0bfff'));
  elements.push(createText(tx + toolW / 2, z8y + 112, name, 12, 1, { textAlign: 'center', verticalAlign: 'middle' }));
});

// ===== ZONE 9: SERVICES =====
const z9x = 600, z9y = 800, z9w = 520, z9h = 140;
elements.push(createZone(z9x, z9y, z9w, z9h));
elements.push(createZoneTitle(z9x, z9w, z9y + 5, 'SERVICES'));

// SearXNG box
elements.push(createBox(620, 835, 460, 38, '#f3d9fa'));
elements.push(createText(850, 848, 'SearXNG', 14, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(850, 868, 'services/searxng/', 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// Discord Bot box
elements.push(createBox(620, 890, 460, 38, '#f3d9fa'));
elements.push(createText(850, 903, 'Discord Bot', 14, 1, { textAlign: 'center', verticalAlign: 'middle' }));
elements.push(createText(850, 920, 'services/discord/', 10, 1, { textAlign: 'center', verticalAlign: 'middle' }));

// ===== ZONE 10: SYSTEM BOUNDARY (outer container) =====
const z10x = 22, z10y = 22, z10w = 1116, z10h = 936;
elements.push(createZone(z10x, z10y, z10w, z10h));
elements.push(createZoneTitle(z10x, z10w, z10y + 5, 'PI HARNESS — SYSTEM ARCHITECTURE'));

// ===================================================================
// ARROWS (13)
// ===================================================================

// 1. Z1→Z2: User→Manager — "spawns + monitors"
elements.push(createArrow(175, 107, [[0, 0], [465, 8]]));
elements.push(createLabel(175 + 465 / 2, 107 + 8 / 2 - 12, 'spawns + monitors', 12));

// 2. Z1→Z3: run.sh→Bus — "writes state/bus"
elements.push(createArrow(370, 150, [[0, 0], [-170, 110]]));
elements.push(createLabel(370 - 170 / 2, 150 + 110 / 2 - 14, 'writes state/bus', 12));

// 3. Z2→Z3: Manager→Bus — "reads/writes JSONL"
elements.push(createArrow(860, 150, [[0, 0], [-660, 110]]));
elements.push(createLabel(860 - 660 / 2, 150 + 110 / 2 - 14, 'reads/writes JSONL', 12));

// 4. Z3→Z4: Bus→State — "state updates"
elements.push(createArrow(580, 350, [[0, 0], [-420, 75]]));
elements.push(createLabel(580 - 420 / 2, 350 + 75 / 2 - 14, 'state updates', 12));

// 5. Z3→Z5: Bus→Agents — "design/feasibility requests"
elements.push(createArrow(580, 350, [[0, 0], [280, 75]]));
elements.push(createLabel(580 + 280 / 2, 350 + 75 / 2 - 14, 'design/feasibility\nrequests', 12));

// 6. Z2→Z5: Manager→Agents — "delegates"
elements.push(createArrow(1000, 150, [[0, 0], [0, 240]]));
elements.push(createLabel(1000 + 12, 150 + 240 / 2, 'delegates', 12));

// 7. Z5→Z6: Architect→planner — "delegates tasks"
elements.push(createArrow(800, 472, [[0, 0], [-110, 108]]));
elements.push(createLabel(800 - 110 / 2, 472 + 108 / 2 - 12, 'delegates\ntasks', 12));

// 8. Z5→Z6: Engineer→coder — "delegates implementation"
elements.push(createArrow(870, 530, [[0, 0], [-100, 50]]));
elements.push(createLabel(870 - 100 / 2 - 8, 530 + 50 / 2, 'delegates\nimplementation', 12));

// 9. Z6→Z3: Subagents→Bus (upward feedback) — "results"
elements.push(createArrow(820, 580, [[0, 0], [0, -230]]));
elements.push(createLabel(820 + 12, 580 - 230 / 2, 'results', 12));

// 10. Z8↔Z7: Pi Core↔Frontend — "SDK calls"
elements.push(createBidiArrow(300, 760, [[0, 0], [0, 40]]));
elements.push(createLabel(300 + 16, 760 + 20 - 7, 'SDK calls', 12));

// 11. Z8↔Z2: Pi Core↔Manager — "agent invocation"
elements.push(createBidiArrow(560, 870, [[0, 0], [300, -690]]));
elements.push(createLabel(560 + 300 / 2, 870 - 690 / 2 - 14, 'agent\ninvocation', 12));

// 12. Z9→Z6: SearXNG→web-search — "HTTP queries"
elements.push(createArrow(980, 835, [[0, 0], [60, -180]]));
elements.push(createLabel(980 + 60 / 2, 835 - 180 / 2 - 14, 'HTTP queries', 12));

// 13. Z7→Z9: Frontend→Discord — "bot events"
elements.push(createArrow(202, 718, [[0, 0], [448, 192]]));
elements.push(createLabel(202 + 448 / 2 + 8, 718 + 192 / 2, 'bot events', 12));

// ===================================================================
// Root
// ===================================================================

const doc = {
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements,
  appState: {
    gridSize: null,
    viewBackgroundColor: '#ffffff',
  },
  files: {},
};

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(doc, null, 2), 'utf-8');
console.log(`Wrote ${OUTPUT}`);
console.log(`Element count: ${elements.length}`);
