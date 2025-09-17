export const WORLDGEN_DEFAULTS = {
  heightScale: 0.010,
  moistureScale: 0.015,
  warpScale: 0.040,
  water: { level: 0.32, minLakeSize: 12, maxLakeSize: 220 },
  rivers: {
    count: 2,
    sourceMin: 0.68,
    sourceSpacing: 24,
    widenFlow: [12, 28],
    maxWidth: 4
  },
  ratiosTarget: {
    grass:  [0.55, 0.70],
    forest: [0.15, 0.30],
    water:  [0.08, 0.15],
    rock:   [0.05, 0.12]
  },
  biomes: {
    hSnow: 0.82,
    hRock: 0.70,
    sRock: 0.07,
    mFertile: 0.63,
    mForest: 0.55,
    mSand: 0.35
  },
  forests: { clusterSpacing: 9, clusterRadius: 7 },
  spawn:   { radius: 4 }
};
