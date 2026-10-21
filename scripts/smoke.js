// End-to-end check against a running server: node scripts/smoke.js [http://127.0.0.1:3000/mcp]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.argv[2] || 'http://127.0.0.1:3000/mcp');
const headers = process.env.MCP_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {};
const client = new Client({ name: 'carecircle-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
await client.connect(transport);

console.log('Protocol version:', transport.protocolVersion);
console.log('Server:', client.getServerVersion());
const { tools } = await client.listTools();
console.log(`Tools (${tools.length}):`, tools.map((t) => t.name).join(', '));

const say = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  console.log(`\n> ${name} ${JSON.stringify(args)}\n  ${result.content[0].text}`);
  return result;
};

await say('get_today_schedule');
await say('log_dose', { medication: 'metformin' });
await say('log_dose', { medication: 'lisinoprill' });
await say('check_missed_doses');
await say('log_wellbeing', { mood: 4, note: 'Feeling good, went for a walk' });
await say('list_upcoming_appointments', { days: 14 });
await say('get_care_digest', { days: 7 });

const resource = await client.readResource({ uri: 'carecircle://care-plan' });
console.log('\nResource carecircle://care-plan:\n' + resource.contents[0].text);
const prompt = await client.getPrompt({ name: 'daily_check_in', arguments: { part_of_day: 'evening' } });
console.log('\nPrompt daily_check_in:', prompt.messages[0].content.text.slice(0, 80) + '…');

await client.close();
console.log('\nSmoke test passed.');
