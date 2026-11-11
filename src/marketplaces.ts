import type { EbayEnvironment } from './config.js';

export const MARKETPLACES = [
  'EBAY_US',
  'EBAY_MOTORS_US',
  'EBAY_CA',
  'EBAY_GB',
  'EBAY_AU',
  'EBAY_AT',
  'EBAY_BE',
  'EBAY_CH',
  'EBAY_DE',
  'EBAY_ES',
  'EBAY_FR',
  'EBAY_HK',
  'EBAY_IE',
  'EBAY_IT',
  'EBAY_MY',
  'EBAY_NL',
  'EBAY_PH',
  'EBAY_PL',
  'EBAY_SG',
  'EBAY_TW',
] as const;

export type MarketplaceId = (typeof MARKETPLACES)[number];

const CURRENCY: Record<string, string> = {
  EBAY_US: 'USD',
  EBAY_MOTORS_US: 'USD',
  EBAY_CA: 'CAD',
  EBAY_GB: 'GBP',
  EBAY_AU: 'AUD',
  EBAY_AT: 'EUR',
  EBAY_BE: 'EUR',
  EBAY_CH: 'CHF',
  EBAY_DE: 'EUR',
  EBAY_ES: 'EUR',
  EBAY_FR: 'EUR',
  EBAY_HK: 'HKD',
  EBAY_IE: 'EUR',
  EBAY_IT: 'EUR',
  EBAY_MY: 'MYR',
  EBAY_NL: 'EUR',
  EBAY_PH: 'PHP',
  EBAY_PL: 'PLN',
  EBAY_SG: 'SGD',
  EBAY_TW: 'TWD',
};

const CONTENT_LANGUAGE: Record<string, string> = {
  EBAY_US: 'en-US',
  EBAY_MOTORS_US: 'en-US',
  EBAY_CA: 'en-CA',
  EBAY_GB: 'en-GB',
  EBAY_AU: 'en-AU',
  EBAY_AT: 'de-AT',
  EBAY_BE: 'nl-BE',
  EBAY_CH: 'de-CH',
  EBAY_DE: 'de-DE',
  EBAY_ES: 'es-ES',
  EBAY_FR: 'fr-FR',
  EBAY_HK: 'zh-HK',
  EBAY_IE: 'en-IE',
  EBAY_IT: 'it-IT',
  EBAY_MY: 'en-US',
  EBAY_NL: 'nl-NL',
  EBAY_PH: 'en-PH',
  EBAY_PL: 'pl-PL',
  EBAY_SG: 'en-SG',
  EBAY_TW: 'zh-TW',
};

const PRODUCTION_HOST: Record<string, string> = {
  EBAY_US: 'https://www.ebay.com',
  EBAY_MOTORS_US: 'https://www.ebay.com',
  EBAY_CA: 'https://www.ebay.ca',
  EBAY_GB: 'https://www.ebay.co.uk',
  EBAY_AU: 'https://www.ebay.com.au',
  EBAY_AT: 'https://www.ebay.at',
  EBAY_BE: 'https://www.ebay.be',
  EBAY_CH: 'https://www.ebay.ch',
  EBAY_DE: 'https://www.ebay.de',
  EBAY_ES: 'https://www.ebay.es',
  EBAY_FR: 'https://www.ebay.fr',
  EBAY_HK: 'https://www.ebay.com.hk',
  EBAY_IE: 'https://www.ebay.ie',
  EBAY_IT: 'https://www.ebay.it',
  EBAY_MY: 'https://www.ebay.com.my',
  EBAY_NL: 'https://www.ebay.nl',
  EBAY_PH: 'https://www.ebay.ph',
  EBAY_PL: 'https://www.ebay.pl',
  EBAY_SG: 'https://www.ebay.com.sg',
  EBAY_TW: 'https://www.ebay.com.tw',
};

export function defaultCurrency(marketplaceId: string): string {
  return CURRENCY[marketplaceId] ?? 'USD';
}

export function contentLanguageFor(marketplaceId: string | undefined, override?: string): string {
  if (override) return override;
  if (marketplaceId && CONTENT_LANGUAGE[marketplaceId]) return CONTENT_LANGUAGE[marketplaceId];
  return 'en-US';
}

export function listingUrl(env: EbayEnvironment, marketplaceId: string, listingId: string): string {
  const id = encodeURIComponent(listingId);
  if (env === 'sandbox') return `https://www.sandbox.ebay.com/itm/${id}`;
  const host = PRODUCTION_HOST[marketplaceId] ?? 'https://www.ebay.com';
  return `${host}/itm/${id}`;
}
