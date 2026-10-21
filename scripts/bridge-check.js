// Checks the Claude desktop bridge the way a stdio MCP host uses it: spawn it, initialize with the
// MCP Apps extension, list tools, call one, and read its ui:// view. Requires a running server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const as = process.argv[2] || 'priya';
const client = new Client(
  { name: 'bridge-check', version: '1.0.0' },
  { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } },
);
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['scripts/claude-bridge.js', '--as', as] }));
console.log('Server:', client.getServerVersion().name, client.getServerVersion().version);
const { tools } = await client.listTools();
console.log(`Tools as ${as} (${tools.length}):`, tools.map((t) => t.name).join(', '));
const first = as === 'margaret' ? 'get_today_schedule' : 'get_circle_status';
const result = await client.callTool({ name: first, arguments: {} });
console.log(`${first}:`, result.content[0].text.slice(0, 160) + '…');
const uri = tools.find((t) => t.name === first)._meta?.ui?.resourceUri;
const view = await client.readResource({ uri });
console.log(`View ${uri}: ${view.contents[0].mimeType}, ${view.contents[0].text.length} bytes`);
await client.close();
console.log('Bridge OK');
