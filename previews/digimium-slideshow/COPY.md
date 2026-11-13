# Digimium popup slideshow copy

Status: **approval-only preview**. This copy does not change the live Keymeter checker, its Check action, or its billing connection. Integration waits for the owner's approval. Headlines may be shortened by the layout author without changing the verified meaning.

Destination for every store CTA: <https://buywith-digimium.store/>

## Final five-slide copy

1. **လိုအပ်တဲ့ App တွေ တစ်နေရာတည်းမှာ ဝယ်ပါ။** — AI · Creative · Entertainment. Representative ChatGPT, Gemini, Adobe, Netflix and Spotify artwork.
2. **ရွေးစရာ App တွေ စုံစုံလင်လင်ရှိပါတယ်။** — အလုပ်အတွက်။ ဖန်တီးဖို့။ အပန်းဖြေဖို့။ Three category rows with real product logos.
3. **ရွေးပါ။ Order ပို့လိုက်ပါ။** — App ရွေး → Plan ရွေး → Telegram မှာ Send. A plan-selection card represents the handoff, not a completed transaction.
4. **ငွေပေးချေဖို့လည်း Chat မှာ ကူညီပေးမယ်။** — Plan၊ ဈေးနှုန်းနဲ့ ငွေပေးချေနည်းကို အရင်အတည်ပြုနိုင်ပါတယ်။ A conceptual Telegram exchange shows payment guidance without naming a provider.
5. **သင့်တင့်တဲ့ဈေးနှုန်းနဲ့ စိတ်ကြိုက်ရွေးဝယ်ပါ။** — ကိုယ်နဲ့ကိုက်တဲ့ Plan နဲ့ လက်ရှိဈေးနှုန်းကို အရင်မေးမြန်းနိုင်ပါတယ်။ CTA: **Digimium မှာ ရွေးကြည့်မယ်**. Fair pricing is the owner's positioning, not a comparative cheapest-price claim.

## Verified source

Repository: <https://github.com/LynnintheLab/digimium_website_final>

Branch reviewed: `production`

Commit reviewed: `60971f09158ecd2a4c188141e58c8370ee7abca7`

- [Storefront purchase steps and payment FAQ](https://github.com/LynnintheLab/digimium_website_final/blob/60971f09158ecd2a4c188141e58c8370ee7abca7/app/storefront.tsx): customers browse, choose a plan, use Add to Cart or Checkout, then send their prepared order in Telegram. Digimium confirms plan, price, and payment options in that chat.
- [Telegram checkout](https://github.com/LynnintheLab/digimium_website_final/blob/60971f09158ecd2a4c188141e58c8370ee7abca7/app/shop-order.tsx): checkout opens an order draft in Telegram; the customer sends the message.
- [Committed catalog](https://github.com/LynnintheLab/digimium_website_final/blob/60971f09158ecd2a4c188141e58c8370ee7abca7/data/catalog.json): representative brands above are present; catalog availability is on request.
- [Product requirements](https://github.com/LynnintheLab/digimium_website_final/blob/60971f09158ecd2a4c188141e58c8370ee7abca7/PRODUCT.md): bilingual subscription catalog, Telegram order handoff, and payment processing deferred.

The live store could not be reached during this research. This preview therefore relies on the committed storefront source, not a claim that current stock or individual plans were verified live.

## Content constraints

- **No named payment providers were verified.** Do not invent or show KBZPay, Wave, bank logos, or other payment brands.
- **Payment details are confirmed via Telegram after the order is sent.** Do not imply that this website processes payments directly.
- **Availability is on request.** Do not promise immediate stock, activation, delivery time, or a specific plan duration.
- **No comparative cheapest or savings claims.** Do not add “cheapest,” “lowest price,” discounts, savings percentages, or guaranteed deals without owner-approved evidence.
- No prices appear in these slides. Current prices and plan details must be confirmed with the store.
- The owner's request for fair pricing is expressed conservatively through suitable plans and clear prices; no market-price comparison was verified.
- RunningHub, Evoto, Photoshop, and Lightroom have existing Keymeter ad assets, but were not separate entries in the committed catalog reviewed. Avoid adding new availability or plan claims for those products without confirmation.
