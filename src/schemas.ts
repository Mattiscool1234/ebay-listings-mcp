import { z } from 'zod';
import { MARKETPLACES } from './marketplaces.js';

export const CONDITIONS = [
  'NEW',
  'LIKE_NEW',
  'NEW_OTHER',
  'NEW_WITH_DEFECTS',
  'MANUFACTURER_REFURBISHED',
  'CERTIFIED_REFURBISHED',
  'EXCELLENT_REFURBISHED',
  'VERY_GOOD_REFURBISHED',
  'GOOD_REFURBISHED',
  'SELLER_REFURBISHED',
  'USED_EXCELLENT',
  'USED_VERY_GOOD',
  'USED_GOOD',
  'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING',
  'PRE_OWNED_EXCELLENT',
  'PRE_OWNED_FAIR',
] as const;

export const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((value) => !/[\u0000-\u001f]/.test(value) && !value.includes('/'), 'SKU cannot contain slashes or control characters');

export const offerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, 'offerId must be letters, numbers, underscores, or hyphens');

export const categoryIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}$/, 'categoryId must be a numeric eBay category id');

export const priceSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, 'price must be a decimal string with up to 2 decimal places');

export const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code');

export const policyIdSchema = z.string().trim().regex(/^\d{1,32}$/, 'policy id must be numeric');

export const locationKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(36)
  .regex(/^[A-Za-z0-9_-]+$/, 'merchantLocationKey must be 1-36 letters, numbers, underscores, or hyphens');

export const marketplaceSchema = z.enum(MARKETPLACES);

export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Image URLs must be public https URLs without embedded credentials');

export const aspectsSchema = z
  .record(z.string().trim().min(1).max(40), z.union([z.string().trim().min(1).max(100), z.array(z.string().trim().min(1).max(100)).min(1).max(30)]))
  .refine((value) => Object.keys(value).length <= 45, 'At most 45 aspects');

export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, 'Use an ISO-8601 UTC timestamp such as 2026-01-15T00:00:00.000Z');

export const conditionSchema = z.enum(CONDITIONS);

export const listInventoryItemsInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional().describe('Page size. Default 25. Maximum 200.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe('Page index. 0 is the first page. This is not a record skip count.'),
  })
  .strict();

export const skuInput = z.object({ sku: skuSchema }).strict();

export const createOrReplaceInventoryItemInput = z
  .object({
    sku: skuSchema.describe('Seller-defined SKU, unique in this account. Maximum 50 characters.'),
    title: z.string().trim().min(1).max(80).describe('Listing title. eBay allows 80 characters.'),
    description: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .optional()
      .describe('Product description. Omit to leave an existing description unchanged.'),
    condition: conditionSchema.describe('eBay condition enum, for example NEW or USED_GOOD.'),
    conditionDescription: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe('Extra condition notes. Some used and refurbished categories require this.'),
    aspects: aspectsSchema
      .optional()
      .describe('Item specifics. Names come from get_item_aspects_for_category. Each value is a string or an array of strings.'),
    imageUrls: z
      .array(httpsUrlSchema)
      .max(24)
      .optional()
      .describe('Public https image URLs eBay can fetch, including eBay Media or Picture Services URLs. Maximum 24. This server does not upload image bytes.'),
    quantity: z.number().int().min(0).max(1_000_000).describe('Ship-to-home quantity available.'),
  })
  .strict();

export const createOfferInput = z
  .object({
    sku: skuSchema,
    marketplaceId: marketplaceSchema.describe('eBay marketplace, for example EBAY_US.'),
    categoryId: categoryIdSchema.describe('Leaf category id from suggest_category.'),
    price: priceSchema.describe('Fixed price as a decimal string, for example "19.99".'),
    currency: currencySchema.optional().describe('ISO currency. Defaults from the marketplace, such as USD for EBAY_US.'),
    quantity: z.number().int().min(0).max(1_000_000),
    fulfillmentPolicyId: policyIdSchema.describe('Fulfillment (shipping) business policy id from get_listing_policies.'),
    paymentPolicyId: policyIdSchema.describe('Payment business policy id from get_listing_policies.'),
    returnPolicyId: policyIdSchema.describe('Return business policy id from get_listing_policies.'),
    merchantLocationKey: locationKeySchema.describe('Inventory location key from create_inventory_location or list_inventory_locations.'),
    listingDescription: z
      .string()
      .trim()
      .min(1)
      .max(500_000)
      .optional()
      .describe('Buyer-facing listing description. When omitted, eBay can use the inventory item description.'),
  })
  .strict();

