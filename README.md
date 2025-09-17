# AI Village (Pixel Edition)

This repository hosts the static build of the AI Village pixel edition experience served from GitHub Pages at <https://cigthepig.github.io/AI_Village/>.

## DebugKit overlay

* Visit the site with `?debug=1` appended to the URL (for example, <https://cigthepig.github.io/AI_Village/?debug=1>) or set `localStorage.debug` to `true` to enable the DebugKit overlay.
* The overlay loads the `debugkit.js` script directly from the repository root. Any changes merged into `main` are automatically deployed with the workflow below, so the latest script is always available at <https://cigthepig.github.io/AI_Village/debugkit.js>.

## Sub-tile ground helpers (feature flag via `?sub=`)

Added constants:

* `GROUND_SUBDIV`
* `MICRO_W`
* `MICRO_H`
* `MICRO_PX`
* `WATER_BLOCK_THRESHOLD`
* `SHOW_MICRO_OVERLAY`

Added functions:

* `getQueryParam(name)`
* `microIdx(tx, ty, sx, sy)`
* `fillMicroTile(tx, ty, type)`
* `syncMicroTileAt(tx, ty)`
* `waterFractionAtTile(tx, ty)`
* `rebuildMicroFromTiles()`
* `carveRiversMicro(seed)`
* `encodeGroundMicro(arr)`
* `decodeGroundMicro(str)`
* `groundImageForType(t)`
* `drawMicroDebugOverlay(bounds)`

## GitHub Pages deployment

A GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) deploys the site automatically whenever changes land on `main`:

1. Check out the repository.
2. Upload the repository contents (excluding files listed in `.gpagesignore`).
3. Publish the artifact to GitHub Pages.

You can also trigger a deployment manually from the *Actions* tab using the **Run workflow** button.

> **Note**
> The workflow requires GitHub Pages to be configured for the repository. From the repository settings, set the deployment source to "GitHub Actions".
