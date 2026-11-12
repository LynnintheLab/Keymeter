# Project notes

Updated: 2026-11-13

## Current status

Keymeter full has a Digimium advertisement beside the key checker. API packages appear below the checker and history. The advertisement links to the Digimium store, uses its blue brand background, and displays the requested Myanmar description.

## Last thing done

- Added independently floating ChatGPT, Gemini, Photoshop, Lightroom, Evoto, RunningHub, Spotify and Netflix logos using original assets.
- Added a pause control, reduced-motion support, and automatic pausing when the advertisement is offscreen or the tab is hidden.
- Kept the balance gauge, billing connection, pricing administration and contact popup behavior intact.
- Wrote `DIGIMIUM-MOTION-PROMPT.md` for a future generated video; the current banner uses CSS motion.
- Verified TypeScript, the Hostinger production build, pricing tests, and all eight Hostinger tests. Browser checks passed for mobile overflow, logo bounds throughout motion, animation controls, reduced motion, pricing placement and the contact dialog.

## Next steps

- Redeploy the latest `main` commit on Hostinger if automatic deployment is disabled.
- To try a video banner, use `DIGIMIUM-MOTION-PROMPT.md` with the assets in `public/digimium/`. Review the generated loop before replacing the CSS scene.
