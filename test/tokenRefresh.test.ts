import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { USER_SCOPES } from '../src/oauth.js';
import { TokenManager } from '../src/oauth.js';
import { TokenStore } from '../src/tokenStore.js';
import { createHttpServer } from '../src/server.js';
import { closeServer, json, listen, startMock, testConfig, type RecordedRequest } from './helpers.js';
import type { ServerResponse } from 'node:http';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

describe('token refresh', () => {
  it('refreshes once, reuses the access token, and refreshes again after expiry', async () => {
    let clock = 1_700_000_000_000;
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const params = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'refresh-token-value-xyz');
      for (const scope of USER_SCOPES) {
        assert.ok(params.get('scope')?.includes(scope), scope);
      }
      const header = new Headers(init?.headers).get('authorization') ?? '';
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      assert.equal(decoded, 'client-id-value-xyz:client-secret-value-xyz');
      return new Response(
        JSON.stringify({ access_token: 'access-token-value-xyz', expires_in: 7200, token_type: 'User Access Token' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const manager = new TokenManager(testConfig({ tokenStorePath: join(dir, 'tokens.enc') }), new TokenStore(join(dir, 'tokens.enc'), 'encryption-key-value-xyz', 'refresh-token-value-xyz'), fetchImpl, () => clock);

    const first = await manager.getUserAccessToken();
    const second = await manager.getUserAccessToken();
    assert.equal(first, 'access-token-value-xyz');
    assert.equal(second, first);
    assert.equal(calls, 1);

    clock += 7200 * 1000;
    const third = await manager.getUserAccessToken();
    assert.equal(third, 'access-token-value-xyz');
    assert.equal(calls, 2);
  });

  it('shares one in-flight refresh across concurrent callers', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify({ access_token: 'access-token-value-xyz', expires_in: 7200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const path = join(dir, 'tokens.enc');
    const manager = new TokenManager(
      testConfig({ tokenStorePath: path }),
      new TokenStore(path, 'encryption-key-value-xyz', 'refresh-token-value-xyz'),
      fetchImpl,
    );
    const pending = Promise.all([manager.getUserAccessToken(), manager.getUserAccessToken(), manager.getUserAccessToken()]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1);
    release();
    const tokens = await pending;
    assert.deepEqual(tokens, ['access-token-value-xyz', 'access-token-value-xyz', 'access-token-value-xyz']);
    assert.equal(calls, 1);
  });

  it('does not return the refresh token when eBay rejects it', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'refresh token refresh-token-value-xyz is invalid',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const path = join(dir, 'tokens.enc');
    const manager = new TokenManager(
      testConfig({ tokenStorePath: path }),
      new TokenStore(path, 'encryption-key-value-xyz', 'refresh-token-value-xyz'),
      fetchImpl,
    );
    await assert.rejects(manager.getUserAccessToken(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /rejected the refresh token|invalid/i);
      assert.equal(error.message.includes('refresh-token-value-xyz'), false);
      assert.equal(error.message.includes('client-secret-value-xyz'), false);
      return true;
    });
  });

  it('stores the authorization-code refresh token encrypted and hides it from the callback page', async () => {
    const mock = await startMock((request, response) => tokenHandler(request, response));
    closers.push(mock.close);
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const tokenStorePath = join(dir, 'tokens.enc');
    const app = createHttpServer(
      testConfig({
        tokenStorePath,
        refreshToken: undefined,
        apiBaseUrl: mock.url,
        authBaseUrl: 'https://auth.example.test',
        identityBaseUrl: mock.url,
      }),
    );
    const port = await listen(app);
    closers.push(() => closeServer(app));

    const start = await fetch(`http://127.0.0.1:${port}/auth/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const location = start.headers.get('location') ?? '';
    assert.equal(location.includes('client-secret-value-xyz'), false);
    const consent = new URL(location);
    assert.equal(consent.origin, 'https://auth.example.test');
    assert.equal(consent.searchParams.get('client_id'), 'client-id-value-xyz');
    assert.equal(consent.searchParams.get('redirect_uri'), 'Seller_MCP-RuName-SBX');
    assert.equal(consent.searchParams.get('response_type'), 'code');
    const state = consent.searchParams.get('state');
    assert.ok(state);

    const code = 'authorization-code-value-xyz';
    const callback = await fetch(
      `http://127.0.0.1:${port}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? '')}`,
    );
    const html = await callback.text();
    assert.equal(callback.status, 200);
    assert.equal(html.includes('refresh-from-auth-code-xyz'), false);
    assert.equal(html.includes(code), false);
    assert.equal(html.includes('client-secret-value-xyz'), false);
    assert.match(html, /not shown/);

    const stored = await readFile(tokenStorePath);
    assert.equal(stored.includes('refresh-from-auth-code-xyz'), false);
    assert.equal(stored.subarray(0, 8).toString('utf8'), 'EBAYMCP1');

    const reloaded = new TokenStore(tokenStorePath, 'encryption-key-value-xyz', undefined);
    assert.equal(await reloaded.getRefreshToken(), 'refresh-from-auth-code-xyz');

    const exchange = mock.recorded.find((request) => request.path === '/identity/v1/oauth2/token');
    assert.ok(exchange);
    const params = new URLSearchParams(exchange.body);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('code'), code);
    assert.equal(params.get('redirect_uri'), 'Seller_MCP-RuName-SBX');

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await health.json() as { refreshTokenStored: boolean; tokenSource: string };
    assert.equal(body.refreshTokenStored, true);
    assert.equal(body.tokenSource, 'file');
    assert.equal(JSON.stringify(body).includes('refresh-from-auth-code-xyz'), false);

    const reveal = await fetch(`http://127.0.0.1:${port}/auth/refresh-token`, { method: 'POST' });
    const revealHtml = await reveal.text();
    assert.equal(reveal.status, 403);
    assert.equal(revealHtml.includes('refresh-from-auth-code-xyz'), false);
  });

  it('uses EBAY_REFRESH_TOKEN when no token file exists, including after a new process starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const tokenStorePath = join(dir, 'tokens.enc');
    const envToken = 'env-refresh-token-xyz';
    const oauthToken = 'oauth-refresh-token-xyz';
    const cold = new TokenStore(tokenStorePath, 'encryption-key-value-xyz', envToken);
    assert.equal(await cold.getRefreshToken(), envToken);

    const running = new TokenStore(tokenStorePath, 'encryption-key-value-xyz', envToken);
    assert.equal(await running.save({ refreshToken: oauthToken, updatedAt: '2026-11-11T00:00:00.000Z' }), 'file');
    await unlink(tokenStorePath);
    assert.equal(await running.getRefreshToken(), oauthToken);

    const restarted = new TokenStore(tokenStorePath, 'encryption-key-value-xyz', envToken);
    assert.equal(await restarted.getRefreshToken(), envToken);
  });

  it('shows the OAuth refresh token once after the MCP auth token is posted', async () => {
    const mock = await startMock((request, response) => tokenHandler(request, response));
    closers.push(mock.close);
    const dir = await mkdtemp(join(tmpdir(), 'ebay-mcp-'));
    const mcpAuthToken = 'mcp-auth-token-0123456789';
    const app = createHttpServer(
      testConfig({
        tokenStorePath: join(dir, 'tokens.enc'),
        refreshToken: undefined,
        mcpAuthToken,
        apiBaseUrl: mock.url,
        authBaseUrl: 'https://auth.example.test',
        identityBaseUrl: mock.url,
      }),
    );
    const port = await listen(app);
    closers.push(() => closeServer(app));
    const base = `http://127.0.0.1:${port}`;

    const start = await fetch(`${base}/auth/start`, {
      headers: { authorization: `Bearer ${mcpAuthToken}` },
      redirect: 'manual',
    });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const callback = await fetch(`${base}/auth/callback?code=authorization-code-value-xyz&state=${encodeURIComponent(state)}`);
    const callbackHtml = await callback.text();
    assert.equal(callback.status, 200);
    assert.equal(callbackHtml.includes('refresh-from-auth-code-xyz'), false);
    assert.match(callbackHtml, /not shown on this page/);

    const wrong = await fetch(`${base}/auth/refresh-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=not-the-mcp-token',
    });
    const wrongHtml = await wrong.text();
    assert.equal(wrong.status, 401);
    assert.equal(wrongHtml.includes('refresh-from-auth-code-xyz'), false);

    const shown = await fetch(`${base}/auth/refresh-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: mcpAuthToken }),
    });
    const shownHtml = await shown.text();
    assert.equal(shown.status, 200);
    assert.equal(shownHtml.includes('refresh-from-auth-code-xyz'), true);
    assert.equal(shown.headers.get('cache-control'), 'no-store');

    const again = await fetch(`${base}/auth/refresh-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: mcpAuthToken }),
    });
    const againHtml = await again.text();
    assert.equal(again.status, 404);
    assert.equal(againHtml.includes('refresh-from-auth-code-xyz'), false);
  });
});

function tokenHandler(request: RecordedRequest, response: ServerResponse): void {
  if (request.path !== '/identity/v1/oauth2/token') {
    json(response, 404, { errors: [{ message: 'not found' }] });
    return;
  }
  const params = new URLSearchParams(request.body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  json(response, 200, {
    access_token: 'access-from-auth-code-xyz',
    expires_in: 7200,
    refresh_token: 'refresh-from-auth-code-xyz',
    refresh_token_expires_in: 47304000,
    token_type: 'User Access Token',
  });
}
