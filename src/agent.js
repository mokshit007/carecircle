// A stand-in for Alexa+ in the demo: an agent loop on Claude (Amazon Bedrock) that connects to the
// CareCircle MCP server over Streamable HTTP *as a specific person*, discovers that person's tools,
// follows the CareCircle Agent Skill, and returns any MCP Apps view a tool asked to show.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bedrock, bedrockEnabled, BEDROCK_MODEL, textOf } from './bedrock.js';
import { UI_MIME } from './views.js';

const MAX_TURNS = 8;
const conversations = new Map(); // `${personId}:${conversationId}` -> MessageParam[]
const SKILL_FILE = path.resolve('skills', 'carecircle-care-companion', 'SKILL.md');

// The Agent Skill is the single source of truth for how an assistant should run CareCircle.
const skillText = () => fs.readFileSync(SKILL_FILE, 'utf8').replace(/^---[\s\S]*?---\s*/, '');

export async function connectAs(mcpUrl, token) {
  const client = new Client(
    { name: 'carecircle-echo-simulator', version: '2.0.0' },
    { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [UI_MIME] } } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const visibility = (tool) => tool._meta?.ui?.visibility ?? ['model', 'app'];
const textContent = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

export async function converse({ mcpUrl, person, token, conversationId, utterance, recipientName }) {
  const client = await connectAs(mcpUrl, token);
  const trace = [];
  let view = null; // last tool result that asked for a UI

  const callTool = async (tool, args) => {
    const result = await client.callTool({ name: tool.name, arguments: args });
    trace.push({ tool: tool.name, input: args, output: textContent(result), ui: tool._meta?.ui?.resourceUri ?? null });
    if (tool._meta?.ui?.resourceUri && !result.isError) view = { tool, args, result };
    return result;
  };

  try {
    const { tools } = await client.listTools();
    const modelTools = tools.filter((t) => visibility(t).includes('model'));
    const reply = bedrockEnabled()
      ? await bedrockLoop({ client, person, conversationId, utterance, modelTools, callTool })
      : await offlineRouter({ person, utterance, tools: modelTools, callTool, recipientName });

    let ui = null;
    if (view) {
      const uri = view.tool._meta.ui.resourceUri;
      const resource = await client.readResource({ uri });
      ui = { uri, html: resource.contents[0].text, toolName: view.tool.name, toolInput: view.args, toolResult: view.result, tool: view.tool };
    }
    return { reply, trace, ui, mode: bedrockEnabled() ? 'bedrock' : 'offline' };
  } finally {
    await client.close();
  }
}

// Calls made by an MCP Apps view (e.g. tapping "I took it"); only tools visible to apps are allowed.
export async function appToolCall({ mcpUrl, token, name, args }) {
  const client = await connectAs(mcpUrl, token);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool || !visibility(tool).includes('app')) {
      return { content: [{ type: 'text', text: `Tool ${name} is not available to apps.` }], isError: true };
    }
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

export function resetConversations() {
  conversations.clear();
}

function systemPrompt(person) {
  return [
    `You are Alexa on ${person.name}'s ${person.device}, using the CareCircle skill.`,
    person.role === 'recipient'
      ? `${person.name} is the older adult being cared for.`
      : `${person.name} is a family caregiver (${person.relation}).`,
    'Your reply is spoken aloud: one to three short, warm sentences, no lists, no markdown, no emoji.',
    'If a screen view is shown by a tool, you can refer to it briefly ("it\'s on your screen").',
    '',
    skillText(),
  ].join('\n');
}

async function bedrockLoop({ person, conversationId, utterance, modelTools, callTool }) {
  const key = `${person.id}:${conversationId}`;
  const messages = conversations.get(key) ?? [];
  messages.push({ role: 'user', content: utterance });
  const claudeTools = modelTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await (await bedrock()).messages.create({
      model: BEDROCK_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: systemPrompt(person),
      tools: claudeTools,
      messages,
    });
    // Append the full content (thinking blocks included) so the history stays append-only.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return "Sorry, I can't help with that one. You might ask the doctor or pharmacist.";
    }
    if (response.stop_reason !== 'tool_use') {
      conversations.set(key, messages.slice(-40));
      return textOf(response);
    }

    const results = [];
    for (const block of response.content.filter((b) => b.type === 'tool_use')) {
      const tool = modelTools.find((t) => t.name === block.name);
      const result = tool
        ? await callTool(tool, block.input)
        : { content: [{ type: 'text', text: `Unknown tool ${block.name}` }], isError: true };
      results.push({ type: 'tool_result', tool_use_id: block.id, is_error: Boolean(result.isError), content: textContent(result) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Sorry, that took me too long. Could you say it another way?';
}

// Keyword routing so the simulator still exercises the real MCP tools without AWS credentials.
async function offlineRouter({ person, utterance, tools, callTool, recipientName = '' }) {
  const u = utterance.toLowerCase();
  const has = (name) => tools.find((t) => t.name === name);
  const call = async (name, args = {}) => {
    const tool = has(name);
    if (!tool) return null;
    return textContent(await callTool(tool, args));
  };

  if (person.role === 'recipient') {
    if (/\b(took|taken|had)\b/.test(u) && !/\b(did i|have i|what|which)\b/.test(u)) {
      return call('log_dose', { medication: u.replace(/.*\b(took|taken|had)\b\s*(my|the)?\s*/, '').replace(/[.!?]$/, ''), status: 'taken' });
    }
    if (/skip/.test(u)) return call('log_dose', { medication: u.replace(/.*skip(ping)?\s*(my|the)?\s*/, ''), status: 'skipped' });
    if (/message|news/.test(u) && /for me|any|new/.test(u)) return call('get_my_messages');
    if (/miss|forgot|forget/.test(u)) return call('check_missed_doses');
    if (/appointment|doctor|visit/.test(u)) return call('list_upcoming_appointments', { days: 14 });
    const tell = u.match(/^(?:please\s+)?(?:tell|let|message|ask)\s+(\w+)\s+(?:know\s+)?(?:that\s+)?(.*)$/);
    if (tell) {
      const to = tell[1] === 'everyone' || tell[1] === 'the' ? undefined : tell[1];
      return call('message_family', { message: utterance.replace(/^.*?(?:tell|let|message|ask)\s+\w+\s+(?:know\s+)?(?:that\s+)?/i, ''), to, urgency: 'info' });
    }
    if (/feel|pain|hurt|tired|dizzy|fell|sad|slept|sleep|breath|muddled|confus/.test(u)) {
      const mood = /great|good|wonderful|fine/.test(u) ? 4 : /sad|tired|bad|rough|low|muddled|dizzy/.test(u) ? 2 : undefined;
      return call('log_wellbeing', { mood, note: utterance });
    }
    if (/pill|med|schedule|today|next|dose|take/.test(u)) return call('get_today_schedule');
  } else {
    if (/^(i'?ll|i will|i can|i'm going to)\b/.test(u)) return call('claim_task', { task: u });
    if (/picked up|done with|finished|i got the|collected/.test(u)) return call('complete_task', { task: u });
    const recipientWords = ['mum', 'mom', 'mother', 'her', 'grandma', 'gran', 'nan', 'dad', 'father', 'him', 'grandpa', recipientName.toLowerCase()].filter(Boolean);
    if (new RegExp(`^(tell|let|message)\\s+(${recipientWords.join('|')})\\b`).test(u)) {
      return call('message_recipient', { message: utterance.replace(/^(tell|let|message)\s+\w+\s+(know\s+)?(that\s+)?/i, '') });
    }
    if (/brief|prepare|doctor visit/.test(u)) return call('prepare_visit_brief', {});
    if (/chang|worr|routine|insight|different|unusual/.test(u)) return call('get_routine_insights');
    if (/week|digest|summary/.test(u)) return call('get_care_digest', { days: 7 });
    if (/task|to do|todo|who'?s/.test(u)) return call('list_family_tasks');
    if (/seen|called her|acknowledg/.test(u)) return call('acknowledge_alerts');
    if (/pill|med|schedule|dose/.test(u)) return call('get_today_schedule');
    if (/appointment/.test(u)) return call('list_upcoming_appointments', { days: 14 });
    return call('get_circle_status');
  }
  return "I can help with medicines, appointments, how you're feeling, or messages for the family. (Offline demo mode: set BEDROCK_ENABLED=true for full conversation.)";
}
