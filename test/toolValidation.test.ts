import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  bulkUpdatePriceQuantityInput,
  createOfferInput,
  createOrReplaceInventoryItemInput,
  publishOfferInput,
} from '../src/schemas.js';
import { TOOL_NAMES } from '../src/registerTools.js';
import { createHttpServer } from '../src/server.js';
import {
  callTool,
  closeServer,
  json,
  listen,
  listTools,
  startMock,
  testConfig,
  type RecordedRequest,
} from './helpers.js';
import type { ServerResponse } from 'node:http';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

describe('tool input schemas', () => {
  it('rejects inventory items with an http image, a bad condition, or a missing sku', () => {
    const image = createOrReplaceInventoryItemInput.safeParse({
      sku: 'SOCK-1',
      title: 'Wool socks',
      condition: 'NEW',
      quantity: 2,
      imageUrls: ['http://cdn.example/socks.jpg'],
    });
    assert.equal(image.success, false);

    const condition = createOrReplaceInventoryItemInput.safeParse({
      sku: 'SOCK-1',
      title: 'Wool socks',
      condition: 'BROKEN',
      quantity: 2,
    });
    assert.equal(condition.success, false);

    const sku = createOrReplaceInventoryItemInput.safeParse({
      title: 'Wool socks',
      condition: 'NEW',
      quantity: 1,
    });
    assert.equal(sku.success, false);

    const valid = createOrReplaceInventoryItemInput.safeParse({
      sku: 'SOCK-1',
      title: 'Wool socks',
      description: 'Grey marl crew socks',
      condition: 'NEW',
      quantity: 4,
      aspects: { Brand: 'Northwind', Color: ['Grey'] },
      imageUrls: ['https://cdn.example/socks.jpg'],
    });
    assert.equal(valid.success, true);
  });

  it('rejects offers missing a policy and bulk updates with a negative quantity', () => {
    const offer = createOfferInput.safeParse({
      sku: 'SOCK-1',
      marketplaceId: 'EBAY_US',
      categoryId: '11511',
      price: '12.00',
      quantity: 4,
      fulfillmentPolicyId: '100',
      returnPolicyId: '300',
      merchantLocationKey: 'warehouse-1',
    });
    assert.equal(offer.success, false);

    const price = createOfferInput.safeParse({
      sku: 'SOCK-1',
      marketplaceId: 'EBAY_US',
      categoryId: '11511',
      price: '12.999',
      quantity: 1,
      fulfillmentPolicyId: '100',
      paymentPolicyId: '200',
      returnPolicyId: '300',
      merchantLocationKey: 'warehouse-1',
    });
    assert.equal(price.success, false);

    const bulk = bulkUpdatePriceQuantityInput.safeParse({
      requests: [{ sku: 'SOCK-1', quantity: -1 }],
    });
    assert.equal(bulk.success, false);

    const publish = publishOfferInput.safeParse({ offerId: '' });
    assert.equal(publish.success, false);
  });
});

