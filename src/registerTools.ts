import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  bulkUpdatePriceQuantityInput,
  createInventoryLocationInput,
  createOfferInput,
  createOrReplaceInventoryItemInput,
  getOrderInput,
  itemAspectsInput,
  listInventoryItemsInput,
  listLocationsInput,
  listOffersInput,
  listOrdersInput,
  marketplaceInput,
  offerIdInput,
  publishOfferInput,
  skuInput,
  suggestCategoryInput,
  updateOfferInput,
} from './schemas.js';
import { EbaySeller } from './sell.js';

export const TOOL_NAMES = [
  'list_inventory_items',
  'get_inventory_item',
  'create_or_replace_inventory_item',
  'create_offer',
  'update_offer',
  'publish_offer',
  'withdraw_offer',
  'delete_inventory_item',
  'bulk_update_price_quantity',
  'list_offers',
  'get_listing_policies',
  'create_inventory_location',
  'list_inventory_locations',
  'suggest_category',
  'get_item_aspects_for_category',
  'list_orders',
  'get_order',
  'get_seller_identity',
] as const;

const INSTRUCTIONS = [
  'Manage the connected eBay seller account with the official Sell Inventory, Account, Fulfillment, and Taxonomy APIs.',
  'Create a fixed-price listing in this order: suggest_category, get_item_aspects_for_category, create_inventory_location if needed, get_listing_policies, create_or_replace_inventory_item, create_offer, then publish_offer.',
  'Image fields take public https URLs (self-hosted or eBay Media / Picture Services). This server does not upload image bytes.',
  'The seller must be opted in to business policies, and each offer needs fulfillment, payment, and return policy ids plus an inventory location.',
  'publish_offer, withdraw_offer, and delete_inventory_item change or remove live listings. Confirm with the user before calling them.',
  'update_offer and bulk_update_price_quantity revise a live listing immediately when the offer is already published.',
  'Call get_seller_identity before the first change to confirm which eBay account is connected.',
].join(' ');

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function serverInstructions(): string {
  return INSTRUCTIONS;
}

