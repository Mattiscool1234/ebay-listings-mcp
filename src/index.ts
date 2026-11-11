import { loadConfig } from './config.js';
import { createHttpServer } from './server.js';

const entry = process.argv[1] ?? '';
const isDirect = entry.endsWith('index.ts') || entry.endsWith('index.js');

export function start(): void {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid configuration');
    process.exit(1);
  }

  const server = createHttpServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`eBay seller MCP listening on http://${config.host}:${config.port}`);
    console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
    console.log(`OAuth start: http://${config.host}:${config.port}/auth/start`);
    console.log(`Environment: ${config.ebayEnv}`);
    console.log(config.mcpAuthToken ? 'MCP auth: required' : 'MCP auth: open. Set MCP_AUTH_TOKEN before exposing this port.');
    console.log(config.refreshToken ? 'Refresh token: provided via environment' : 'Refresh token: environment value not set');
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (isDirect) start();
