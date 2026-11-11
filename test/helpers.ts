import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../src/config.js';

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export async function startMock(
  handler: (request: RecordedRequest, response: ServerResponse) => void,
): Promise<{ url: string; recorded: RecordedRequest[]; close: () => Promise<void> }> {
  const recorded: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    recorded.push(request);
    handler(request, res);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    recorded,
    close: () => closeServer(server),
  };
}

export function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === null ? '' : JSON.stringify(body));
}

export function testConfig(overrides: Partial<AppConfig> & Pick<AppConfig, 'tokenStorePath'>): AppConfig {
  return {
    ebayEnv: 'sandbox',
    clientId: 'client-id-value-xyz',
    clientSecret: 'client-secret-value-xyz',
    ruName: 'Seller_MCP-RuName-SBX',
    refreshToken: 'refresh-token-value-xyz',
    encryptionKey: 'encryption-key-value-xyz',
    mcpAuthToken: undefined,
    port: 0,
    host: '127.0.0.1',
    publicBaseUrl: undefined,
    contentLanguage: undefined,
    apiBaseUrl: undefined,
    authBaseUrl: undefined,
    identityBaseUrl: undefined,
    allowedHosts: [],
    allowedOriginHostnames: ['localhost', '127.0.0.1', '::1'],
    ...overrides,
  };
}

export interface RpcResult {
  status: number;
  text: string;
  body: unknown;
  headers: Headers;
}

export async function mcpRequest(url: string, message: unknown, headers: Record<string, string> = {}): Promise<RpcResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return { status: response.status, text, body: parseRpc(text), headers: response.headers };
}

export function parseRpc(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed) as unknown;
  const events = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (events.length === 0) return { raw: trimmed };
  return JSON.parse(events[events.length - 1] ?? '') as unknown;
}

export async function listTools(base: string, token?: string): Promise<RpcResult> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init = await mcpRequest(
    `${base}/mcp`,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'ebay-mcp-test', version: '1.0.0' },
      },
    },
    headers,
  );
  const session = init.headers.get('mcp-session-id');
  if (session) headers['mcp-session-id'] = session;
  headers['mcp-protocol-version'] = init.headers.get('mcp-protocol-version') ?? '2025-11-25';
  await mcpRequest(`${base}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  return mcpRequest(`${base}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers);
}

export async function callTool(
  base: string,
  name: string,
  args: unknown,
  token?: string,
): Promise<RpcResult> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init = await mcpRequest(
    `${base}/mcp`,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'ebay-mcp-test', version: '1.0.0' },
      },
    },
    headers,
  );
  const session = init.headers.get('mcp-session-id');
  if (session) headers['mcp-session-id'] = session;
  headers['mcp-protocol-version'] = init.headers.get('mcp-protocol-version') ?? '2025-11-25';
  return mcpRequest(
    `${base}/mcp`,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    headers,
  );
}