export function registerTools(server: McpServer, seller: EbaySeller): void {
  const registered: string[] = [];
  const ok = (data: unknown): ToolResult => ({
    content: [{ type: 'text', text: seller.redact(JSON.stringify(data, null, 2)) }],
  });
  const fail = (message: string): ToolResult => ({
    isError: true,
    content: [{ type: 'text', text: seller.redact(message) }],
  });
  const run = (fn: () => Promise<unknown>): Promise<ToolResult> =>
    fn()
      .then((data) => {
        const record = data && typeof data === 'object' ? (data as { failed?: unknown[] }) : null;
        if (record && Array.isArray(record.failed) && record.failed.length > 0) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: seller.redact(JSON.stringify(data, null, 2)) }],
          };
        }
        return ok(data);
      })
      .catch((error: unknown) => fail(error instanceof Error ? error.message : 'Unexpected error'));

  const add = <Schema extends z.ZodType>(
    name: (typeof TOOL_NAMES)[number],
    config: {
      title: string;
      description: string;
      inputSchema: Schema;
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
    },
    handler: (args: z.infer<Schema>) => Promise<ToolResult>,
  ) => {
    registered.push(name);
    server.registerTool(name, config as never, handler as never);
  };

  add('list_inventory_items', {
    title: 'List inventory items',
    description: 'List SKUs in the seller inventory with title, condition, quantity, and image count. offset is a page index starting at 0.',
    inputSchema: listInventoryItemsInput,
    annotations: readOnly,
  }, (args) => run(() => seller.listInventoryItems(args.limit ?? 25, args.offset ?? 0)));

  add('get_inventory_item', {
    title: 'Get inventory item',
    description: 'Get the full inventory item record for one SKU, including title, description, aspects, image URLs, condition, and quantity.',
    inputSchema: skuInput,
    annotations: readOnly,
  }, (args) => run(() => seller.getInventoryItem(args.sku)));

  add('create_or_replace_inventory_item', {
    title: 'Create or replace inventory item',
    description:
      'Create or replace an inventory item (PUT). If the SKU already exists, title, condition, and quantity are replaced and omitted description, aspects, and image URLs are kept. Package weight and pickup availability already stored are kept. This does not publish a listing. Pass https image URLs only.',
    inputSchema: createOrReplaceInventoryItemInput,
    annotations: { ...write, idempotentHint: true },
  }, (args) => run(() => seller.createOrReplaceInventoryItem(args)));

  add('create_offer', {
    title: 'Create offer',
    description:
      'Create an unpublished fixed-price offer for a SKU. Requires a leaf category, price, quantity, merchant location, and fulfillment, payment, and return policy ids. Call publish_offer afterwards to make it a live listing.',
    inputSchema: createOfferInput,
    annotations: write,
  }, (args) => run(() => seller.createOffer(args)));

  add('update_offer', {
    title: 'Update offer',
    description:
      'Update an offer by reading it and writing the merged offer back. If the offer is already published, this revises the live eBay listing immediately. Provide offerId and at least one field to change.',
    inputSchema: updateOfferInput,
    annotations: write,
  }, (args) => run(() => seller.updateOffer(args)));

  add('publish_offer', {
    title: 'Publish offer',
    description:
      'DESTRUCTIVE: Publishes the offer as a live eBay listing that buyers can purchase. Returns the listing id and listing URL. Confirm with the user before calling. The seller must already have business policies, an inventory location, a valid category, and https images.',
    inputSchema: publishOfferInput,
    annotations: destructive,
  }, (args) => run(() => seller.publishOffer(args.offerId, args.marketplaceId)));

  add('withdraw_offer', {
    title: 'Withdraw offer',
    description:
      'DESTRUCTIVE: Ends the live eBay listing for this offer. The offer record is kept in the unpublished state and can be published again. This does not delete the inventory item. Confirm with the user before calling.',
    inputSchema: offerIdInput,
    annotations: destructive,
  }, (args) => run(() => seller.withdrawOffer(args.offerId)));

  add('delete_inventory_item', {
    title: 'Delete inventory item',
    description:
      'DESTRUCTIVE: Permanently deletes the inventory item for this SKU. Unpublished offers for the SKU are deleted, and a single-variation live listing for the SKU is ended. This cannot be undone. Confirm with the user before calling.',
    inputSchema: skuInput,
    annotations: destructive,
  }, (args) => run(() => seller.deleteInventoryItem(args.sku)));

  add('bulk_update_price_quantity', {
    title: 'Bulk update price and quantity',
    description:
      'Update ship-to-home quantity for a SKU and/or the price and quantity of up to 25 of its offers. One SKU is sent per eBay call. Published offers are revised on the live listing immediately. Each offer entry needs a price or a quantity.',
    inputSchema: bulkUpdatePriceQuantityInput,
    annotations: write,
  }, (args) => run(() => seller.bulkUpdatePriceQuantity(args)));

  add('list_offers', {
    title: 'List offers',
    description: 'List unpublished and published offers for one SKU, including offerId, price, quantity, policy ids, listing id, and status.',
    inputSchema: listOffersInput,
    annotations: readOnly,
  }, (args) => run(() => seller.listOffers(args.sku, args.marketplaceId, args.limit ?? 50, args.offset ?? 0)));

  add('get_listing_policies', {
    title: 'Get listing policies',
    description:
      'List the seller fulfillment (shipping), payment, and return business policies for a marketplace. Use the ids with create_offer. Policies are created in Seller Hub; this tool does not create them.',
    inputSchema: marketplaceInput,
    annotations: readOnly,
  }, (args) => run(() => seller.getListingPolicies(args.marketplaceId ?? 'EBAY_US')));

  add('create_inventory_location', {
    title: 'Create inventory location',
    description:
      'Create a warehouse or store inventory location. Provide country and either postalCode, or both city and stateOrProvince. The merchantLocationKey cannot be changed later and is required on offers.',
    inputSchema: createInventoryLocationInput,
    annotations: write,
  }, (args) => run(() => seller.createInventoryLocation(args)));

  add('list_inventory_locations', {
    title: 'List inventory locations',
    description: 'List inventory locations and their merchantLocationKey values. offset is the number of locations to skip.',
    inputSchema: listLocationsInput,
    annotations: readOnly,
  }, (args) => run(() => seller.listInventoryLocations(args.limit ?? 25, args.offset ?? 0)));

  add('suggest_category', {
    title: 'Suggest category',
    description:
      'Suggest leaf eBay categories for a product query using the Taxonomy API. Use a returned categoryId on create_offer. Sandbox suggestions are not reliable.',
    inputSchema: suggestCategoryInput,
    annotations: readOnly,
  }, (args) => run(() => seller.suggestCategory(args.query, args.marketplaceId ?? 'EBAY_US')));

  add('get_item_aspects_for_category', {
    title: 'Get item aspects for category',
    description:
      'Get required and optional item specifics for a leaf category. Put the chosen names and values in create_or_replace_inventory_item aspects. At most 50 values are returned per aspect.',
    inputSchema: itemAspectsInput,
    annotations: readOnly,
  }, (args) => run(() => seller.getItemAspects(args.categoryId, args.marketplaceId ?? 'EBAY_US')));

  add('list_orders', {
    title: 'List orders',
    description:
      'List recent seller orders from the Sell Fulfillment API. Filter by fulfillment status and creation time, or pass a raw eBay filter. offset is the number of orders to skip.',
    inputSchema: listOrdersInput,
    annotations: readOnly,
  }, (args) => run(() => seller.listOrders(args)));

  add('get_order', {
    title: 'Get order',
    description: 'Get one seller order by orderId, including line items and shipping details returned by the Sell Fulfillment API.',
    inputSchema: getOrderInput,
    annotations: readOnly,
  }, (args) => run(() => seller.getOrder(args.orderId)));

  add('get_seller_identity', {
    title: 'Get seller identity',
    description: 'Read the connected eBay username, user id, and account type. Use this to confirm the seller account before changing listings.',
    inputSchema: z.object({}).strict(),
    annotations: readOnly,
  }, () => run(() => seller.getSellerIdentity()));

  const missing = TOOL_NAMES.filter((name) => !registered.includes(name));
  if (missing.length > 0 || registered.length !== TOOL_NAMES.length) {
    throw new Error(`Tool registration mismatch: ${missing.join(', ')}`);
  }
}
