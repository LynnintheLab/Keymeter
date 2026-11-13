# Digimium ad slideshow — approval preview

Four short Burmese slides for a proposed Keymeter post-check advertisement.
This folder preserves the original authoring/approval preview. Following approval,
the production checker renders the same four slides as a responsive native React
dialog in `app/digimium-slideshow.tsx`. Its prominent **Skip ad** button dismisses
the ad immediately while the balance lookup continues. The preview controls below
describe the retained authoring player, not the production dialog.

## Review

From this folder run `npm run dev`, then open the local URL printed by the server.
The root page is a popup-sized approval preview. Use the previous/next controls,
arrow keys or swipe. The built-in Present button opens presenter/audience mode.
`npm run present` serves the raw composition with the HyperFrames presentation UI.

The popup is labeled **ကြော်ငြာ · Ad** and has a visible **Next slide →** button.
The Close button appears when slide 2 is reached or a Digimium store link is
clicked, whichever happens first. Going back preserves that button for the
current opening; reopening restarts on slide 1. The browser's Escape and backdrop
dismissal remain available. A store link is visible below every slide.

`review.jpg` is an overview; the `stills` folder contains a full-size still of every slide.
All fonts, images and playback scripts are local. The mobile preview uses a portrait layout with the same copy and artwork; regenerate it with `npm run prepare:mobile` after editing the desktop source.

The design follows the store's white background, dark text and blue `#1f45b8`
accent, using Manrope and Walone Myanmar. Product logos are shown directly with
their names, without extra tiles, frames or shadows. Photoshop and Lightroom use
clean Adobe SVG artwork instead of the older images with baked-in white corners.

## Content

1. Apps in one place: ChatGPT, Gemini, Adobe, Netflix and Spotify.
2. Choose product/plan, then send the prepared Telegram order.
3. Payment, plan details and step-by-step usage guidance.
4. Fair-price positioning and a link to the current store options.

See `COPY.md` for verified source links and claim constraints.
No price comparison, discount, stock guarantee or named payment service is implied.

## Production integration

- Start the real balance lookup when Check is pressed; run it behind the ad.
- Show the approved visuals in a responsive native dialog: Skip ad is always available, and the additional Close button becomes visible on slide 2 or after a store-link click.
- Support manual navigation and six-second timed advances with a pause control. Manual navigation pauses automatic advancement.
- Never delay or gate the result behind a countdown or advertisement click.
- Every store CTA opens `https://buywith-digimium.store/`; it never receives a customer's API key.
- Respect reduced-motion preferences and pause hidden-page motion.

The production popup opens on valid Check submissions. This authoring page remains independently runnable.

## Checks

`npm run check` runs HyperFrames static, runtime, contrast and layout checks on the composition.
`npm run snapshot` captures a still at the middle of each slide.

## Local runtime assets

`vendor/hyperframes-*.global.js`: HyperFrames 0.7.84, Apache-2.0 license (included in `vendor/HYPERFRAMES-LICENSE`).
`vendor/gsap.min.js`: GSAP 3.14.2; its upstream license notice is retained in the file.
Brand artwork and Walone Myanmar font are copied from the existing project assets;
their original source references remain in `../../public/digimium/README.md`.
Manrope font files and the theme reference come from the
[Digimium store production source](https://github.com/LynnintheLab/digimium_website_final/tree/production).
Adobe artwork: [Photoshop](https://www.adobe.com/cc-shared/assets/img/product-icons/svg/photoshop-40.svg)
and [Lightroom](https://www.adobe.com/cc-shared/assets/img/product-icons/svg/lightroom.svg).

## Validation result

Both desktop and portrait compositions pass runtime and layout checks at all four
slide hold points, with 45/45 WCAG AA text-contrast checks passing in each layout.
Static checks report no errors and four reviewed authoring warnings for reused
brand artwork and composition file length. Rendered desktop and portrait stills
were visually reviewed. Headless Chrome also verifies slide navigation, Close and
reopen controls, and no horizontal page overflow at desktop and mobile sizes.
Explicit slide start/end times support the standalone preview player.
The control revision is also browser-checked at desktop, mobile and narrow-mobile
sizes, including Close visibility, reopening, native Next navigation and the fixed
store destination. Store navigation inside the sandboxed preview iframe is handled
by its parent in the click gesture; no customer data is appended to the link.
