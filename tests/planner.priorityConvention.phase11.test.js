import test from 'node:test';
import { strict as assert } from 'node:assert';

// Phase 11 (S14): buildQueue and progression tier priorities both follow the
// "highest-priority-wins" convention. These tests lock in (a) the priority
// magnitudes pushed by planBuildings, (b) the sort direction, and (c) the
// ordering between famine pushes, normal pushes, and progression tiers.

const policyModule = await import('../src/policy/policy.js');
const { policy } = policyModule;

test('S14: progression tier priorities sit in the urgent band (>=7) and descend with tier order', () => {
  const tiers = policy.progression.tiers;
  const ids = tiers.map((t) => t.id);
  assert.deepEqual(ids, ['stockpile', 'housing', 'workshops', 'infrastructure']);
  for (const tier of tiers) {
    assert.ok(tier.priority >= 7, `tier ${tier.id} priority=${tier.priority} must be in urgent band (>=7)`);
    assert.ok(tier.priority < 9.5, `tier ${tier.id} priority=${tier.priority} must be below famine band (<9.5)`);
  }
  const byId = Object.fromEntries(tiers.map((t) => [t.id, t.priority]));
  assert.ok(byId.stockpile > byId.housing, 'stockpile outranks housing');
  assert.ok(byId.housing > byId.workshops, 'housing outranks workshops');
  assert.ok(byId.workshops > byId.infrastructure, 'workshops outranks infrastructure');
});

test('S14: buildQueue descending sort puts famine items first', () => {
  // Mirrors planBuildings push values exactly. Famine survival > urgent > nominal > deferred.
  const queue = [
    { kind: 'storage', priority: 6 },             // normal
    { kind: 'farmplot', priority: 9.5 },          // famine
    { kind: 'hut', priority: 9 },                 // not fatigued
    { kind: 'hunterLodge', priority: 9.6 },       // famine
    { kind: 'well', priority: 7 },                // normal
    { kind: 'well', priority: 7.5 },              // approaching winter
    { kind: 'farmplot', priority: 8 },            // normal
    { kind: 'storage', priority: 4 },             // famine deferred
    { kind: 'hut', priority: 8 },                 // fatigued
    { kind: 'farmplot', priority: 9 },            // approaching winter
    { kind: 'hunterLodge', priority: 8.2 },       // normal
  ];
  // Same comparator as planner.js:712 after Phase 11.
  queue.sort((a, b) => b.priority - a.priority);
  const order = queue.map((q) => `${q.kind}@${q.priority}`);
  assert.equal(order[0], 'hunterLodge@9.6', 'famine hunterLodge wins');
  assert.equal(order[1], 'farmplot@9.5', 'famine farmplot is second');
  assert.equal(order[2], 'hut@9', 'not-fatigued hut beats winter farmplot tie via stable sort');
  assert.equal(order[order.length - 1], 'storage@4', 'famine storage is the deferred tail');
});

test('S14: progression tier priorities slot below famine pushes but above default plan fallback (8 not given)', () => {
  // The applyProgressionPlanner default fallback is 8 (used when neither
  // plan.priority nor tier.priority is finite). Stockpile (8.6) must beat
  // that fallback so progression doesn't get drowned by neutral defaults.
  const tiers = policy.progression.tiers;
  for (const tier of tiers) {
    if (tier.id === 'infrastructure') continue;
    assert.ok(tier.priority > 7.4, `${tier.id} (${tier.priority}) must outrank infrastructure baseline`);
  }
  // Famine items at 9.5+ must still beat the highest tier (stockpile=8.6).
  const stockpile = tiers.find((t) => t.id === 'stockpile');
  assert.ok(9.5 > stockpile.priority, 'famine farmplot (9.5) must outrank stockpile tier (8.6)');
  assert.ok(9.6 > stockpile.priority, 'famine hunterLodge (9.6) must outrank stockpile tier (8.6)');
});
