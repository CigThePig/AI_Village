import test from 'node:test';
import { strict as assert } from 'node:assert';

// Mirrors the energy-delta composition at src/app/villagerTick.js:146-167
// after the B8 fix. The fix multiplies the hydration factor against the drain
// only, then adds the mood-energy boost — so the mood term must contribute
// identically regardless of hydration state.
const ENERGY_DRAIN_BASE = 0.0011;
const HYDRATION_FATIGUE_BONUS = 0.8;
const HYDRATION_DEHYDRATED_PENALTY = 1.12;

function computeEnergyDelta({ moodEnergyBoost, hydratedBuff, dehydrated }) {
  let energyDelta = -ENERGY_DRAIN_BASE;
  if (hydratedBuff) energyDelta *= HYDRATION_FATIGUE_BONUS;
  else if (dehydrated) energyDelta *= HYDRATION_DEHYDRATED_PENALTY;
  energyDelta += moodEnergyBoost;
  return energyDelta;
}

test('B8: mood-energy boost adds linearly regardless of hydration state', () => {
  const moodEnergyBoost = 0.00045; // happy=1.0, moodMotivation*0.00045
  const cases = [
    { hydratedBuff: false, dehydrated: false, label: 'neutral' },
    { hydratedBuff: true, dehydrated: false, label: 'hydrated' },
    { hydratedBuff: false, dehydrated: true, label: 'dehydrated' },
  ];
  for (const c of cases) {
    const withBoost = computeEnergyDelta({ ...c, moodEnergyBoost });
    const withoutBoost = computeEnergyDelta({ ...c, moodEnergyBoost: 0 });
    assert.ok(Math.abs((withBoost - withoutBoost) - moodEnergyBoost) < 1e-12,
      `${c.label}: mood boost contribution must equal moodEnergyBoost (got ${withBoost - withoutBoost})`);
  }
});

test('B8: hydration multiplies the drain only, not the mood boost', () => {
  const moodEnergyBoost = 0.00045;
  const hydrated = computeEnergyDelta({ moodEnergyBoost, hydratedBuff: true, dehydrated: false });
  const expected = -ENERGY_DRAIN_BASE * HYDRATION_FATIGUE_BONUS + moodEnergyBoost;
  assert.ok(Math.abs(hydrated - expected) < 1e-12,
    `hydrated delta must be drain*0.8 + mood boost, got ${hydrated}, expected ${expected}`);
});

test('B8: happy + hydrated villager strictly drains less than unhappy + hydrated', () => {
  // The pre-fix bug had the hydration multiplier scale the mood boost too,
  // shrinking happy villagers' net gain. Post-fix, mood boost is unaffected,
  // so a happy villager always nets a more positive (less negative) delta
  // than an unhappy one at the same hydration.
  const happyHydrated = computeEnergyDelta({ moodEnergyBoost: 0.00045, hydratedBuff: true, dehydrated: false });
  const unhappyHydrated = computeEnergyDelta({ moodEnergyBoost: -0.00045, hydratedBuff: true, dehydrated: false });
  assert.ok(happyHydrated > unhappyHydrated,
    `happy+hydrated (${happyHydrated}) must drain less than unhappy+hydrated (${unhappyHydrated})`);
  // And the difference equals 2*moodEnergyBoost (linear contribution).
  assert.ok(Math.abs((happyHydrated - unhappyHydrated) - 0.0009) < 1e-12,
    'mood boost difference must contribute linearly');
});
