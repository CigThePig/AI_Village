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

export {
  R,
  clamp,
  irnd,
  mulberry32,
  rnd,
  setRandomSource,
  uid
};
