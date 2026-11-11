export type EbayEnvironment = 'sandbox' | 'production';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  ebayEnv: EbayEnvironment;
  clientId?: string;
  clientSecret?: string;
  ruName?: string;
  refreshToken?: string;
  encryptionKey?: string;
  tokenStorePath: string;
  mcpAuthToken?: string;
  port: number;
  host: string;
  publicBaseUrl?: string;
  contentLanguage?: string;
  apiBaseUrl?: string;
  authBaseUrl?: string;
  identityBaseUrl?: string;
  allowedHosts: string[];
  allowedOriginHostnames: string[];
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hostnameFrom(entry: string): string {
  const value = entry.trim();
  if (!value) return '';
  if (value.includes('://')) {
    return new URL(value).hostname;
  }
  return value.replace(/:\d+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const ebayEnvRaw = blank(env.EBAY_ENV) ?? 'sandbox';
  if (ebayEnvRaw !== 'sandbox' && ebayEnvRaw !== 'production') {
    throw new ConfigError('EBAY_ENV must be "sandbox" or "production".');
  }

  const portRaw = blank(env.PORT) ?? '8787';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('PORT must be an integer from 1 to 65535.');
  }

  const publicBaseUrl = blank(env.PUBLIC_BASE_URL);
  if (publicBaseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(publicBaseUrl);
    } catch {
      throw new ConfigError('PUBLIC_BASE_URL must be an absolute http(s) URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigError('PUBLIC_BASE_URL must use http or https.');
    }
    if (parsed.username || parsed.password) {
      throw new ConfigError('PUBLIC_BASE_URL must not include credentials.');
    }
  }

  const mcpAuthToken = blank(env.MCP_AUTH_TOKEN);
  if (mcpAuthToken && mcpAuthToken.length < 16) {
    throw new ConfigError('MCP_AUTH_TOKEN must be at least 16 characters. Generate one with openssl rand -hex 32.');
  }

  const encryptionKey = blank(env.TOKEN_ENCRYPTION_KEY);
  if (encryptionKey && encryptionKey.length < 16) {
    throw new ConfigError('TOKEN_ENCRYPTION_KEY must be at least 16 characters.');
  }

  const allowedHosts = (blank(env.ALLOWED_HOSTS) ?? '')
    .split(',')
    .map(hostnameFrom)
    .filter(Boolean);
  const allowedOrigins = (blank(env.ALLOWED_ORIGINS) ?? '')
    .split(',')
    .map(hostnameFrom)
    .filter(Boolean);
  const publicHost = publicBaseUrl ? new URL(publicBaseUrl).hostname : undefined;

  return {
    ebayEnv: ebayEnvRaw,
    clientId: blank(env.EBAY_CLIENT_ID),
    clientSecret: blank(env.EBAY_CLIENT_SECRET),
    ruName: blank(env.EBAY_RU_NAME),
    refreshToken: blank(env.EBAY_REFRESH_TOKEN),
    encryptionKey,
    tokenStorePath: blank(env.TOKEN_STORE_PATH) ?? './data/ebay-tokens.enc',
    mcpAuthToken,
    port,
    host: blank(env.HOST) ?? '0.0.0.0',
    publicBaseUrl,
    contentLanguage: blank(env.EBAY_CONTENT_LANGUAGE),
    apiBaseUrl: blank(env.EBAY_API_BASE_URL),
    authBaseUrl: blank(env.EBAY_AUTH_BASE_URL),
    identityBaseUrl: blank(env.EBAY_IDENTITY_BASE_URL),
    allowedHosts,
    allowedOriginHostnames: unique([
      'localhost',
      '127.0.0.1',
      '::1',
      ...(publicHost ? [publicHost] : []),
      ...allowedHosts,
      ...allowedOrigins,
    ]),
  };
}

export function requireAppCredentials(config: AppConfig): { clientId: string; clientSecret: string } {
  if (!config.clientId || !config.clientSecret) {
    throw new ConfigError('EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are required before eBay can be called.');
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function apiRoot(config: AppConfig): string {
  if (config.apiBaseUrl) return stripSlash(config.apiBaseUrl);
  return config.ebayEnv === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

export function authRoot(config: AppConfig): string {
  if (config.authBaseUrl) return stripSlash(config.authBaseUrl);
  return config.ebayEnv === 'sandbox' ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';
}

export function identityRoot(config: AppConfig): string {
  if (config.identityBaseUrl) return stripSlash(config.identityBaseUrl);
  return config.ebayEnv === 'sandbox' ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com';
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
