// Connects a stdio MCP host (e.g. the Claude desktop app) to the running CareCircle server over Streamable HTTP,
// as one person in the care circle. Messages are forwarded verbatim, so MCP Apps capabilities and ui:// views
// pass straight through.
//
//   node scripts/claude-bridge.js --as priya [--url http://127.0.0.1:3000/mcp]
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const TOKENS = { margaret: 'margaret-echo-demo', priya: 'priya-echo-demo', sam: 'sam-echo-demo' };
const who = arg('as', 'priya');
const token = arg('token', TOKENS[who]);
const url = new URL(arg('url', 'http://127.0.0.1:3000/mcp'));

const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const pendingInit = new Set();

local.onmessage = async (message) => {
  if (message.method === 'initialize') pendingInit.add(message.id);
  try {
    await remote.send(message);
  } catch (err) {
    if (message.id !== undefined) {
      const hint = err.message.includes('fetch failed') ? ' Is CareCircle running? Start it with `npm start`.' : '';
      await local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `CareCircle: ${err.message}.${hint}` } });
    }
  }
};

remote.onmessage = async (message) => {
  // The HTTP transport must send MCP-Protocol-Version on every request after initialization.
  if (pendingInit.has(message.id) && message.result?.protocolVersion) {
    remote.setProtocolVersion(message.result.protocolVersion);
    pendingInit.delete(message.id);
  }
  await local.send(message);
};

remote.onerror = (err) => process.stderr.write(`[carecircle-bridge] ${err.message}\n`);
local.onclose = () => remote.close().finally(() => process.exit(0));

await remote.start();
await local.start();
process.stderr.write(`[carecircle-bridge] ${who} → ${url}\n`);
