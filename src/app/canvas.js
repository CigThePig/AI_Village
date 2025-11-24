import { CAMERA_MAX_Z, CAMERA_MIN_Z, GRID_H, GRID_W, TILE } from './constants.js';
import { reportFatal } from './storage.js';

const canvas = document.getElementById('game');

function context2d(canvas, opts){
  if (!canvas || typeof canvas.getContext !== 'function'){
    reportFatal(new Error('Unable to access a 2D drawing surface.'));
    return null;
  }

  let context = null;
  let lastError = null;

  if (opts){
    try {
      context = canvas.getContext('2d', opts) || null;
    } catch (err){
      lastError = err;
    }
  }

  if (!context){
    const shouldRetryWithoutAlpha = opts && Object.prototype.hasOwnProperty.call(opts, 'alpha') && opts.alpha === false;
    if (shouldRetryWithoutAlpha || !opts){
      try {
        context = canvas.getContext('2d') || null;
      } catch (err){
        if (!lastError) lastError = err;
      }
    }
  }

  if (!context){
    const details = [];
    if (opts){
      try { details.push(`options=${JSON.stringify(opts)}`); }
      catch (e){ details.push('options=[unserializable]'); }
    } else {
      details.push('options=default');
    }
    if (lastError){
      details.push(`error=${lastError.message || lastError}`);
    }
    const message = `Unable to acquire 2D rendering context (${details.join(', ')}).`;
    if (lastError){
      console.error(message, lastError);
    } else {
      console.error(message);
    }
    reportFatal(new Error(message));
    return null;
  }

  try {
    context.imageSmoothingEnabled = false;
  } catch (err){
    console.warn('Unable to configure image smoothing on context:', err);
  }
  return context;
}

const ctx = context2d(canvas, { alpha:false });
canvas.style.touchAction = 'none';
let DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
let W=0, H=0;
let cam = { x:0, y:0, z:2.2 };
const MIN_Z=CAMERA_MIN_Z, MAX_Z=CAMERA_MAX_Z;

function resize(){
  DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  W = Math.floor(rect.width * DPR);
  H = Math.floor(rect.height * DPR);
  canvas.width = W;
  canvas.height = H;
}
resize();
window.addEventListener('resize', resize);

function clampCam(){
  const maxX = GRID_W - W / (TILE * cam.z);
  const maxY = GRID_H - H / (TILE * cam.z);
  cam.x = Math.max(0, Math.min(cam.x, Math.max(0, maxX)));
  cam.y = Math.max(0, Math.min(cam.y, Math.max(0, maxY)));
}

export {
  MIN_Z,
  MAX_Z,
  DPR,
  H,
  W,
  cam,
  canvas,
  clampCam,
  context2d,
  ctx,
  resize
};
