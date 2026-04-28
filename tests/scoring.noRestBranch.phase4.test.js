import test from 'node:test';
import { strict as assert } from 'node:assert';

// scoring.js → simulation.js → environment.js asserts on AIV_TERRAIN /
// AIV_CONFIG at module-load time. Mirror the stubs other tests use.
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

const { policy } = await import('../src/policy/policy.js');
const { score } = await import('../src/ai/scoring.js');

test('B10: energyRestBonus removed from policy.style.jobScoring', () => {
  assert.ok(!('energyRestBonus' in policy.style.jobScoring),
    'energyRestBonus knob must be deleted from DEFAULT_JOB_STYLE');
});

test('B10: scoring a "rest"-type job for a fatigued villager does not throw', () => {
  // Rest is not a real job type — the audit removed the dead branch.
  // This test guards against accidentally re-adding rest-specific scoring,
  // and verifies the function still produces a finite score for a job whose
  // type doesn't match any branch.
  const job = { type: 'rest', prio: 0.5, distance: 0 };
  const villager = { x: 0, y: 0, energy: 0.1, happy: 0.5, hunger: 0.3 };
  const value = score(job, villager, policy, null);
  assert.ok(Number.isFinite(value), `score must be finite, got ${value}`);
});

test('B10: a fatigued villager scoring a heavy job still incurs the heavy penalty', () => {
  // Regression guard for the surrounding fatigue branch — only the rest-type
  // sub-branch was removed; the heavy-job penalty path must still fire.
  const lowEnergyVillager = { x: 0, y: 0, energy: 0.1, happy: 0.5, hunger: 0.3 };
  const restedVillager = { x: 0, y: 0, energy: 0.9, happy: 0.5, hunger: 0.3 };
  const heavyJob = { type: 'chop', prio: 0.5, distance: 0 };
  const lowScore = score(heavyJob, lowEnergyVillager, policy, null);
  const highScore = score(heavyJob, restedVillager, policy, null);
  assert.ok(highScore > lowScore,
    `rested villager must score heavy job higher than fatigued (low=${lowScore}, high=${highScore})`);
});
