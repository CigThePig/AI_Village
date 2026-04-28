import test from 'node:test';
import { strict as assert } from 'node:assert';

import { BUILDINGS, agricultureBonusesAt } from '../src/app/world.js';

function makeBuilding(kind, overrides = {}) {
  return { id: 1, kind, x: 0, y: 0, built: 1, ...overrides };
}

test('B26: campfire effects no longer carry moodBonus (passive mood removed)', () => {
  // The campfire's passive moodBonus was being triple-counted with the
  // `nearbyWarmth` warm flag and NIGHT_CAMPFIRE_MOOD_TICK. The fix removes the
  // moodBonus from the campfire's effects so agricultureBonusesAt no longer
  // contributes a third source.
  assert.equal(BUILDINGS.campfire.effects.moodBonus, undefined,
    'campfire must not declare moodBonus in effects');
  assert.equal(BUILDINGS.campfire.effects.radius, 4,
    'campfire radius preserved for CAMPFIRE_EFFECT_RADIUS');
});

test('B26: agricultureBonusesAt returns zero moodBonus from a campfire', () => {
  const buildings = [makeBuilding('campfire', { x: 5, y: 5 })];
  // Tile right next to the campfire footprint — well inside its radius=4.
  const bonuses = agricultureBonusesAt(buildings, 5, 5);
  assert.equal(bonuses.moodBonus, 0, 'campfire must not contribute passive moodBonus');
  assert.equal(bonuses.growthBonus, 0);
  assert.equal(bonuses.harvestBonus, 0);
});

test('B26: huts still contribute passive moodBonus via agricultureBonusesAt', () => {
  // Regression guard: only the campfire was supposed to lose its passive
  // moodBonus. Huts and wells must remain mood sources.
  const buildings = [makeBuilding('hut', { x: 5, y: 5 })];
  const bonuses = agricultureBonusesAt(buildings, 5, 5);
  assert.ok(bonuses.moodBonus > 0, 'hut must still contribute moodBonus');
});
