import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';

// Keep copy and logos in one authored source. Only the mobile layout changes.
const desktop = await readFile(new URL('composition/index.html', import.meta.url), 'utf8');
const mobileDir = new URL('composition-mobile/', import.meta.url);
await mkdir(mobileDir, { recursive: true });
for (const folder of ['assets', 'vendor']) {
  await cp(new URL(`composition/${folder}/`, import.meta.url), new URL(`${folder}/`, mobileDir), { recursive: true });
}
const portraitCSS = `
html,body,.scene-frame{width:900px;height:1500px}
.topline{top:42px;left:56px;right:56px;height:100px;padding-bottom:24px}
.brand,.brand img{width:250px}
.content{left:56px;right:56px;top:208px;bottom:auto;display:flex;flex-direction:column;gap:54px;align-items:stretch}
.copy h1{font-size:66px;line-height:1.65;max-width:788px}
.sub{font-size:38px;line-height:1.85;margin-top:24px;max-width:788px}
.visual{height:520px;width:100%;flex-shrink:0;align-self:stretch}
.footer{left:56px;right:56px;bottom:48px;padding-top:27px;gap:20px}
.footer p{font-size:30px}.slide-count{font-size:28px;gap:10px}.slide-count i{width:16px}
.logo-cloud{height:490px;margin-top:20px;gap:30px 28px}
.logo-cloud .app-tile{gap:20px}.logo-cloud .app-tile img{width:116px;height:116px}
.logo-cloud .app-name{font-size:29px}
.category-list{height:auto}.category{padding:32px 0;gap:32px}
.category strong{font-size:42px}.category p{font-size:32px}
.order-visual{height:540px;padding-top:0}.order-path{padding-bottom:32px;font-size:32px}
.order-sheet{padding:30px}.sheet-label{font-size:34px}
.send-bar{font-size:34px}.product-line{padding:32px 0}
.chat-visual{height:610px;padding:30px}
.chat-bubble{font-size:34px;margin-top:24px;padding:22px}
.confirm-line{font-size:34px}.chat-title strong{font-size:36px}
.price-visual{height:auto}.choice-card{padding:0}
.choice-title{font-size:38px}.choice-line{font-size:34px;padding:18px 0}
.choice-logos{margin:22px 0 30px}.choice-logos .app-tile{width:76px;height:76px}
.store-cta{font-size:34px;margin-top:28px;padding:19px 26px}
`;
const mobile = desktop
  .replaceAll('data-width="1920"', 'data-width="900"')
  .replaceAll('data-height="1080"', 'data-height="1500"')
  .replace('width=1920, height=1080', 'width=900, height=1500')
  .replace('</style>', `${portraitCSS}</style>`);
await writeFile(new URL('index.html', mobileDir), mobile.split('\n').map(line => line.trimEnd()).join('\n'));
