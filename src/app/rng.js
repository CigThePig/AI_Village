function mulberry32(seed) { return function(){ let t=seed+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61);
return ((t^t>>>14)>>>0)/4294967296; } }

let R = Math.random;

const irnd=(a,b)=> (R()*(b-a+1)|0)+a;
const rnd=(a,b)=> R()*(b-a)+a;
const clamp=(v,mi,ma)=>v<mi?mi:(v>ma?ma:v);
function uid() {
  try { return (crypto.getRandomValues(new Uint32Array(1))[0]>>>0); }
  catch { return Math.floor(Math.random()*2**31); }
}

function setRandomSource(value) {
  R = value;
}

// Stateless 32-bit integer hash for deterministic per-tile/per-id picks. Does
// not touch the global R, so safe to call from render hot paths and bake steps.
function hash2(x, y = 0, z = 0) {
  let h = (x | 0) ^ Math.imul((y | 0), 0x85ebca77) ^ Math.imul((z | 0), 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

// Returns a fresh deterministic float-RNG closure seeded from `seed`. Used at
// asset-bake time so per-variant noise is reproducible without disturbing R.
function seededFrom(seed) {
  return mulberry32((seed >>> 0) || 1);
}

export {
  R,
  clamp,
  hash2,
  irnd,
  mulberry32,
  rnd,
  seededFrom,
  setRandomSource,
  uid
};
