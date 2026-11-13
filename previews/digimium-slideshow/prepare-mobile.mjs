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
.topline{top:46px;left:56px;right:56px}
.brand{width:260px;height:90px;padding:15px 20px}
.brand img{width:220px}
.page-topic{display:none}
.content{left:56px;right:56px;top:200px;bottom:auto;display:flex;flex-direction:column;gap:38px;align-items:stretch}
.copy h1{font-size:70px;line-height:1.6;max-width:788px}
.sub{font-size:42px;line-height:1.7;margin-top:25px;max-width:788px}
.detail{display:none}
.visual{height:570px;width:100%;flex-shrink:0;align-self:stretch}
.footer{left:56px;right:56px;bottom:50px;padding-top:28px;gap:20px}
.footer p{font-size:40px}.slide-count{font-size:40px;gap:10px}.slide-count i{width:20px}
.logo-cloud{height:600px;max-width:720px;margin:auto}
.cloud-label{left:210px;top:274px;font-size:48px;line-height:1.4}
.category-list{height:auto;gap:22px}.category{padding:26px}
.order-visual{height:560px}.order-path{padding-bottom:30px}
.order-sheet{padding:30px}.sent-note{padding-top:32px}
.chat-visual{height:650px;padding:30px}
.chat-bubble{font-size:40px;margin-top:24px;padding:22px}
.confirm-line{font-size:40px}
.price-visual{height:520px}.choice-card{padding:28px}
.choice-title{font-size:42px}.choice-line{padding:8px 0}
.choice-logos{margin:20px 0}.choice-logos .app-tile{width:90px;height:90px}
.choice-logos img{width:66px;height:66px}.shop-tag{display:none}
.store-cta{font-size:40px;margin-top:30px;padding:18px 26px}
`;
const mobile = desktop
  .replaceAll('data-width="1920"', 'data-width="900"')
  .replaceAll('data-height="1080"', 'data-height="1500"')
  .replace('width=1920, height=1080', 'width=900, height=1500')
  .replace('</style>', `${portraitCSS}</style>`);
await writeFile(new URL('index.html', mobileDir), mobile.split('\n').map(line => line.trimEnd()).join('\n'));
