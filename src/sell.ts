import type { AppConfig } from './config.js';
import { asRecord, EbayClient } from './ebayClient.js';
import { contentLanguageFor, defaultCurrency, listingUrl } from './marketplaces.js';
import {
  bulkUpdateIssues,
  normalizeAspects,
  updateOfferHasChange,
  type bulkUpdatePriceQuantityInput,
  type createInventoryLocationInput,
  type createOfferInput,
  type createOrReplaceInventoryItemInput,
  type updateOfferInput,
} from './schemas.js';
import type { z } from 'zod';

const OFFER_READONLY = new Set(['offerId', 'status', 'listing', 'listingStatus', 'warnings', 'errors']);

export class EbaySeller {
  private readonly treeIds = new Map<string, string>();

  constructor(
    private readonly client: EbayClient,
    private readonly config: AppConfig,
  ) {}

  redact(text: string): string {
    return this.client.redact(text);
  }

  async listInventoryItems(limit = 25, offset = 0): Promise<unknown> {
    const response = await this.client.userRequest('GET', '/sell/inventory/v1/inventory_item', {
      query: { limit, offset },
    });
    const body = asRecord(response.body) ?? {};
    const items = Array.isArray(body.inventoryItems) ? body.inventoryItems : [];
    return {
      total: body.total ?? items.length,
      limit,
      offset,
      items: items.map((item) => summarizeInventory(item)),
    };
  }

