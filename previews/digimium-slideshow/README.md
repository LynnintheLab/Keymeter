# Digimium ad slideshow — approval preview

Five short Burmese slides for a proposed Keymeter post-check advertisement.
This folder is isolated: the checker does not import it and its Check button is unchanged.

## Review

From this folder run `npm run dev`, then open the local URL printed by the server.
The root page is a popup-sized approval preview. Use the previous/next controls,
arrow keys or swipe. The built-in Present button opens presenter/audience mode.
`npm run present` serves the raw composition with the HyperFrames presentation UI.

`review.jpg` is an overview; the `stills` folder contains a full-size still of every slide.
All fonts, images and playback scripts are local. The mobile preview uses a portrait layout with the same copy and artwork; regenerate it with `npm run prepare:mobile` after editing the desktop source.

## Content

1. Apps in one place: ChatGPT, Gemini, Adobe, Netflix and Spotify.
2. Choice across AI, creative and entertainment products.
3. Choose product/plan, then send the prepared Telegram order.
4. Confirm plan, price and payment instructions in Telegram.
5. Fair-price positioning and a link to the current store options.

See `COPY.md` for verified source links and claim constraints.
No price comparison, discount, stock guarantee or named payment service is implied.

## Proposed integration, after approval

- Start the real balance lookup when Check is pressed; run it behind the ad.
- Show this slideshow in a responsive dialog, with an immediately available Close/View balance action.
- Allow manual navigation and, if approved, gentle timed advances with a pause control.
- Never delay or gate the result behind a countdown or advertisement click.
- Every store CTA opens `https://buywith-digimium.store/`; it never receives a customer's API key.
- Respect reduced-motion preferences and pause hidden-page motion.

No automatic popup, ad frequency rule or production integration is included in this preview.

## Checks

`npm run check` runs HyperFrames static, runtime, contrast and layout checks on the composition.
`npm run snapshot` captures a still at the middle of each slide.

## Local runtime assets

`vendor/hyperframes-*.global.js`: HyperFrames 0.7.84, Apache-2.0 license (included in `vendor/HYPERFRAMES-LICENSE`).
`vendor/gsap.min.js`: GSAP 3.14.2; its upstream license notice is retained in the file.
Brand artwork and Walone Myanmar font are copied from the existing project assets;
their original source references remain in `../../public/digimium/README.md`.

## Validation result

Both desktop and portrait compositions pass static, runtime, layout and WCAG text-contrast checks at all five slide hold points. Four authoring warnings remain: repeated brand artwork and composition file length. They were reviewed against the rendered stills; all logos appear correctly. This preview uses large headings and the existing Myanmar font intentionally. The desktop browser controller was unavailable, so manual browser interaction was not claimed as verified.
