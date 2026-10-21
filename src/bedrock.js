// Claude on Amazon Bedrock (Mantle / Messages API). Powers the simulated Alexa+ agent, the family
// digest, routine-drift explanations, doctor-visit briefs and pill-bottle label reading.
// Every caller has a deterministic fallback, so the product still works with Bedrock switched off.
export const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-opus-5-5';
export const bedrockEnabled = () => process.env.BEDROCK_ENABLED === 'true';

// Loaded on first use, so the server starts fast and doesn't pull in AWS code when Bedrock is off.
let client;
export async function bedrock() {
  if (!client) {
    const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
    client = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION || 'us-east-1' });
  }
  return client;
}

export const textOf = (message) =>
  message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();

const CARE_VOICE =
  'You write for family caregivers of an older adult. Be warm, plain and brief. Only state facts present in the data. ' +
  'Never give medical advice, diagnose, or suggest changing medication; when something may need clinical attention, ' +
  'suggest talking to their doctor or pharmacist.';

async function complete(system, content, maxTokens = 2000) {
  const response = await (await bedrock()).messages.create({
    model: BEDROCK_MODEL,
    max_tokens: maxTokens,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this request');
  return textOf(response);
}

export function writeDigest(facts) {
  return complete(
    `${CARE_VOICE} Write a weekly update of 3-5 sentences a busy family member can read in 20 seconds. ` +
      'Lead with what needs attention, point out patterns, and end with one practical suggestion.',
    `Care data (JSON):\n${JSON.stringify(facts)}`,
  );
}

export function explainDrift(drift, context) {
  return complete(
    `${CARE_VOICE} You are explaining a change in an older adult's daily routine, detected from smart-home and voice ` +
      'signals compared with their own two-week baseline. In 3-4 sentences: say what changed and how the signals relate ' +
      '(without overclaiming a cause), how confident to be, and one or two concrete next steps for the family, such as a ' +
      'check-in call or mentioning it at an upcoming appointment. Do not use alarming language.',
    `Drift analysis (JSON):\n${JSON.stringify(drift)}\n\nContext (JSON):\n${JSON.stringify(context)}`,
  );
}

export function writeVisitBrief(facts) {
  return complete(
    `${CARE_VOICE} Prepare a one-page brief a family member can hand to the doctor at an appointment. Use short Markdown ` +
      'sections: "Since the last visit" (adherence, missed-dose patterns), "Day-to-day" (mood, sleep, symptoms, routine ' +
      'changes), "Current medications" (as listed, no changes), and "Questions to ask" (3-5 neutral questions the family ' +
      'might raise). Facts only, no interpretation of what is medically wrong.',
    `Data (JSON):\n${JSON.stringify(facts)}`,
    3000,
  );
}

const LABEL_FIELDS = '{"name": string, "strength": string, "form": string, "directions": string, "timesPerDay": number, ' +
  '"suggestedTimes": string[] (24h "HH:MM", spread over waking hours), "withFood": boolean, "prescriber": string, ' +
  '"pharmacy": string, "refillsRemaining": number | null, "quantity": number | null, "warnings": string[], "confidence": "high" | "medium" | "low"}';

export async function readPillLabel(base64, mediaType) {
  const text = await complete(
    'You read prescription and supplement labels from photos for a family caregiving app. Extract exactly what is printed. ' +
      'If a field is not visible, use an empty string, null or an empty list. Never invent a dose. ' +
      `Reply with only a JSON object of this shape: ${LABEL_FIELDS}`,
    [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: 'Read this medication label.' },
    ],
  );
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('Could not read the label');
  return JSON.parse(json[0]);
}
