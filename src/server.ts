import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import { EbayClient } from './ebayClient.js';
import { createOauthState, TokenManager } from './oauth.js';
import { authFormPage, connectedPage, homePage, messagePage, revealedTokenPage, revealFormPage } from './pages.js';
import { registerTools, serverInstructions } from './registerTools.js';
import { secureEquals } from './security.js';
import { EbaySeller } from './sell.js';
import { TokenStore } from './tokenStore.js';

const SERVER_VERSION = '1.0.0';

export interface ServerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createHttpServer(config: AppConfig, options: ServerOptions = {}) {
  const store = new TokenStore(config.tokenStorePath, config.encryptionKey, config.refreshToken);
  const tokens = new TokenManager(config, store, options.fetchImpl ?? fetch, options.now ?? Date.now);
  const seller = new EbaySeller(new EbayClient(config, tokens, options.fetchImpl ?? fetch), config);
  const states = new Map<string, number>();
  let pendingRefreshToken: string | null = null;

  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        {
          name: 'ebay-seller',
          version: SERVER_VERSION,
        },
        { instructions: serverInstructions() },
      );
      registerTools(server, seller);
      return server;
    },
    {
      onerror: (error) => {
        console.error(`MCP error: ${tokens.redact(error.message)}`);
      },
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => {
      console.error(`MCP transport error: ${tokens.redact(error.message)}`);
    },
  });

  const allowedHosts = hostAllowList(config);
  const validateHost = allowedHosts ? hostHeaderValidation(allowedHosts) : null;
  const validateOrigin = originValidation(config.allowedOriginHostnames);

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      const message = error instanceof Error ? tokens.redact(error.message) : 'Internal error';
      console.error(message);
      sendJson(res, 500, { error: 'Internal error' });
    });
  });

  server.on('close', () => {
    void handler.close();
  });

  return server;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    const pathname = url.pathname;
    if (pathname === '/mcp' || pathname === '/mcp/') {
      if (!authorize(req, res)) return;
      if (validateHost && !validateHost(req, res)) return;
      if (!validateOrigin(req, res)) return;
      await nodeHandler(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, await healthBody());
      return;
    }
    if (req.method === 'GET' && pathname === '/') {
      sendHtml(res, 200, homePage(await pageStatus()));
      return;
    }
    if (pathname === '/auth/start') {
      await startAuth(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/auth/callback') {
      await finishAuth(url, res);
      return;
    }
    if (pathname === '/auth/refresh-token') {
      await revealRefreshToken(req, res);
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  async function healthBody(): Promise<Record<string, unknown>> {
    const tokensStatus = await store.status();
    return {
      ok: true,
      service: 'ebay-seller-mcp',
      version: SERVER_VERSION,
      ebayEnv: config.ebayEnv,
      clientConfigured: Boolean(config.clientId && config.clientSecret),
      ruNameConfigured: Boolean(config.ruName),
      refreshTokenStored: tokensStatus.readable,
      tokenSource: tokensStatus.source,
      mcpAuthRequired: Boolean(config.mcpAuthToken),
    };
  }

  async function pageStatus() {
    return {
      ebayEnv: config.ebayEnv,
      clientConfigured: Boolean(config.clientId && config.clientSecret),
      ruNameConfigured: Boolean(config.ruName),
      mcpAuthRequired: Boolean(config.mcpAuthToken),
      tokens: await store.status(),
    };
  }

  async function startAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const headerOk = bearerMatches(req, config.mcpAuthToken);
    let formOk = false;
    if (req.method === 'POST') {
      const raw = await readBody(req, 8_192);
      const contentType = headerValue(req.headers['content-type']);
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const token = new URLSearchParams(raw).get('token') ?? '';
        formOk = config.mcpAuthToken ? secureEquals(token, config.mcpAuthToken) : true;
      } else if (!headerOk) {
        sendJson(res, 415, { error: 'Send the form as application/x-www-form-urlencoded.' });
        return;
      }
    }
    if (config.mcpAuthToken && !headerOk && !formOk) {
      if (req.method === 'GET') {
        sendHtml(res, 200, authFormPage());
        return;
      }
      sendHtml(res, 401, messagePage('Not authorized', 'The MCP auth token did not match.'));
      return;
    }
    let location: string;
    try {
      const now = Date.now();
      for (const [key, expiry] of states) {
        if (expiry < now) states.delete(key);
      }
      const state = createOauthState();
      states.set(state, now + 10 * 60 * 1000);
      location = tokens.buildConsentUrl(state);
    } catch (error) {
      const message = error instanceof Error ? tokens.redact(error.message) : 'OAuth is not configured.';
      sendHtml(res, 400, messagePage('OAuth is not configured', message));
      return;
    }
    res.writeHead(302, {
      location,
      'cache-control': 'no-store',
    });
    res.end();
  }

  async function finishAuth(url: URL, res: ServerResponse): Promise<void> {
    const oauthError = url.searchParams.get('error') ?? url.searchParams.get('denied');
    if (oauthError) {
      sendHtml(res, 400, messagePage('eBay authorization was declined', 'No token was stored. Start again at /auth/start.'));
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    const expiresAt = states.get(state);
    states.delete(state);
    if (!state || !expiresAt || expiresAt < Date.now()) {
      sendHtml(
        res,
        400,
        messagePage('Authorization expired', 'This sign-in attempt is invalid or expired. Start again at /auth/start.'),
      );
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      sendHtml(res, 400, messagePage('Missing authorization code', 'eBay did not return a code. Start again at /auth/start.'));
      return;
    }
    try {
      await tokens.exchangeAuthorizationCode(code);
      pendingRefreshToken = await store.getRefreshToken();
    } catch (error) {
      const message = error instanceof Error ? tokens.redact(error.message) : 'eBay did not complete authorization.';
      sendHtml(res, 502, messagePage('eBay authorization failed', message));
      return;
    }
    sendHtml(res, 200, connectedPage(Boolean(config.mcpAuthToken)));
  }

  async function revealRefreshToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    if (!config.mcpAuthToken) {
      sendHtml(
        res,
        403,
        messagePage(
          'MCP auth token required',
          'Set MCP_AUTH_TOKEN before the refresh token can be shown. Nothing was displayed.',
        ),
      );
      return;
    }
    const headerOk = bearerMatches(req, config.mcpAuthToken);
    let formOk = false;
    if (req.method === 'POST') {
      const raw = await readBody(req, 8_192);
      const contentType = headerValue(req.headers['content-type']);
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const token = new URLSearchParams(raw).get('token') ?? '';
        formOk = secureEquals(token, config.mcpAuthToken);
      } else if (!headerOk) {
        sendJson(res, 415, { error: 'Send the form as application/x-www-form-urlencoded.' });
        return;
      }
    }
    if (!headerOk && !formOk) {
      if (req.method === 'GET') {
        sendHtml(res, 200, revealFormPage());
        return;
      }
      sendHtml(res, 401, messagePage('Not authorized', 'The MCP auth token did not match. The refresh token was not shown.'));
      return;
    }
    if (!pendingRefreshToken) {
      sendHtml(
        res,
        404,
        messagePage(
          'No refresh token is waiting',
          'Finish eBay sign-in at /auth/start. After a restart, set EBAY_REFRESH_TOKEN instead. Nothing was displayed.',
        ),
      );
      return;
    }
    const refreshToken = pendingRefreshToken;
    pendingRefreshToken = null;
    sendHtml(res, 200, revealedTokenPage(refreshToken));
  }

  function authorize(req: IncomingMessage, res: ServerResponse): boolean {
    if (!config.mcpAuthToken) return true;
    if (bearerMatches(req, config.mcpAuthToken)) return true;
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': 'Bearer',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
}

function bearerMatches(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return false;
  const header = headerValue(req.headers.authorization);
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return secureEquals(header.slice(prefix.length), expected);
}

function hostAllowList(config: AppConfig): string[] | null {
  const fromPublic = config.publicBaseUrl ? [new URL(config.publicBaseUrl).hostname] : [];
  if (fromPublic.length === 0 && config.allowedHosts.length === 0) return null;
  return [...new Set(['localhost', '127.0.0.1', '::1', '[::1]', ...fromPublic, ...config.allowedHosts])];
}

function requestUrl(req: IncomingMessage): URL {
  const host = headerValue(req.headers.host) || 'localhost';
  return new URL(req.url ?? '/', `http://${host}`);
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}