describe('MCP endpoint', () => {
  it('lists every tool and marks publish, withdraw, and delete as destructive', async () => {
    const mock = await startMock((_request, response) => {
      json(response, 500, { errors: [{ message: 'eBay should not be called' }] });
    });
    closers.push(mock.close);
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const app = createHttpServer(
      testConfig({
        tokenStorePath: join(dir, 'tokens.enc'),
        apiBaseUrl: mock.url,
        identityBaseUrl: mock.url,
      }),
    );
    const port = await listen(app);
    closers.push(() => closeServer(app));

    const listed = await listTools(`http://127.0.0.1:${port}`);
    assert.equal(listed.status, 200, listed.text);
    const rpc = listed.body as { result?: { tools?: Array<{ name: string; description?: string }> }; error?: unknown };
    const tools = rpc.result?.tools ?? [];
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...TOOL_NAMES],
      JSON.stringify(rpc.error ?? listed.text),
    );
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));
    for (const name of ['publish_offer', 'withdraw_offer', 'delete_inventory_item']) {
      assert.match(byName.get(name) ?? '', /DESTRUCTIVE/);
    }
    assert.equal(mock.recorded.length, 0);
  });

  it('rejects an invalid inventory write before calling eBay', async () => {
    const mock = await startMock((_request, response) => {
      json(response, 500, { errors: [{ message: 'eBay should not be called' }] });
    });
    closers.push(mock.close);
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const app = createHttpServer(
      testConfig({
        tokenStorePath: join(dir, 'tokens.enc'),
        apiBaseUrl: mock.url,
        identityBaseUrl: mock.url,
      }),
    );
    const port = await listen(app);
    closers.push(() => closeServer(app));

    const result = await callTool(`http://127.0.0.1:${port}`, 'create_or_replace_inventory_item', {
      sku: 'SOCK-1',
      title: 'Wool socks',
      condition: 'NEW',
      quantity: 1,
      imageUrls: ['http://cdn.example/socks.jpg'],
    });
    assert.equal(result.status, 200, result.text);
    const rpc = result.body as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
    const failed = rpc.result?.isError === true || Boolean(rpc.error);
    assert.equal(failed, true, result.text);
    const text = JSON.stringify(rpc);
    assert.match(text, /https|Image URL|invalid/i);
    assert.equal(mock.recorded.some((request) => request.path.startsWith('/sell/')), false);
    assert.equal(mock.recorded.some((request) => request.path.includes('oauth2/token')), false);
  });

  it('sends a validated inventory write with a refreshed bearer token and redacts secrets', async () => {
    const mock = await startMock((request, response) => happyEbay(request, response));
    closers.push(mock.close);
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const app = createHttpServer(
      testConfig({
        tokenStorePath: join(dir, 'tokens.enc'),
        apiBaseUrl: mock.url,
        identityBaseUrl: mock.url,
      }),
    );
    const port = await listen(app);
    closers.push(() => closeServer(app));
    const base = `http://127.0.0.1:${port}`;

    const created = await callTool(base, 'create_or_replace_inventory_item', {
      sku: 'SOCK-1',
      title: 'Wool socks',
      description: 'Grey marl crew socks',
      condition: 'NEW',
      quantity: 4,
      aspects: { Brand: 'Northwind', Size: ['M', 'L'] },
      imageUrls: ['https://cdn.example/socks.jpg'],
    });
    assert.equal(created.status, 200, created.text);
    const createdRpc = created.body as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    assert.notEqual(createdRpc.result?.isError, true, created.text);

    const put = mock.recorded.find((request) => request.method === 'PUT');
    assert.ok(put);
    assert.equal(put.path, '/sell/inventory/v1/inventory_item/SOCK-1');
    assert.equal(put.headers.authorization, 'Bearer access-token-value-xyz');
    assert.equal(put.headers['content-language'], 'en-US');
    const payload = JSON.parse(put.body) as {
      condition: string;
      product: { title: string; aspects: Record<string, string[]>; imageUrls: string[] };
      availability: { shipToLocationAvailability: { quantity: number } };
    };
    assert.equal(payload.condition, 'NEW');
    assert.equal(payload.product.title, 'Wool socks');
    assert.deepEqual(payload.product.aspects.Brand, ['Northwind']);
    assert.deepEqual(payload.product.aspects.Size, ['M', 'L']);
    assert.deepEqual(payload.product.imageUrls, ['https://cdn.example/socks.jpg']);
    assert.equal(payload.availability.shipToLocationAvailability.quantity, 4);

    const refresh = mock.recorded.find((request) => request.path === '/identity/v1/oauth2/token');
    assert.ok(refresh);
    assert.equal(new URLSearchParams(refresh.body).get('grant_type'), 'refresh_token');

    const published = await callTool(base, 'publish_offer', { offerId: 'offer-1' });
    const publishedRpc = published.body as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    assert.notEqual(publishedRpc.result?.isError, true, published.text);
    const text = publishedRpc.result?.content?.[0]?.text ?? '';
    assert.match(text, /https:\/\/www\.sandbox\.ebay\.com\/itm\/999888/);
    assert.equal(text.includes('access-token-value-xyz'), false);
    assert.equal(text.includes('refresh-token-value-xyz'), false);
    assert.equal(text.includes('client-secret-value-xyz'), false);
  });

  it('requires the MCP bearer token and rejects a foreign Origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const token = 'mcp-auth-token-0123456789';
    const app = createHttpServer(
      testConfig({
        tokenStorePath: join(dir, 'tokens.enc'),
        mcpAuthToken: token,
        publicBaseUrl: 'https://seller.example',
      }),
    );
    const port = await listen(app);
    closers.push(() => closeServer(app));
    const base = `http://127.0.0.1:${port}`;

    const denied = await listTools(base);
    assert.equal(denied.status, 401);

    const allowed = await listTools(base, token);
    assert.equal(allowed.status, 200, allowed.text);
    const rpc = allowed.body as { result?: { tools?: unknown[] } };
    assert.equal(rpc.result?.tools?.length, TOOL_NAMES.length);

    const foreign = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        origin: 'https://evil.example',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'ebay-mcp-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(foreign.status, 403);

    const badHost = await postHost(port, 'evil.example', token);
    assert.equal(badHost, 403);
  });
});

function happyEbay(request: RecordedRequest, response: ServerResponse): void {
  if (request.path === '/identity/v1/oauth2/token') {
    json(response, 200, { access_token: 'access-token-value-xyz', expires_in: 7200, token_type: 'User Access Token' });
    return;
  }
  if (request.method === 'GET' && request.path === '/sell/inventory/v1/inventory_item/SOCK-1') {
    json(response, 404, { errors: [{ errorId: 25701, message: 'Inventory item not found' }] });
    return;
  }
  if (request.method === 'PUT' && request.path === '/sell/inventory/v1/inventory_item/SOCK-1') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === 'GET' && request.path === '/sell/inventory/v1/offer/offer-1') {
    json(response, 200, {
      offerId: 'offer-1',
      sku: 'SOCK-1',
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      status: 'UNPUBLISHED',
      categoryId: '11511',
      availableQuantity: 4,
    });
    return;
  }
  if (request.method === 'POST' && request.path === '/sell/inventory/v1/offer/offer-1/publish') {
    json(response, 200, {
      listingId: '999888',
      debug: 'access-token-value-xyz refresh-token-value-xyz client-secret-value-xyz',
    });
    return;
  }
  json(response, 500, { errors: [{ message: `unexpected ${request.method} ${request.path}` }] });
}

function postHost(port: number, host: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'ebay-mcp-test', version: '1.0.0' },
        },
      }),
    );
  });
}
