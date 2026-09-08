import type { UniverseRow } from './types'

// Ticker → company website domain, used with Clearbit's logo CDN.
// Only well-known covered names are whitelisted; unknown tickers get a letter
// badge fallback instead of a broken image.
const DOMAINS: Record<string, string> = {
  AAPL: 'apple.com',
  MSFT: 'microsoft.com',
  GOOGL: 'abc.xyz',
  GOOG: 'abc.xyz',
  AMZN: 'amazon.com',
  NVDA: 'nvidia.com',
  META: 'meta.com',
  TSLA: 'tesla.com',
  BRK_B: 'berkshirehathaway.com',
  LLY: 'lilly.com',
  AVGO: 'broadcom.com',
  JPM: 'jpmorganchase.com',
  V: 'visa.com',
  XOM: 'exxonmobil.com',
  UNH: 'uhc.com',
  WMT: 'walmart.com',
  MA: 'mastercard.com',
  JNJ: 'jnj.com',
  PG: 'pg.com',
  ORCL: 'oracle.com',
  COST: 'costco.com',
  NFLX: 'netflix.com',
  AMD: 'amd.com',
  CRM: 'salesforce.com',
  KO: 'coca-colacompany.com',
  PEP: 'pepsi.com',
  BAC: 'bankofamerica.com',
  ADBE: 'adobe.com',
  CSCO: 'cisco.com',
  INTC: 'intel.com',
  QCOM: 'qualcomm.com',
  TXN: 'ti.com',
  IBM: 'ibm.com',
  ABT: 'abbott.com',
  TMO: 'thermofisher.com',
  ACN: 'accenture.com',
  PFE: 'pfizer.com',
  MCD: 'mcdonalds.com',
  AXP: 'americanexpress.com',
  MRK: 'merck.com',
  CVX: 'chevron.com',
  GS: 'goldmansachs.com',
  MS: 'morganstanley.com',
  SHOP: 'shopify.com',
}

export function logoUrl(row: UniverseRow): string | null {
  const domain = DOMAINS[row.ticker]
  if (!domain) return null
  return `https://logo.clearbit.com/${domain}`
}