export const updateOfferInput = z
  .object({
    offerId: offerIdSchema,
    sku: skuSchema.optional(),
    marketplaceId: marketplaceSchema.optional(),
    categoryId: categoryIdSchema.optional(),
    price: priceSchema.optional(),
    currency: currencySchema.optional(),
    quantity: z.number().int().min(0).max(1_000_000).optional(),
    fulfillmentPolicyId: policyIdSchema.optional(),
    paymentPolicyId: policyIdSchema.optional(),
    returnPolicyId: policyIdSchema.optional(),
    merchantLocationKey: locationKeySchema.optional(),
    listingDescription: z.string().trim().min(1).max(500_000).optional(),
  })
  .strict();

export const offerIdInput = z.object({ offerId: offerIdSchema }).strict();

export const publishOfferInput = z
  .object({
    offerId: offerIdSchema,
    marketplaceId: marketplaceSchema.optional().describe('Used only to build the listing URL if the offer cannot be read first.'),
  })
  .strict();

export const bulkOfferUpdate = z
  .object({
    offerId: offerIdSchema,
    price: priceSchema.optional(),
    currency: currencySchema.optional(),
    quantity: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const bulkUpdatePriceQuantityInput = z
  .object({
    requests: z
      .array(
        z
          .object({
            sku: skuSchema.describe('One SKU per request. eBay allows one SKU per bulk call; this server sends one call per SKU.'),
            quantity: z.number().int().min(0).max(1_000_000).optional().describe('Inventory ship-to-home quantity.'),
            offers: z.array(bulkOfferUpdate).max(25).optional().describe('Up to 25 offers for this SKU. Published offers are revised on the live listing.'),
          })
          .strict(),
      )
      .min(1)
      .max(25),
  })
  .strict();

export const listOffersInput = z
  .object({
    sku: skuSchema.describe('Required. eBay lists offers per SKU.'),
    marketplaceId: marketplaceSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(10_000).optional().describe('Page index. 0 is the first page.'),
  })
  .strict();

export const marketplaceInput = z
  .object({
    marketplaceId: marketplaceSchema.optional().describe('Default EBAY_US.'),
  })
  .strict();

export const createInventoryLocationInput = z
  .object({
    merchantLocationKey: locationKeySchema,
    name: z.string().trim().min(1).max(100),
    country: z.string().trim().regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO code, such as US'),
    postalCode: z.string().trim().min(1).max(16).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    stateOrProvince: z.string().trim().min(1).max(80).optional(),
    addressLine1: z.string().trim().min(1).max(128).optional(),
    phone: z.string().trim().min(1).max(32).optional(),
    locationType: z.enum(['WAREHOUSE', 'STORE']).optional().describe('Default WAREHOUSE.'),
  })
  .strict();

export const listLocationsInput = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(10_000).optional().describe('Number of locations to skip.'),
  })
  .strict();

export const suggestCategoryInput = z
  .object({
    query: z.string().trim().min(1).max(200).describe('Product keywords, for example "wool running socks".'),
    marketplaceId: marketplaceSchema.optional().describe('Default EBAY_US.'),
  })
  .strict();

export const itemAspectsInput = z
  .object({
    categoryId: categoryIdSchema,
    marketplaceId: marketplaceSchema.optional().describe('Default EBAY_US.'),
  })
  .strict();

export const listOrdersInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional().describe('Default 50. Maximum 200.'),
    offset: z.number().int().min(0).max(10_000).optional().describe('Number of orders to skip.'),
    fulfillmentStatuses: z.array(z.enum(['NOT_STARTED', 'IN_PROGRESS', 'FULFILLED'])).max(3).optional(),
    createdFrom: isoDateSchema.optional(),
    createdTo: isoDateSchema.optional(),
    filter: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe('Raw Sell Fulfillment order filter. Do not combine with the structured filter fields.'),
  })
  .strict();

export const getOrderInput = z
  .object({
    orderId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, 'orderId contains unsupported characters'),
  })
  .strict();

export function normalizeAspects(aspects: Record<string, string | string[]>): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(aspects)) {
    normalized[key] = Array.isArray(value) ? value : [value];
  }
  return normalized;
}

export function bulkUpdateIssues(input: z.infer<typeof bulkUpdatePriceQuantityInput>): string | null {
  for (const request of input.requests) {
    if (request.quantity === undefined && (!request.offers || request.offers.length === 0)) {
      return `SKU ${request.sku} needs a quantity or at least one offer update.`;
    }
    const ids = (request.offers ?? []).map((offer) => offer.offerId);
    if (new Set(ids).size !== ids.length) return `SKU ${request.sku} has a duplicate offerId.`;
    for (const offer of request.offers ?? []) {
      if (offer.price === undefined && offer.quantity === undefined) {
        return `Offer ${offer.offerId} needs a price or a quantity.`;
      }
    }
  }
  return null;
}

export function updateOfferHasChange(input: z.infer<typeof updateOfferInput>): boolean {
  return Object.entries(input).some(([key, value]) => key !== 'offerId' && value !== undefined);
}
