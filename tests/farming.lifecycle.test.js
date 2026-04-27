import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { createJobsSystem } from '../src/app/jobs.js';

function makeSystem() {
  const state = {
    units: { jobs: [], villagers: [] },
    time: { tick: 0 },
    stocks: { totals: {}, reserved: {} }
  };
  const policy = { style: {}, sliders: {} };
  const sys = createJobsSystem({ state, policy });
  return { state, sys };
}

test('harvest jobs dedupe by tile coordinates', () => {
  const { state, sys } = makeSystem();
  const first = sys.addJob({ type: 'harvest', x: 5, y: 5, prio: 0.65 });
  const second = sys.addJob({ type: 'harvest', x: 5, y: 5, prio: 0.7 });
  assert.ok(first, 'first harvest job should be added');
  assert.equal(second, null, 'duplicate harvest at same tile should not be added');
  assert.equal(state.units.jobs.length, 1);
});

test('harvest re-emits after the prior job is removed from the queue', () => {
  const { state, sys } = makeSystem();
  const first = sys.addJob({ type: 'harvest', x: 5, y: 5 });
  assert.ok(first);
  state.units.jobs.length = 0;
  const replacement = sys.addJob({ type: 'harvest', x: 5, y: 5 });
  assert.ok(replacement, 'fresh harvest should succeed once the prior is gone');
  assert.equal(state.units.jobs.length, 1);
});

test('harvest re-emits after the prior job is cancelled', () => {
  const { state, sys } = makeSystem();
  const first = sys.addJob({ type: 'harvest', x: 5, y: 5 });
  assert.ok(first);
  first.cancelled = true;
  const replacement = sys.addJob({ type: 'harvest', x: 5, y: 5 });
  assert.ok(replacement, 'cancelled tombstone must not block a fresh harvest');
  assert.equal(state.units.jobs.length, 2);
});

test('harvest and sow at the same tile coexist', () => {
  const { state, sys } = makeSystem();
  const sow = sys.addJob({ type: 'sow', x: 5, y: 5 });
  const harvest = sys.addJob({ type: 'harvest', x: 5, y: 5 });
  assert.ok(sow, 'sow at (5,5) should be added');
  assert.ok(harvest, 'harvest at (5,5) should be added alongside sow');
  assert.equal(state.units.jobs.length, 2);
});

test('harvest suppression follows tile coordinates and expires on tick', () => {
  const { state, sys } = makeSystem();
  sys.suppressJob({ type: 'harvest', x: 5, y: 5 }, 100);
  const blocked = sys.addJob({ type: 'harvest', x: 5, y: 5 });
  assert.equal(blocked, null, 'suppression should block re-emission until expiry');
  state.time.tick = 101;
  const allowed = sys.addJob({ type: 'harvest', x: 5, y: 5 });
  assert.ok(allowed, 'expired suppression should not block a fresh harvest');
});
