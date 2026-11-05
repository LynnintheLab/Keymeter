export const USD_PACKAGES = [10, 20, 30, 40, 50, 100] as const;
export type PackageAmount = typeof USD_PACKAGES[number];
export type PricePackage = { usd: PackageAmount; kyat: number };
export type Pricing = { packages: PricePackage[]; updatedAt: string | null };
export const DEFAULT_PACKAGES: PricePackage[] = [
  { usd: 10, kyat: 62000 }, { usd: 20, kyat: 124000 },
  { usd: 30, kyat: 186000 }, { usd: 40, kyat: 248000 },
  { usd: 50, kyat: 299900 }, { usd: 100, kyat: 588800 },
];
export class PricingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function validatePackages(value: unknown): PricePackage[] {
  if (!Array.isArray(value) || value.length !== USD_PACKAGES.length)
    throw new PricingError(400, 'Enter a price for all six USD packages.');
  const result = new Map<PackageAmount, number>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        !USD_PACKAGES.includes(row.usd) || result.has(row.usd) ||
        !Number.isSafeInteger(row.kyat) || row.kyat < 1 || row.kyat > 1_000_000_000)
      throw new PricingError(400, 'Use each USD package once and whole-number Ks prices from 1 to 1,000,000,000.');
    result.set(row.usd, row.kyat);
  }
  return USD_PACKAGES.map(usd => ({ usd, kyat: result.get(usd)! }));
}
export function packageBadge(usd: number) {
  return usd === 50 ? 'Best Deal' : usd === 100 ? 'Best Value' : '';
}
function requireDb(db: D1Database | undefined): D1Database {
  if (!db) throw new PricingError(503, 'Prices are temporarily unavailable. Contact us for current prices.');
  return db;
}
export async function readPricing(dbInput: D1Database | undefined): Promise<Pricing> {
  const db = requireDb(dbInput);
  try {
    const row = await db.prepare('SELECT value_json, updated_at FROM app_settings WHERE id = ?').bind('pricing')
      .first<{ value_json: string; updated_at: string }>();
    if (!row) return { packages: DEFAULT_PACKAGES.map(row => ({ ...row })), updatedAt: null };
    return { packages: validatePackages(JSON.parse(row.value_json)), updatedAt: row.updated_at };
  } catch {
    throw new PricingError(503, 'Prices are temporarily unavailable. Contact us for current prices.');
  }
}
export async function savePricing(dbInput: D1Database | undefined, input: unknown): Promise<Pricing> {
  const db = requireDb(dbInput);
  const packages = validatePackages(input);
  const updatedAt = new Date().toISOString();
  try {
    await db.prepare('INSERT INTO app_settings (id, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .bind('pricing', JSON.stringify(packages), updatedAt).run();
  } catch { throw new PricingError(503, 'Prices could not be saved. Try again shortly.'); }
  return { packages, updatedAt };
}
