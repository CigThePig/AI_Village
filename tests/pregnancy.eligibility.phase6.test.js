import test from 'node:test';
import { strict as assert } from 'node:assert';

function ensureBrowserStubs() {
  if (!globalThis.document) {
    globalThis.document = {
      getElementById: () => ({
        getContext: () => ({ imageSmoothingEnabled: true }),
        getBoundingClientRect: () => ({ width: 800, height: 600 }),
        style: {},
        width: 0,
        height: 0,
      }),
    };
  }
  if (!globalThis.window) {
    globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
  }
  if (!globalThis.AIV_TERRAIN) {
    globalThis.AIV_TERRAIN = {
      generateTerrain: () => ({}),
      makeHillshade: () => new Uint8ClampedArray(0),
    };
  }
  if (!globalThis.AIV_CONFIG) {
    globalThis.AIV_CONFIG = {
      WORLDGEN_DEFAULTS: {},
      SHADING_DEFAULTS: { ambient: 0.5, intensity: 0.5, slopeScale: 1 },
    };
  }
}
ensureBrowserStubs();

const {
  createPopulation,
  PREGNANCY_RECHECK_TICKS,
  PREGNANCY_ATTEMPT_COOLDOWN_TICKS,
  PREGNANCY_TICKS,
} = await import('../src/app/population.js');
const { setRandomSource } = await import('../src/app/rng.js');

function makeAdult(overrides = {}) {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 1e9),
    x: 0, y: 0,
    lifeStage: 'adult',
    pregnancyTimer: 0,
    pregnancyMateId: null,
    starveStage: 0,
    condition: 'normal',
    energy: 0.7,
    happy: 0.6,
    nextPregnancyTick: 0,
    thought: '',
    ...overrides,
  };
}

function makePopulation({ villagers = [], food = 100, huts = 10, tick = 1000 } = {}) {
  const state = {
    units: { villagers },
    stocks: { totals: { food } },
    time: { tick },
    world: { tiles: new Uint8Array(0) },
  };
  const pop = createPopulation({
    state,
    countBuildingsByKind: (kind) => kind === 'hut' ? { built: huts, planned: 0 } : { built: 0, planned: 0 },
    tileOccupiedByBuilding: () => false,
    idx: (x, y) => y * 64 + x,
    ensureVillagerNumber: (v) => v,
  });
  return { state, pop };
}

const RECHECK_BAIL_CASES = [
  ['lifeStage child', { lifeStage: 'child' }],
  ['already pregnant', { pregnancyTimer: 100 }],
  ['starveStage 1 (hungry)', { starveStage: 1 }],
  ['condition sick', { condition: 'sick' }],
  ['low energy', { energy: 0.3 }],
  ['low happy', { happy: 0.3 }],
];

for (const [label, override] of RECHECK_BAIL_CASES) {
  test(`B5: tryStartPregnancy sets short cooldown when ineligible (${label})`, () => {
    const tick = 1000;
    const v = makeAdult(override);
    const { pop } = makePopulation({ villagers: [v], tick });
    pop.tryStartPregnancy(v);
    assert.equal(
      v.nextPregnancyTick,
      tick + PREGNANCY_RECHECK_TICKS,
      'every ineligibility bail must set nextPregnancyTick = tick + PREGNANCY_RECHECK_TICKS',
    );
    assert.equal(v.pregnancyTimer, override.pregnancyTimer ?? 0);
  });
}

test('B5: tryStartPregnancy is a no-op while the cooldown is active', () => {
  const tick = 1000;
  const v = makeAdult({ energy: 0.3, nextPregnancyTick: tick + 30 });
  const { pop } = makePopulation({ villagers: [v], tick });
  pop.tryStartPregnancy(v);
  assert.equal(v.nextPregnancyTick, tick + 30, 'active cooldown must not be re-extended');
});

test('B6: tired mate is rejected by findBirthMate', () => {
  const parent = makeAdult({ id: 1, energy: 0.7, happy: 0.6 });
  const tiredMate = makeAdult({ id: 2, energy: 0.2, happy: 0.6, x: 1 });
  const { pop } = makePopulation({ villagers: [parent, tiredMate] });
  assert.equal(pop.findBirthMate(parent), null, 'mate with energy<0.4 must not be drafted');
});

test('B6: sad mate is rejected by findBirthMate', () => {
  const parent = makeAdult({ id: 1, energy: 0.7, happy: 0.6 });
  const sadMate = makeAdult({ id: 2, energy: 0.7, happy: 0.3, x: 1 });
  const { pop } = makePopulation({ villagers: [parent, sadMate] });
  assert.equal(pop.findBirthMate(parent), null, 'mate with happy<0.35 must not be drafted');
});

test('B6: tryStartPregnancy with a tired-only mate sets the no-mate cooldown', () => {
  const tick = 1000;
  const parent = makeAdult({ id: 1, energy: 0.7, happy: 0.6 });
  const tiredMate = makeAdult({ id: 2, energy: 0.2, happy: 0.6, x: 1 });
  const { pop } = makePopulation({ villagers: [parent, tiredMate], tick });
  setRandomSource(() => 0.01);
  try {
    pop.tryStartPregnancy(parent);
  } finally {
    setRandomSource(Math.random);
  }
  assert.equal(parent.pregnancyTimer, 0, 'no pregnancy should start without an eligible mate');
  assert.equal(parent.nextPregnancyTick, tick + PREGNANCY_ATTEMPT_COOLDOWN_TICKS);
});

test('eligible parent + eligible mate conceive when RNG passes', () => {
  const tick = 1000;
  const parent = makeAdult({ id: 1, energy: 0.7, happy: 0.6 });
  const mate = makeAdult({ id: 2, energy: 0.7, happy: 0.6, x: 1 });
  const { pop } = makePopulation({ villagers: [parent, mate], tick });
  setRandomSource(() => 0.01);
  try {
    pop.tryStartPregnancy(parent);
  } finally {
    setRandomSource(Math.random);
  }
  assert.equal(parent.pregnancyTimer, PREGNANCY_TICKS);
  assert.equal(parent.pregnancyMateId, mate.id);
  assert.equal(parent.nextPregnancyTick, tick + PREGNANCY_ATTEMPT_COOLDOWN_TICKS);
  assert.ok(
    mate.nextPregnancyTick >= tick + PREGNANCY_ATTEMPT_COOLDOWN_TICKS,
    'mate cooldown must also be set on conception',
  );
});

test('isPregnancyEligible matches all bail conditions exactly', () => {
  const { pop } = makePopulation();
  assert.equal(pop.isPregnancyEligible(makeAdult()), true);
  for (const [, override] of RECHECK_BAIL_CASES) {
    assert.equal(pop.isPregnancyEligible(makeAdult(override)), false);
  }
});
