import { apiRoot, identityRoot, type AppConfig } from './config.js';
import { TokenManager } from './oauth.js';

export class EbayApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'EbayApiError';
    this.status = status;
  }
}

export interface EbayResponse {
  status: number;
  body: unknown;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  contentLanguage?: string;
  missing?: 'null' | 'error';
}

export class EbayClient {
  constructor(
    private readonly config: AppConfig,
    private readonly tokens: TokenManager,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  redact(text: string): string {
    return this.tokens.redact(text);
  }

  userRequest(method: string, path: string, options?: RequestOptions): Promise<EbayResponse> {
    return this.request('user', method, `${apiRoot(this.config)}${path}`, options);
  }

  appRequest(method: string, path: string, options?: RequestOptions): Promise<EbayResponse> {
    return this.request('app', method, `${apiRoot(this.config)}${path}`, options);
  }

  identityRequest(method: string, path: string, options?: RequestOptions): Promise<EbayResponse> {
    return this.request('user', method, `${identityRoot(this.config)}${path}`, options);
  }

  private async request(
    auth: 'user' | 'app',
    method: string,
    url: string,
    options: RequestOptions = {},
  ): Promise<EbayResponse> {
    const target = withQuery(url, options.query);
    const token = auth === 'user' ? await this.tokens.getUserAccessToken() : await this.tokens.getApplicationAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': 'ebay-seller-mcp/1.0.0',
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.contentLanguage) headers['content-language'] = options.contentLanguage;

    const response = await this.fetchImpl(target, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status >= 300 && response.status < 400) {
      throw new EbayApiError(this.redact(`eBay returned an unexpected redirect (${response.status}).`), response.status);
    }

    const text = await response.text();
    const parsed = parseBody(text);
    const pathname = safePath(target);
    console.log(`eBay ${method} ${pathname} -> ${response.status}`);

    if (response.status === 404 && options.missing === 'null') {
      return { status: 404, body: null };
    }

    if (response.status < 200 || response.status >= 300) {
      throw new EbayApiError(this.redact(errorMessage(response.status, parsed)), response.status);
    }
    return { status: response.status, body: parsed };
  }
}

function withQuery(url: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function errorMessage(status: number, body: unknown): string {
  const record = asRecord(body);
  const errors = record && Array.isArray(record.errors) ? record.errors : [];
  if (errors.length > 0) {
    const parts = errors.map((entry) => {
      const error = asRecord(entry);
      if (!error) return 'eBay error';
      const id = typeof error.errorId === 'number' ? `${error.errorId}: ` : '';
      const message = stringField(error.longMessage) || stringField(error.message) || 'eBay error';
      return `${id}${message}`;
    });
    return `eBay request failed (${status}). ${parts.join(' ')}`;
  }
  const description = stringField(record?.error_description) || stringField(record?.error);
  if (description) return `eBay request failed (${status}). ${description}`;
  return `eBay request failed (${status}).`;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
