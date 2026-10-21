// Simulated Alexa+ for the demo console: an agent loop on Claude (Amazon Bedrock) that discovers and
// calls tools through the CareCircle MCP server over Streamable HTTP — the same path Alexa+ uses.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bedrock, bedrockEnabled, BEDROCK_MODEL, textOf } from './bedrock.js';

const MAX_TURNS = 8;
const conversations = new Map(); // conversationId -> MessageParam[]

async function connect(mcpUrl) {
  const headers = process.env.MCP_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {};
  const client = new Client({ name: 'carecircle-voice-console', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));
  return client;
}

const toolText = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text);

function systemPrompt(recipient) {
  return [
    `You are Alexa, helping ${recipient}, an older adult, through the CareCircle skill.`,
    'Your reply is spoken aloud by a smart speaker: one to three short, warm sentences, no lists, no markdown, no emoji.',
    'Use the CareCircle tools for anything about medications, doses, appointments, feelings or messaging family; ',
    'never guess what the schedule says. When a tool returns a spoken sentence, you may reuse it.',
    'You are not a doctor: never advise on doses, interactions or changing medication. Suggest their doctor or pharmacist.',
    'If they describe an emergency, log it with log_wellbeing and tell them to call emergency services.',
  ].join(' ');
}

export async function converse({ mcpUrl, recipient, conversationId, utterance }) {
  const client = await connect(mcpUrl);
  const trace = [];
  try {
    if (!bedrockEnabled()) return { reply: await offlineRouter(client, utterance, trace), trace, mode: 'offline' };

    const { tools } = await client.listTools();
    const claudeTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    const messages = conversations.get(conversationId) ?? [];
    messages.push({ role: 'user', content: utterance });

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await bedrock().messages.create({
        model: BEDROCK_MODEL,
        max_tokens: 4000,
        output_config: { effort: 'low' },
        system: systemPrompt(recipient),
        tools: claudeTools,
        messages,
      });
      // Append the full content (including thinking blocks) so the history stays append-only.
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') {
        return { reply: "Sorry, I can't help with that one. You might ask your doctor or pharmacist.", trace, mode: 'bedrock' };
      }
      if (response.stop_reason !== 'tool_use') {
        conversations.set(conversationId, messages.slice(-40));
        return { reply: textOf(response), trace, mode: 'bedrock' };
      }

      const results = [];
      for (const block of response.content.filter((b) => b.type === 'tool_use')) {
        const result = await client.callTool({ name: block.name, arguments: block.input });
        trace.push({ tool: block.name, input: block.input, output: toolText(result)[0] });
        results.push({
          type: 'tool_result', tool_use_id: block.id, is_error: Boolean(result.isError),
          content: toolText(result).join('\n'),
        });
      }
      messages.push({ role: 'user', content: results });
    }
    return { reply: 'Sorry, that took me too long. Could you say it another way?', trace, mode: 'bedrock' };
  } finally {
    await client.close();
  }
}

export function resetConversation(conversationId) {
  conversations.delete(conversationId);
}

// Keyword fallback so the console still demos the MCP tools without AWS credentials.
async function offlineRouter(client, utterance, trace) {
  const u = utterance.toLowerCase();
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const speech = toolText(result)[0];
    trace.push({ tool: name, input: args, output: speech });
    return speech;
  };
  const { tools } = await client.listTools();
  if (/\b(took|taken|had|take[ns]?)\b/.test(u) && !/\b(what|which|when|do i|should)\b/.test(u)) {
    const plan = JSON.parse(toolText(await client.callTool({ name: 'list_medications', arguments: {} }))[1]);
    const med = plan.find((m) => u.includes(m.name.toLowerCase()));
    if (med) return call('log_dose', { medication: med.name, status: /skip/.test(u) ? 'skipped' : 'taken' });
  }
  if (/miss|forgot|forget/.test(u)) return call('check_missed_doses');
  if (/appointment|doctor|visit/.test(u)) return call('list_upcoming_appointments', { days: 14 });
  if (/week|digest|summary|how (has|is) .* doing/.test(u)) return call('get_care_digest', { days: 7 });
  if (/tell|let .* know|message/.test(u)) {
    return call('notify_caregiver', { message: utterance.replace(/^.*?(tell|let)\s+\w+\s+(know\s+)?(that\s+)?/i, ''), urgency: 'info' });
  }
  if (/feel|pain|hurt|tired|dizzy|fell|sad|good|great|breath/.test(u)) {
    const mood = /great|good|wonderful/.test(u) ? 4 : /sad|tired|bad|rough|low/.test(u) ? 2 : undefined;
    return call('log_wellbeing', { mood, note: utterance });
  }
  if (/pill|med|schedule|today|next|dose/.test(u)) return call('get_today_schedule');
  return `I can help with your medications, appointments, or how you're feeling. (Offline demo mode: ${tools.length} CareCircle tools available. Set BEDROCK_ENABLED=true for full conversation.)`;
}
