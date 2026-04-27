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

test('haul jobs for the same building but different resources both persist', () => {
  const { state, sys } = makeSystem();
  const wood = sys.addJob({ type: 'haul', bid: 1, resource: 'wood', qty: 5, x: 0, y: 0 });
  const stone = sys.addJob({ type: 'haul', bid: 1, resource: 'stone', qty: 3, x: 0, y: 0 });
  assert.ok(wood, 'wood haul should be added');
  assert.ok(stone, 'stone haul should be added');
  assert.equal(state.units.jobs.length, 2);
});

test('duplicate same-resource haul for the same building collapses', () => {
  const { state, sys } = makeSystem();
  const first = sys.addJob({ type: 'haul', bid: 1, resource: 'wood', qty: 5, x: 0, y: 0 });
  const second = sys.addJob({ type: 'haul', bid: 1, resource: 'wood', qty: 2, x: 0, y: 0 });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(state.units.jobs.length, 1);
});

test('cancelled haul tombstone does not block a fresh haul of the same kind', () => {
  const { state, sys } = makeSystem();
  const first = sys.addJob({ type: 'haul', bid: 1, resource: 'wood', qty: 5, x: 0, y: 0 });
  assert.ok(first);
  first.cancelled = true;
  const replacement = sys.addJob({ type: 'haul', bid: 1, resource: 'wood', qty: 5, x: 0, y: 0 });
  assert.ok(replacement, 'fresh haul should succeed when prior is cancelled');
  assert.equal(state.units.jobs.length, 2);
});

test('hunt suppression follows the animal id, not its position', () => {
  const { sys, state } = makeSystem();
  sys.suppressJob({ type: 'hunt', targetAid: 7, x: 1, y: 1, bid: 1 }, 100);
  const blocked = sys.addJob({ type: 'hunt', targetAid: 7, x: 5, y: 9, bid: 1 });
  assert.equal(blocked, null, 'suppression should follow targetAid across position changes');
  assert.equal(state.units.jobs.length, 0);
});

test('hunt suppression expires once the tick deadline passes', () => {
  const { state, sys } = makeSystem();
  sys.suppressJob({ type: 'hunt', targetAid: 7, x: 1, y: 1, bid: 1 }, 100);
  state.time.tick = 101;
  const job = sys.addJob({ type: 'hunt', targetAid: 7, x: 5, y: 9, bid: 1 });
  assert.ok(job, 'expired suppression should not block new hunt');
});

test('build jobs dedupe by building id', () => {
  const { state, sys } = makeSystem();
  const a = sys.addJob({ type: 'build', bid: 42, x: 3, y: 4 });
  const b = sys.addJob({ type: 'build', bid: 42, x: 3, y: 4 });
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(state.units.jobs.length, 1);
});

test('craft_bow jobs dedupe by lodge id', () => {
  const { state, sys } = makeSystem();
  const a = sys.addJob({ type: 'craft_bow', bid: 9, x: 2, y: 2, materials: { wood: 2 } });
  const b = sys.addJob({ type: 'craft_bow', bid: 9, x: 2, y: 2, materials: { wood: 2 } });
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(state.units.jobs.length, 1);
});

test('zone jobs (sow/chop/mine/forage) dedupe by tile coordinates', () => {
  const { sys } = makeSystem();
  assert.ok(sys.addJob({ type: 'sow', x: 1, y: 2 }));
  assert.equal(sys.addJob({ type: 'sow', x: 1, y: 2 }), null);
  assert.ok(sys.addJob({ type: 'sow', x: 1, y: 3 }));
  assert.ok(sys.addJob({ type: 'forage', x: 1, y: 2, targetI: 100 }));
  assert.equal(sys.addJob({ type: 'forage', x: 1, y: 2, targetI: 100 }), null);
});

test('getJobIdentity returns null for unknown job types so they cannot silently collapse', () => {
  const { sys } = makeSystem();
  assert.equal(sys.getJobIdentity({ type: 'mystery', x: 0, y: 0 }), null);
  assert.equal(sys.getJobIdentity(null), null);
  assert.equal(sys.getJobIdentity({}), null);
});
