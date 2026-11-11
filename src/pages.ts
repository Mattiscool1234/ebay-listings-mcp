import type { TokenStoreStatus } from './tokenStore.js';
import { escapeHtml } from './security.js';

export function homePage(status: {
  ebayEnv: string;
  clientConfigured: boolean;
  ruNameConfigured: boolean;
  mcpAuthRequired: boolean;
  tokens: TokenStoreStatus;
}): string {
  return layout(
    'eBay seller MCP',
    `
      <p>This server lets your AI assistant manage listings on the connected eBay seller account.</p>
      <ul>
        <li>Environment: <strong>${escapeHtml(status.ebayEnv)}</strong></li>
        <li>Client credentials: <strong>${yesNo(status.clientConfigured)}</strong></li>
        <li>RuName: <strong>${yesNo(status.ruNameConfigured)}</strong></li>
        <li>Refresh token: <strong>${tokenLabel(status.tokens)}</strong></li>
        <li>MCP endpoint protection: <strong>${status.mcpAuthRequired ? 'bearer token required' : 'open'}</strong></li>
      </ul>
      <p>The MCP endpoint is <code>/mcp</code>. Connect the seller account at <a href="/auth/start">/auth/start</a>.</p>
      <p>Secrets and tokens are never shown on this page.</p>
    `,
  );
}

export function authFormPage(): string {
  return layout(
    'Connect eBay',
    `
      <p>Enter the MCP auth token to start the eBay consent flow. The token is sent with this form and is not put in the browser address bar.</p>
      <form method="post" action="/auth/start">
        <label for="token">MCP auth token</label>
        <input id="token" name="token" type="password" required autocomplete="off" />
        <button type="submit">Continue to eBay</button>
      </form>
    `,
  );
}

export function messagePage(title: string, body: string): string {
  return layout(title, `<p>${escapeHtml(body)}</p>`);
}

export function connectedPage(canReveal: boolean): string {
  const reveal = canReveal
    ? `
      <p>Enter the MCP auth token to show the new refresh token once. Copy it into <code>EBAY_REFRESH_TOKEN</code> and redeploy. Render's free plan drops the process disk when the service sleeps, so the environment variable is what survives.</p>
      <form method="post" action="/auth/refresh-token">
        <label for="token">MCP auth token</label>
        <input id="token" name="token" type="password" required autocomplete="off" />
        <button type="submit">Show the refresh token once</button>
      </form>
    `
    : `<p>Set <code>MCP_AUTH_TOKEN</code> and sign in again before the refresh token can be shown. It is not on this page.</p>`;
  return layout(
    'eBay account connected',
    `
      <p>The refresh token is held for this running process and is not shown on this page.</p>
      ${reveal}
    `,
  );
}

export function revealFormPage(): string {
  return layout(
    'Show the refresh token',
    `
      <p>Enter the MCP auth token. The refresh token is shown once and is not written to the server log.</p>
      <form method="post" action="/auth/refresh-token">
        <label for="token">MCP auth token</label>
        <input id="token" name="token" type="password" required autocomplete="off" />
        <button type="submit">Show the refresh token once</button>
      </form>
    `,
  );
}

export function revealedTokenPage(refreshToken: string): string {
  return layout(
    'Copy the refresh token',
    `
      <p>This is the only time this token is shown. Paste it into Render as <code>EBAY_REFRESH_TOKEN</code>, save, and redeploy. Then close this tab.</p>
      <textarea readonly autofocus>${escapeHtml(refreshToken)}</textarea>
    `,
  );
}

function tokenLabel(tokens: TokenStoreStatus): string {
  if (tokens.source === 'none') return 'not configured';
  if (!tokens.readable) return 'stored, but the encryption key could not read it';
  if (tokens.source === 'file') return 'stored in the encrypted file';
  if (tokens.source === 'memory') return 'held in this process until restart';
  return 'set from the environment';
}

function yesNo(value: boolean): string {
  return value ? 'configured' : 'missing';
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: Georgia, "Iowan Old Style", serif; margin: 0; background: #f4f1ea; color: #1c1915; }
    main { max-width: 38rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
    h1 { font-size: 1.8rem; line-height: 1.2; margin-bottom: 0.75rem; }
    p, li { font-size: 1.05rem; line-height: 1.5; }
    code, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.95rem; }
    textarea { width: 100%; min-height: 7rem; padding: 0.7rem 0.8rem; border: 1px solid #1c1915; background: #fff; color: inherit; }
    a { color: #0b4f6c; }
    form { display: grid; gap: 0.75rem; margin-top: 1.5rem; }
    label { font-size: 0.95rem; }
    input { font: inherit; padding: 0.7rem 0.8rem; border: 1px solid #1c1915; background: #fff; }
    button { font: inherit; padding: 0.7rem 0.9rem; background: #1c1915; color: #f4f1ea; border: 0; cursor: pointer; }
    @media (prefers-color-scheme: dark) {
      body { background: #161410; color: #f4f1ea; }
      a { color: #9fd3e6; }
      input, textarea { background: #221f1a; color: #f4f1ea; border-color: #f4f1ea; }
      button { background: #f4f1ea; color: #161410; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
}
