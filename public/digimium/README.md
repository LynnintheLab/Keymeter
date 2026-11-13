# Digimium advertisement assets

The live banner uses original logo assets in an asymmetrical CSS composition with independent floating motion on the Digimium blue brand background. It has a pause control and stops motion offscreen, in hidden tabs, and for reduced-motion preferences. No video or third-party embed is required.

The advertisement links to https://buywith-digimium.store/ in a new tab. The requested Myanmar description is live website text, with a self-hosted Myanmar font.

The post-check popup uses a responsive native React slideshow in `app/digimium-slideshow.tsx`, matching the approved white/blue artwork in `previews/digimium-slideshow/`. Its logos, fonts and illustrations are local; it does not embed a third-party player or pass key data to the store.

## Asset references

- `wordmark.png`, `services/chatgpt.svg`, `services/gemini.svg`, `services/spotify.svg`, `services/netflix.svg`: owner's [Digimium storefront repository](https://github.com/LynnintheLab/digimium_website_final), `production` commit `119ceae`, `public/assets/logo.png` and `public/assets/marks/`. The ChatGPT SVG viewport is trimmed to its original path bounds without changing the artwork.
- `services/photoshop.png` and `services/lightroom.png`: crops of the official app icon sheet in [Adobe's updated app icons](https://adobe.design/ideas/behind-the-design-adobe-s-updated-app-icons).
- `services/evoto.png`: converted from the official [Evoto favicon](https://www.evoto.ai/logo.ico).
- `services/runninghub.png`: converted from the official [RunningHub favicon](https://www.runninghub.ai/favicon.ico?v=1.4).
- `public/fonts/walone-regular.woff2`: copied from the owner's storefront `public/assets/fonts/`; its provenance identifies the supplied Z06-Walone font.
- `services/photoshop.svg`, `services/lightroom.svg`: clean official [Photoshop](https://www.adobe.com/cc-shared/assets/img/product-icons/svg/photoshop-40.svg) and [Lightroom](https://www.adobe.com/cc-shared/assets/img/product-icons/svg/lightroom.svg) artwork, reused from the approved slideshow.
- `public/fonts/digimium-manrope-{400,600}.woff2`: Manrope font files from the owner's Digimium storefront production source, reused from the approved slideshow.

Static concepts were explored with the built-in imagegen tool before the user requested independent motion and the Spotify/Netflix substitution. The current live banner is composed from the original logo assets above.

A separate video-generation prompt and delivery specification are in `DIGIMIUM-MOTION-PROMPT.md` at the repository root. It is a prompt for a future video, not an existing video asset.