  async getInventoryItem(sku: string): Promise<unknown> {
    const response = await this.client.userRequest('GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
    return response.body;
  }

  async createOrReplaceInventoryItem(input: z.infer<typeof createOrReplaceInventoryItemInput>): Promise<unknown> {
    const existingResponse = await this.client.userRequest(
      'GET',
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`,
      { missing: 'null' },
    );
    const existing = asRecord(existingResponse.body);
    const existingProduct = asRecord(existing?.product) ?? {};
    const product: Record<string, unknown> = { ...existingProduct, title: input.title };
    if (input.description !== undefined) product.description = input.description;
    if (input.aspects !== undefined) product.aspects = normalizeAspects(input.aspects);
    if (input.imageUrls !== undefined) product.imageUrls = input.imageUrls;

    const existingAvailability = asRecord(existing?.availability) ?? {};
    const body: Record<string, unknown> = {
      condition: input.condition,
      product,
      availability: {
        shipToLocationAvailability: { quantity: input.quantity },
      },
    };
    if (input.conditionDescription !== undefined) body.conditionDescription = input.conditionDescription;
    else if (existing?.conditionDescription) body.conditionDescription = existing.conditionDescription;
    if (existing?.packageWeightAndSize) body.packageWeightAndSize = existing.packageWeightAndSize;
    if (existingAvailability.pickupAtLocationAvailability) {
      (body.availability as Record<string, unknown>).pickupAtLocationAvailability =
        existingAvailability.pickupAtLocationAvailability;
    }

    const response = await this.client.userRequest('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`, {
      body,
      contentLanguage: contentLanguageFor(undefined, this.config.contentLanguage),
    });
    return {
      sku: input.sku,
      status: existing ? 'replaced' : 'created',
      httpStatus: response.status,
      replacedExistingFields: Boolean(existing),
    };
  }

  async deleteInventoryItem(sku: string): Promise<unknown> {
    const response = await this.client.userRequest('DELETE', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
    return {
      sku,
      deleted: true,
      httpStatus: response.status,
      note: 'The inventory item was deleted. Unpublished offers for this SKU are removed, and a single-variation live listing for this SKU is ended.',
    };
  }

  async listOffers(sku: string, marketplaceId?: string, limit = 50, offset = 0): Promise<unknown> {
    const response = await this.client.userRequest('GET', '/sell/inventory/v1/offer', {
      query: { sku, marketplace_id: marketplaceId, limit, offset },
    });
    const body = asRecord(response.body) ?? {};
    const offers = Array.isArray(body.offers) ? body.offers : [];
    return {
      sku,
      total: body.total ?? offers.length,
      limit,
      offset,
      offers: offers.map((offer) => summarizeOffer(offer)),
    };
  }

  async createOffer(input: z.infer<typeof createOfferInput>): Promise<unknown> {
    const currency = input.currency ?? defaultCurrency(input.marketplaceId);
    const body: Record<string, unknown> = {
      sku: input.sku,
      marketplaceId: input.marketplaceId,
      format: 'FIXED_PRICE',
      availableQuantity: input.quantity,
      categoryId: input.categoryId,
      listingPolicies: {
        fulfillmentPolicyId: input.fulfillmentPolicyId,
        paymentPolicyId: input.paymentPolicyId,
        returnPolicyId: input.returnPolicyId,
      },
      pricingSummary: { price: { value: input.price, currency } },
      merchantLocationKey: input.merchantLocationKey,
      listingDuration: 'GTC',
      includeCatalogProductDetails: true,
    };
    if (input.listingDescription) body.listingDescription = input.listingDescription;
    const response = await this.client.userRequest('POST', '/sell/inventory/v1/offer', {
      body,
      contentLanguage: contentLanguageFor(input.marketplaceId, this.config.contentLanguage),
    });
    const created = asRecord(response.body) ?? {};
    return {
      offerId: created.offerId ?? null,
      sku: input.sku,
      marketplaceId: input.marketplaceId,
      status: 'unpublished',
      note: 'The offer is staged. Call publish_offer to create a live listing.',
    };
  }

  async updateOffer(input: z.infer<typeof updateOfferInput>): Promise<unknown> {
    if (!updateOfferHasChange(input)) {
      throw new Error('Provide at least one field to change besides offerId.');
    }
    const current = await this.readOffer(input.offerId);
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      if (!OFFER_READONLY.has(key)) next[key] = value;
    }
    if (input.sku) next.sku = input.sku;
    if (input.marketplaceId) next.marketplaceId = input.marketplaceId;
    if (input.categoryId) next.categoryId = input.categoryId;
    if (input.quantity !== undefined) next.availableQuantity = input.quantity;
    if (input.merchantLocationKey) next.merchantLocationKey = input.merchantLocationKey;
    if (input.listingDescription) next.listingDescription = input.listingDescription;
    if (input.price || input.currency) {
      const pricing = asRecord(next.pricingSummary) ?? {};
      const price = asRecord(pricing.price) ?? {};
      const marketplaceId = typeof next.marketplaceId === 'string' ? next.marketplaceId : 'EBAY_US';
      next.pricingSummary = {
        ...pricing,
        price: {
          value: input.price ?? price.value,
          currency: input.currency ?? price.currency ?? defaultCurrency(marketplaceId),
        },
      };
    }
    if (input.fulfillmentPolicyId || input.paymentPolicyId || input.returnPolicyId) {
      const policies = asRecord(next.listingPolicies) ?? {};
      next.listingPolicies = {
        ...policies,
        ...(input.fulfillmentPolicyId ? { fulfillmentPolicyId: input.fulfillmentPolicyId } : {}),
        ...(input.paymentPolicyId ? { paymentPolicyId: input.paymentPolicyId } : {}),
        ...(input.returnPolicyId ? { returnPolicyId: input.returnPolicyId } : {}),
      };
    }
    const marketplaceId = typeof next.marketplaceId === 'string' ? next.marketplaceId : undefined;
    const response = await this.client.userRequest('PUT', `/sell/inventory/v1/offer/${encodeURIComponent(input.offerId)}`, {
      body: next,
      contentLanguage: contentLanguageFor(marketplaceId, this.config.contentLanguage),
    });
    return {
      offerId: input.offerId,
      httpStatus: response.status,
      status: current.status ?? null,
      note:
        current.status === 'PUBLISHED'
          ? 'This offer is published. The live listing was revised.'
          : 'The unpublished offer was updated.',
    };
  }

  async publishOffer(offerId: string, marketplaceHint?: string): Promise<unknown> {
    let marketplaceId = marketplaceHint ?? 'EBAY_US';
    try {
      const offer = await this.readOffer(offerId);
      if (typeof offer.marketplaceId === 'string') marketplaceId = offer.marketplaceId;
    } catch {
      marketplaceId = marketplaceHint ?? 'EBAY_US';
    }
    const response = await this.client.userRequest(
      'POST',
      `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      { contentLanguage: contentLanguageFor(marketplaceId, this.config.contentLanguage) },
    );
    const body = asRecord(response.body) ?? {};
    const listingId = typeof body.listingId === 'string' ? body.listingId : null;
    return {
      offerId,
      listingId,
      listingUrl: listingId ? listingUrl(this.config.ebayEnv, marketplaceId, listingId) : null,
      marketplaceId,
      warnings: body.warnings ?? [],
    };
  }

  async withdrawOffer(offerId: string): Promise<unknown> {
    const response = await this.client.userRequest('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`);
    const body = asRecord(response.body) ?? {};
    return {
      offerId,
      listingId: body.listingId ?? null,
      status: 'ended',
      httpStatus: response.status,
      note: 'The live listing was ended. The offer remains unpublished and can be published again.',
    };
  }

  async bulkUpdatePriceQuantity(input: z.infer<typeof bulkUpdatePriceQuantityInput>): Promise<unknown> {
    const issue = bulkUpdateIssues(input);
    if (issue) throw new Error(issue);
    const results: unknown[] = [];
    const failures: unknown[] = [];
    for (const request of input.requests) {
      const payload: Record<string, unknown> = { sku: request.sku };
      if (request.quantity !== undefined) {
        payload.shipToLocationAvailability = { quantity: request.quantity };
      }
      if (request.offers && request.offers.length > 0) {
        payload.offers = request.offers.map((offer) => {
          const entry: Record<string, unknown> = { offerId: offer.offerId };
          if (offer.quantity !== undefined) entry.availableQuantity = offer.quantity;
          if (offer.price) {
            entry.price = { value: offer.price, currency: offer.currency ?? 'USD' };
          }
          return entry;
        });
      }
      try {
        const response = await this.client.userRequest('POST', '/sell/inventory/v1/bulk_update_price_quantity', {
          body: { requests: [payload] },
          contentLanguage: contentLanguageFor(undefined, this.config.contentLanguage),
        });
        results.push({ sku: request.sku, httpStatus: response.status, body: response.body });
      } catch (error) {
        failures.push({
          sku: request.sku,
          error: error instanceof Error ? this.redact(error.message) : 'Update failed',
        });
      }
    }
    return {
      updated: results,
      failed: failures,
      note: 'Published offers that were included are revised on the live listing. eBay allows about 250 revisions per listing per day.',
    };
  }

  async getListingPolicies(marketplaceId = 'EBAY_US'): Promise<unknown> {
    const query = { marketplace_id: marketplaceId };
    const [fulfillment, payment, returns] = await Promise.all([
      this.client.userRequest('GET', '/sell/account/v1/fulfillment_policy', { query }),
      this.client.userRequest('GET', '/sell/account/v1/payment_policy', { query }),
      this.client.userRequest('GET', '/sell/account/v1/return_policy', { query }),
    ]);
    return {
      marketplaceId,
      fulfillment: policySummaries(fulfillment.body, 'fulfillmentPolicies', 'fulfillmentPolicyId'),
      payment: policySummaries(payment.body, 'paymentPolicies', 'paymentPolicyId'),
      return: policySummaries(returns.body, 'returnPolicies', 'returnPolicyId'),
    };
  }

  async createInventoryLocation(input: z.infer<typeof createInventoryLocationInput>): Promise<unknown> {
    if (!input.postalCode && !(input.city && input.stateOrProvince)) {
      throw new Error('Provide postalCode, or both city and stateOrProvince, plus country.');
    }
    const address: Record<string, string> = { country: input.country };
    if (input.postalCode) address.postalCode = input.postalCode;
    if (input.city) address.city = input.city;
    if (input.stateOrProvince) address.stateOrProvince = input.stateOrProvince;
    if (input.addressLine1) address.addressLine1 = input.addressLine1;
    const body: Record<string, unknown> = {
      name: input.name,
      merchantLocationStatus: 'ENABLED',
      locationTypes: [input.locationType ?? 'WAREHOUSE'],
      location: { address },
    };
    if (input.phone) body.phone = input.phone;
    const response = await this.client.userRequest(
      'POST',
      `/sell/inventory/v1/location/${encodeURIComponent(input.merchantLocationKey)}`,
      { body, contentLanguage: contentLanguageFor(undefined, this.config.contentLanguage) },
    );
    return {
      merchantLocationKey: input.merchantLocationKey,
      created: true,
      httpStatus: response.status,
    };
  }

  async listInventoryLocations(limit = 25, offset = 0): Promise<unknown> {
    const response = await this.client.userRequest('GET', '/sell/inventory/v1/location', {
      query: { limit, offset },
    });
    const body = asRecord(response.body) ?? {};
    const locations = Array.isArray(body.locations) ? body.locations : [];
    return {
      total: body.total ?? locations.length,
      limit,
      offset,
      locations: locations.map((location) => {
        const row = asRecord(location) ?? {};
        const place = asRecord(row.location);
        return {
          merchantLocationKey: row.merchantLocationKey ?? null,
          name: row.name ?? null,
          merchantLocationStatus: row.merchantLocationStatus ?? null,
          locationTypes: row.locationTypes ?? [],
          address: asRecord(place?.address) ?? place?.address ?? null,
        };
      }),
    };
  }

  async suggestCategory(query: string, marketplaceId = 'EBAY_US'): Promise<unknown> {
    const treeId = await this.categoryTreeId(marketplaceId);
    const response = await this.client.appRequest(
      'GET',
      `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions`,
      { query: { q: query }, missing: 'null' },
    );
    const body = asRecord(response.body);
    const suggestions = Array.isArray(body?.categorySuggestions) ? body.categorySuggestions : [];
    return {
      marketplaceId,
      categoryTreeId: treeId,
      sandboxNote:
        this.config.ebayEnv === 'sandbox'
          ? 'eBay does not support category suggestions in sandbox. Names returned there are not reliable. Use production for real category picks.'
          : undefined,
      suggestions: suggestions.map((item) => {
        const row = asRecord(item) ?? {};
        const category = asRecord(row.category) ?? {};
        const ancestors = Array.isArray(row.categoryTreeNodeAncestors) ? row.categoryTreeNodeAncestors : [];
        return {
          categoryId: category.categoryId ?? null,
          categoryName: category.categoryName ?? null,
          ancestors: ancestors.map((ancestor) => {
            const node = asRecord(ancestor) ?? {};
            return { categoryId: node.categoryId ?? null, categoryName: node.categoryName ?? null };
          }),
        };
      }),
    };
  }

  async getItemAspects(categoryId: string, marketplaceId = 'EBAY_US'): Promise<unknown> {
    const treeId = await this.categoryTreeId(marketplaceId);
    const response = await this.client.appRequest(
      'GET',
      `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category`,
      { query: { category_id: categoryId }, missing: 'null' },
    );
    const body = asRecord(response.body);
    const aspects = Array.isArray(body?.aspects) ? body.aspects : [];
    return {
      marketplaceId,
      categoryTreeId: treeId,
      categoryId,
      aspects: aspects.map((aspect) => compactAspect(aspect)),
    };
  }

  async listOrders(input: {
    limit?: number;
    offset?: number;
    fulfillmentStatuses?: string[];
    createdFrom?: string;
    createdTo?: string;
    filter?: string;
  }): Promise<unknown> {
    const structured = Boolean(
      (input.fulfillmentStatuses && input.fulfillmentStatuses.length > 0) || input.createdFrom || input.createdTo,
    );
    if (input.filter && structured) {
      throw new Error('Pass either filter or the structured order fields, not both.');
    }
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const response = await this.client.userRequest('GET', '/sell/fulfillment/v1/order', {
      query: { limit, offset, filter: input.filter ?? buildOrderFilter(input) },
    });
    const body = asRecord(response.body) ?? {};
    const orders = Array.isArray(body.orders) ? body.orders : [];
    return {
      total: body.total ?? orders.length,
      limit,
      offset,
      orders: orders.map((order) => summarizeOrder(order)),
    };
  }

  async getOrder(orderId: string): Promise<unknown> {
    const response = await this.client.userRequest('GET', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`);
    return response.body;
  }

  async getSellerIdentity(): Promise<unknown> {
    const response = await this.client.identityRequest('GET', '/commerce/identity/v1/user/');
    const body = asRecord(response.body) ?? {};
    return {
      userId: body.userId ?? null,
      username: body.username ?? null,
      accountType: body.accountType ?? null,
      registrationMarketplaceId: body.registrationMarketplaceId ?? null,
    };
  }

  private async categoryTreeId(marketplaceId: string): Promise<string> {
    const cached = this.treeIds.get(marketplaceId);
    if (cached) return cached;
    const response = await this.client.appRequest('GET', '/commerce/taxonomy/v1/get_default_category_tree_id', {
      query: { marketplace_id: marketplaceId },
    });
    const body = asRecord(response.body);
    const treeId = body && typeof body.categoryTreeId === 'string' ? body.categoryTreeId : '';
    if (!treeId) throw new Error(`eBay did not return a category tree for ${marketplaceId}.`);
    this.treeIds.set(marketplaceId, treeId);
    return treeId;
  }

  private async readOffer(offerId: string): Promise<Record<string, unknown>> {
    const response = await this.client.userRequest('GET', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
    const body = asRecord(response.body);
    if (!body) throw new Error(`Offer ${offerId} was not found.`);
    return body;
  }
}

function summarizeInventory(item: unknown): unknown {
  const row = asRecord(item) ?? {};
  const product = asRecord(row.product) ?? {};
  const availability = asRecord(row.availability);
  const ship = asRecord(availability?.shipToLocationAvailability);
  const images = Array.isArray(product.imageUrls) ? product.imageUrls : [];
  return {
    sku: row.sku ?? null,
    title: product.title ?? null,
    condition: row.condition ?? null,
    quantity: ship?.quantity ?? null,
    imageCount: images.length,
  };
}

function summarizeOffer(offer: unknown): unknown {
  const row = asRecord(offer) ?? {};
  const pricing = asRecord(row.pricingSummary);
  const listing = asRecord(row.listing);
  return {
    offerId: row.offerId ?? null,
    sku: row.sku ?? null,
    status: row.status ?? null,
    marketplaceId: row.marketplaceId ?? null,
    format: row.format ?? null,
    categoryId: row.categoryId ?? null,
    availableQuantity: row.availableQuantity ?? null,
    price: asRecord(pricing?.price) ?? pricing?.price ?? null,
    listingId: listing?.listingId ?? null,
    listingStatus: listing?.listingStatus ?? null,
    merchantLocationKey: row.merchantLocationKey ?? null,
    listingPolicies: row.listingPolicies ?? null,
  };
}

function policySummaries(body: unknown, listKey: string, idKey: string): unknown[] {
  const record = asRecord(body) ?? {};
  const list = Array.isArray(record[listKey]) ? record[listKey] : [];
  return list.map((item) => {
    const row = asRecord(item) ?? {};
    return {
      id: row[idKey] ?? null,
      name: row.name ?? null,
      marketplaceId: row.marketplaceId ?? null,
      description: row.description ?? null,
    };
  });
}

function compactAspect(aspect: unknown): unknown {
  const row = asRecord(aspect) ?? {};
  const constraint = asRecord(row.aspectConstraint) ?? {};
  const values = Array.isArray(row.aspectValues)
    ? row.aspectValues
        .map((value) => {
          const entry = asRecord(value);
          return typeof entry?.localizedValue === 'string' ? entry.localizedValue : null;
        })
        .filter((value): value is string => Boolean(value))
    : [];
  const shown = values.slice(0, 50);
  return {
    name: row.localizedAspectName ?? null,
    required: constraint.aspectRequired === true,
    usage: constraint.aspectUsage ?? null,
    mode: constraint.aspectMode ?? null,
    dataType: constraint.aspectDataType ?? null,
    cardinality: constraint.itemToAspectCardinality ?? null,
    enabledForVariations: constraint.aspectEnabledForVariations === true,
    valueCount: values.length,
    values: shown,
    valuesTruncated: values.length > shown.length,
  };
}

function buildOrderFilter(input: {
  fulfillmentStatuses?: string[];
  createdFrom?: string;
  createdTo?: string;
}): string | undefined {
  const parts: string[] = [];
  if (input.fulfillmentStatuses && input.fulfillmentStatuses.length > 0) {
    parts.push(`orderfulfillmentstatus:{${input.fulfillmentStatuses.join('|')}}`);
  }
  if (input.createdFrom || input.createdTo) {
    parts.push(`creationdate:[${input.createdFrom ?? ''}..${input.createdTo ?? ''}]`);
  }
  return parts.length > 0 ? parts.join(',') : undefined;
}

function summarizeOrder(order: unknown): unknown {
  const row = asRecord(order) ?? {};
  const buyer = asRecord(row.buyer);
  const pricing = asRecord(row.pricingSummary);
  const total = asRecord(pricing?.total);
  const lineItems = Array.isArray(row.lineItems) ? row.lineItems : [];
  return {
    orderId: row.orderId ?? null,
    creationDate: row.creationDate ?? null,
    orderFulfillmentStatus: row.orderFulfillmentStatus ?? null,
    orderPaymentStatus: row.orderPaymentStatus ?? null,
    buyerUsername: buyer?.username ?? null,
    total: total ? { value: total.value ?? null, currency: total.currency ?? null } : null,
    lineItems: lineItems.map((item) => {
      const line = asRecord(item) ?? {};
      return {
        lineItemId: line.lineItemId ?? null,
        title: line.title ?? null,
        sku: line.sku ?? null,
        quantity: line.quantity ?? null,
      };
    }),
  };
}
