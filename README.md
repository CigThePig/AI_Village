# AI Village (Pixel Edition)

This repository hosts the static build of the AI Village pixel edition experience served from GitHub Pages at <https://cigthepig.github.io/AI_Village/>.

## DebugKit overlay

* Visit the site with `?debug=1` appended to the URL (for example, <https://cigthepig.github.io/AI_Village/?debug=1>) or set `localStorage.debug` to `true` to enable the DebugKit overlay.
* The overlay loads the `debugkit.js` script from the deployed site. The source lives at `public/debugkit.js`; Vite copies it verbatim into `dist/debugkit.js` at build time, so any changes merged into `main` are automatically deployed and the latest script is always available at <https://cigthepig.github.io/AI_Village/debugkit.js>.

## GitHub Pages deployment

A GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) deploys the site automatically whenever changes land on `main`:

1. Check out the repository.
2. Run `npm ci` and `npm run build` to produce the Vite `dist/` bundle.
3. Upload `dist/` as the GitHub Pages artifact and publish it.

You can also trigger a deployment manually from the *Actions* tab using the **Run workflow** button.

> **Note**
> The workflow requires GitHub Pages to be configured for the repository. From the repository settings, set the deployment source to "GitHub Actions".
