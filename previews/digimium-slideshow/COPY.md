# Digimium popup slideshow copy

Status: **approval-only preview**. This copy does not change the live Keymeter checker, its Check action, or its billing connection. Integration waits for the owner's approval. Headlines may be shortened by the layout author without changing the verified meaning.

Destination for every store CTA: <https://buywith-digimium.store/>

## Slide 1 — What customers can buy

Headline:

> AI၊ Creative နဲ့ Entertainment  
> တစ်နေရာတည်းမှာ

Supporting copy:

> ChatGPT · Gemini · Adobe Creative Cloud · Netflix · Spotify

Visual: Digimium wordmark with freely floating representative product logos on the brand-blue background.

## Slide 2 — Easy purchase

Headline:

> ရွေးမယ်။ Order ပို့မယ်။

Supporting copy:

> Product ရွေး → Plan ရွေး → Telegram မှာ Send

Visual: Three simple steps, showing that checkout prepares an order for the customer to send in Telegram.

## Slide 3 — Payment confirmation

Headline:

> ငွေမပေးခင်  
> အရင်အတည်ပြုမယ်

Supporting copy:

> Plan၊ ဈေးနှုန်းနဲ့ ငွေပေးချေနည်းကို Telegram မှာ အတည်ပြုပေးပါတယ်။

Visual: An order card and a Telegram confirmation cue. Do not show payment-provider logos.

## Slide 4 — Variety of choices

Headline:

> ကိုယ်နဲ့ကိုက်တာ  
> စိတ်ကြိုက်ရွေးပါ

Supporting copy:

> အလုပ်အတွက်၊ ဖန်တီးမှုအတွက်၊ အပန်းဖြေဖို့အတွက်

Visual: AI / Creative / Entertainment groups with representative verified brands.

## Slide 5 — Clear prices and store CTA

Headline:

> သင့်တော်တဲ့ Plan၊  
> ရှင်းလင်းတဲ့ ဈေးနှုန်း

Supporting copy:

> လက်ရှိ Plan နဲ့ ဈေးနှုန်းကို အရင်မေးမြန်းပြီး ဝယ်ယူနိုင်ပါတယ်။

Primary CTA: **Visit Digimium ↗**

Visual: Digimium wordmark, a concise product selection, and one clear store button.

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
