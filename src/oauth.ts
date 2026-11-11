import { randomBytes } from 'node:crypto';
import { apiRoot, authRoot, requireAppCredentials, type AppConfig } from './config.js';
import { redactSecrets } from './security.js';
import { TokenStore, type TokenRecord } from './tokenStore.js';

export const USER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
] as const;

export const APPLICATION_SCOPE = 'https://api.ebay.com/oauth/api_scope';

const REFRESH_SKEW_MS = 60_000;

interface CachedAccess {
  token: string;
  expiresAt: number;
}

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export class TokenManager {
  private userAccess?: CachedAccess;
  private appAccess?: CachedAccess;
  private userFlight?: Promise<string>;
  private appFlight?: Promise<string>;

  constructor(
    private readonly config: AppConfig,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  redact(text: string): string {
    return redactSecrets(text, this.secretValues());
  }

  getUserAccessToken(): Promise<string> {
    if (this.userAccess && this.now() < this.userAccess.expiresAt - REFRESH_SKEW_MS) {
      return Promise.resolve(this.userAccess.token);
    }
    if (!this.userFlight) {
      this.userFlight = this.refreshUser().finally(() => {
        this.userFlight = undefined;
      });
    }
    return this.userFlight;
  }

  getApplicationAccessToken(): Promise<string> {
    if (this.appAccess && this.now() < this.appAccess.expiresAt - REFRESH_SKEW_MS) {
      return Promise.resolve(this.appAccess.token);
    }
    if (!this.appFlight) {
      this.appFlight = this.mintApplication().finally(() => {
        this.appFlight = undefined;
      });
    }
    return this.appFlight;
  }

  buildConsentUrl(state: string): string {
    const { clientId } = requireAppCredentials(this.config);
    if (!this.config.ruName) {
      throw new Error('EBAY_RU_NAME is required. Use the RuName from the eBay developer portal, not the accept URL.');
    }
    const url = new URL('/oauth2/authorize', `${authRoot(this.config)}/`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.config.ruName);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', USER_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<void> {
    let token: OAuthTokenResponse;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.ruName ?? '',
      });
      token = await this.postToken(body, 'eBay rejected the authorization code. Start again at /auth/start.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authorization failed';
      throw new Error(code.length >= 8 ? this.redact(message).split(code).join('[redacted]') : this.redact(message));
    }
    if (!token.refresh_token || !token.access_token) {
      throw new Error('eBay did not return a refresh token. Check that the RuName and scopes match this keyset.');
    }
    const record: TokenRecord = {
      refreshToken: token.refresh_token,
      updatedAt: new Date(this.now()).toISOString(),
    };
    if (typeof token.refresh_token_expires_in === 'number') {
      record.refreshTokenExpiresAt = new Date(this.now() + token.refresh_token_expires_in * 1000).toISOString();
    }
    await this.store.save(record);
    this.userAccess = {
      token: token.access_token,
      expiresAt: this.now() + (token.expires_in ?? 7200) * 1000,
    };
  }

  private async refreshUser(): Promise<string> {
    const refreshToken = await this.store.getRefreshToken();
    if (!refreshToken) {
      throw new Error('No eBay user refresh token is configured. Set EBAY_REFRESH_TOKEN or open /auth/start.');
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: USER_SCOPES.join(' '),
    });
    const token = await this.postToken(body, 'eBay rejected the refresh token. Re-authorize at /auth/start.');
    if (!token.access_token) {
      throw new Error('eBay did not return an access token.');
    }
    if (token.refresh_token && token.refresh_token !== refreshToken) {
      await this.store.save({
        refreshToken: token.refresh_token,
        updatedAt: new Date(this.now()).toISOString(),
        ...(typeof token.refresh_token_expires_in === 'number'
          ? { refreshTokenExpiresAt: new Date(this.now() + token.refresh_token_expires_in * 1000).toISOString() }
          : {}),
      });
    }
    this.userAccess = {
      token: token.access_token,
      expiresAt: this.now() + (token.expires_in ?? 7200) * 1000,
    };
    return token.access_token;
  }

  private async mintApplication(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: APPLICATION_SCOPE,
    });
    const token = await this.postToken(
      body,
      'eBay rejected the application token request. The keyset needs the client-credentials grant.',
    );
    if (!token.access_token) {
      throw new Error('eBay did not return an application access token.');
    }
    this.appAccess = {
      token: token.access_token,
      expiresAt: this.now() + (token.expires_in ?? 7200) * 1000,
    };
    return token.access_token;
  }

  private async postToken(body: URLSearchParams, fallback: string): Promise<OAuthTokenResponse> {
    const { clientId, clientSecret } = requireAppCredentials(this.config);
    const response = await this.fetchImpl(`${apiRoot(this.config)}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
        accept: 'application/json',
      },
      body,
      redirect: 'manual',
    });
    const text = await response.text();
    let parsed: OAuthTokenResponse = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as OAuthTokenResponse;
      } catch {
        parsed = {};
      }
    }
    if (response.status < 200 || response.status >= 300 || !parsed.access_token) {
      const detail = parsed.error_description || parsed.error || fallback;
      throw new Error(this.redact(`eBay OAuth failed (${response.status}). ${detail}`));
    }
    return parsed;
  }

  private secretValues(): Array<string | undefined> {
    return [
      this.config.clientSecret,
      this.config.refreshToken,
      this.config.mcpAuthToken,
      this.config.encryptionKey,
      this.userAccess?.token,
      this.appAccess?.token,
      this.store.cachedRefreshToken(),
    ];
  }
}

export function createOauthState(): string {
  return randomBytes(32).toString('base64url');
}
