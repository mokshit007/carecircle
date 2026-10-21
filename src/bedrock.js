// Claude on Amazon Bedrock (Mantle / Messages API). Used for the caregiver digest and the
// simulated Alexa+ voice console. Everything degrades gracefully when Bedrock isn't configured.
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';

export const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-opus-5-5';
export const bedrockEnabled = () => process.env.BEDROCK_ENABLED === 'true';

let client;
export function bedrock() {
  client ??= new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION || 'us-east-1' });
  return client;
}

const textOf = (message) =>
  message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();

export async function writeDigest(facts) {
  const response = await bedrock().messages.create({
    model: BEDROCK_MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system:
      'You write short weekly care updates for family caregivers of an older adult. ' +
      'Write 3-5 warm, plain sentences that a busy family member can read in 20 seconds. ' +
      'Lead with what needs attention, mention patterns (for example a dose that is repeatedly missed at the same time), ' +
      'and end with one practical suggestion. Only state facts present in the data. ' +
      'Never give medical advice or suggest changing medication; for clinical questions suggest asking their doctor.',
    messages: [{ role: 'user', content: `Care data for the past week (JSON):\n${JSON.stringify(facts)}` }],
  });
  if (response.stop_reason === 'refusal') throw new Error('digest declined');
  return textOf(response);
}

export { textOf };
