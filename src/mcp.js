// The CareCircle MCP server: the tools Alexa+ (or any MCP client) uses to help an older adult
// stay on top of medications, appointments and how they're feeling — and keep family in the loop.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  todaySchedule, logDose, missedDoses, logWellbeing, addAppointment, upcomingAppointments,
  digestFacts, templateDigest, now,
} from './care.js';
import { newId } from './store.js';
import { bedrockEnabled, writeDigest } from './bedrock.js';
import { spokenTime, parseTime } from './time.js';

const SAFETY_NOTE =
  'CareCircle is a reminder and logging tool, not a medical device. Never give dosing or medical advice; ' +
  'for medical questions, suggest contacting their doctor or pharmacist.';

// Every tool returns a short sentence meant to be spoken aloud, plus JSON detail for the model.
const reply = (speech, data) => ({
  content: [
    { type: 'text', text: speech },
    ...(data === undefined ? [] : [{ type: 'text', text: JSON.stringify(data) }]),
  ],
});

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function createCareServer(store) {
  const server = new McpServer(
    { name: 'carecircle', title: 'CareCircle', version: '1.0.0' },
    {
      instructions:
        `CareCircle helps ${store.household.recipient} manage daily medications, appointments and wellbeing by voice, ` +
        'and keeps their family caregivers informed. Keep spoken replies short and kind. ' + SAFETY_NOTE,
    },
  );

  server.registerTool('get_today_schedule', {
    title: "Today's medication schedule",
    description:
      "List today's medication doses with their status (taken, skipped, due, missed, upcoming). " +
      'Use for "what pills do I take today", "what\'s next", or "did I take my morning meds".',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const t = todaySchedule(store);
    const pending = t.slots.filter((s) => s.status === 'due' || s.status === 'missed');
    const upcoming = t.slots.filter((s) => s.status === 'upcoming');
    const done = t.slots.filter((s) => s.status === 'taken').length;
    let speech = `You've taken ${done} of ${t.slots.length} doses today.`;
    if (pending.length) speech += ` Still to take: ${pending.map((s) => `${s.medication} from ${s.spokenTime}`).join(', ')}.`;
    if (upcoming.length) speech += ` Later: ${upcoming.map((s) => `${s.medication} at ${s.spokenTime}`).join(', ')}.`;
    return reply(speech, t);
  });

  server.registerTool('log_dose', {
    title: 'Log a medication dose',
    description:
      'Record that a dose was taken (or deliberately skipped). Call this when the person says things like ' +
      '"I took my Metformin" or "I\'m skipping my vitamin today". If no time is given, the closest open dose today is used. ' +
      'If the person is unsure whether they already took it, call get_today_schedule instead of logging.',
    inputSchema: {
      medication: z.string().describe('Medication name as spoken, e.g. "metformin" or "blood pressure pill"'),
      status: z.enum(['taken', 'skipped']).default('taken'),
      slot_time: z.string().optional().describe('Scheduled time of the dose, e.g. "8am" or "19:00"'),
    },
    annotations: WRITE,
  }, async ({ medication, status, slot_time }) => {
    const result = logDose(store, { medication, status, slotTime: slot_time });
    return reply(result.message, result.entry);
  });

  server.registerTool('check_missed_doses', {
    title: 'Check for missed doses',
    description:
      "Find today's doses that are overdue and not logged. Missed doses are also posted to the family caregiver feed.",
    inputSchema: {},
    annotations: WRITE,
  }, async () => {
    const { missed } = missedDoses(store);
    const speech = missed.length
      ? `You haven't logged ${missed.map((s) => `your ${s.spokenTime} ${s.medication}`).join(' or ')}. ` +
        "If you're not sure whether you took it, it's safest to check with your pharmacist before taking another."
      : "You're all caught up. No missed doses today.";
    return reply(speech, missed);
  });

  server.registerTool('list_medications', {
    title: 'List medications',
    description: 'List the active medication plan: names, doses, times and instructions.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const meds = store.medications.filter((m) => m.active);
    const speech = meds.map((m) => `${m.name} ${m.dose} at ${m.times.map(spokenTime).join(' and ')}`).join('; ') + '.';
    return reply(speech, meds);
  });

  server.registerTool('add_medication', {
    title: 'Add a medication',
    description:
      'Add a medication to the daily plan. Only do this when the person or caregiver clearly states the name, dose and times ' +
      '(as prescribed). Confirm the details back to them.',
    inputSchema: {
      name: z.string(),
      dose: z.string().describe('e.g. "10 mg" or "one tablet"'),
      times: z.array(z.string()).min(1).describe('Times of day, e.g. ["8am", "8pm"]'),
      instructions: z.string().optional(),
      with_food: z.boolean().optional(),
    },
    annotations: WRITE,
  }, async ({ name, dose, times, instructions = '', with_food = false }) => {
    const parsed = times.map(parseTime);
    if (parsed.some((t) => !t)) return reply(`I couldn't understand the times ${times.join(', ')}. Try something like "8 AM".`);
    const med = { id: newId(), name, dose, times: [...new Set(parsed)].sort(), instructions, withFood: with_food, active: true };
    store.medications.push(med);
    store.save();
    store.addAlert({ type: 'plan_change', message: `${name} ${dose} added at ${med.times.map(spokenTime).join(', ')}.` });
    return reply(`Added ${name}, ${dose}, at ${med.times.map(spokenTime).join(' and ')}. I've let the family know.`, med);
  });

  server.registerTool('stop_medication', {
    title: 'Stop a medication',
    description:
      'Remove a medication from the daily plan, only when the person says their doctor stopped it. History is kept. ' +
      'Confirm with the person before calling.',
    inputSchema: { medication: z.string() },
    annotations: { ...WRITE, destructiveHint: true },
  }, async ({ medication }) => {
    const med = store.medications.find((m) => m.active && m.name.toLowerCase().includes(medication.toLowerCase()));
    if (!med) return reply(`I couldn't find ${medication} in the current plan.`);
    med.active = false;
    store.save();
    store.addAlert({ type: 'plan_change', message: `${med.name} was removed from the plan.` });
    return reply(`Okay, ${med.name} is off the daily plan. I've let the family know.`);
  });

  server.registerTool('log_wellbeing', {
    title: 'Log how they are feeling',
    description:
      'Save a short wellbeing check-in: mood from 1 (very low) to 5 (great), any symptoms, and a note in their own words. ' +
      'Use whenever the person describes how they feel. Serious symptoms (falls, chest pain, trouble breathing, confusion) ' +
      'are flagged and the family is alerted immediately.',
    inputSchema: {
      mood: z.number().int().min(1).max(5).optional(),
      symptoms: z.array(z.string()).optional().describe('e.g. ["dizziness", "knee pain"]'),
      note: z.string().optional().describe('Their words, briefly'),
    },
    annotations: WRITE,
  }, async ({ mood, symptoms = [], note = '' }) => {
    const { entry, urgent } = logWellbeing(store, { mood, symptoms, note });
    if (urgent) {
      const names = store.caregivers.filter((c) => c.notify === 'urgent').map((c) => c.name).join(' and ');
      return reply(
        `That sounds serious. I've alerted ${names || 'your family'} right now. ` +
        'If you are in danger, feel chest pain, or have trouble breathing, please call emergency services immediately.',
        entry,
      );
    }
    return reply(mood && mood <= 2
      ? "Thank you for telling me. I've noted it. Would you like me to let your family know you're having a rough day?"
      : "Thanks, I've added that to your journal.", entry);
  });

  server.registerTool('notify_caregiver', {
    title: 'Message the family',
    description:
      'Send a message to the family caregiver feed, e.g. "tell Priya I need more Metformin" or "let my daughter know I\'m okay".',
    inputSchema: {
      message: z.string(),
      urgency: z.enum(['info', 'urgent']).default('info'),
    },
    annotations: { ...WRITE, openWorldHint: true },
  }, async ({ message, urgency }) => {
    const alert = store.addAlert({ type: 'message', urgency, message: `${store.household.recipient}: ${message}` });
    const who = store.caregivers.map((c) => c.name).join(' and ');
    return reply(`Done. I've sent that to ${who}.`, alert);
  });

  server.registerTool('add_appointment', {
    title: 'Add an appointment',
    description: 'Save a medical appointment. Resolve relative dates ("next Tuesday") to YYYY-MM-DD using get_today_schedule\'s date if needed.',
    inputSchema: {
      title: z.string().describe('e.g. "Dentist with Dr. Kim"'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
      time: z.string().optional().describe('e.g. "2:30 pm"'),
      location: z.string().optional(),
      notes: z.string().optional(),
    },
    annotations: WRITE,
  }, async (args) => {
    const appt = addAppointment(store, args);
    return reply(`Saved: ${appt.title} on ${appt.date}${appt.time ? ` at ${spokenTime(appt.time)}` : ''}.`, appt);
  });

  server.registerTool('list_upcoming_appointments', {
    title: 'Upcoming appointments',
    description: 'List appointments in the next N days (default 14).',
    inputSchema: { days: z.number().int().min(1).max(90).default(14) },
    annotations: READ,
  }, async ({ days }) => {
    const appts = upcomingAppointments(store, days);
    const when = (a) => (a.inDays === 0 ? 'today' : a.inDays === 1 ? 'tomorrow' : `in ${a.inDays} days`);
    const speech = appts.length
      ? appts.map((a) => `${a.title} ${when(a)}${a.spokenTime ? ` at ${a.spokenTime}` : ''}${a.location ? `, at ${a.location}` : ''}`).join('. ') + '.'
      : `No appointments in the next ${days} days.`;
    return reply(speech, appts);
  });

  server.registerTool('get_care_digest', {
    title: 'Weekly care digest',
    description:
      'Summarise the last week for a family caregiver: medication adherence, missed-dose patterns, mood, symptoms and ' +
      'upcoming appointments. Use for "how has Mum been doing this week?".',
    inputSchema: { days: z.number().int().min(1).max(30).default(7) },
    annotations: READ,
  }, async ({ days }) => {
    const facts = digestFacts(store, days);
    let summary = templateDigest(facts);
    if (bedrockEnabled()) {
      try { summary = await writeDigest(facts); } catch (err) { console.warn('Bedrock digest failed:', err.message); }
    }
    return reply(summary, facts);
  });

  server.registerResource('care-plan', 'carecircle://care-plan', {
    title: 'Care plan',
    description: 'The current medication plan, caregivers and household settings as Markdown.',
    mimeType: 'text/markdown',
  }, async (uri) => {
    const h = store.household;
    const md = [
      `# Care plan for ${h.recipient}`,
      `Timezone: ${h.timezone} · Local time now: ${now(store).time}`,
      '## Medications',
      ...store.medications.filter((m) => m.active).map((m) =>
        `- **${m.name}** ${m.dose} at ${m.times.map(spokenTime).join(', ')}${m.withFood ? ' (with food)' : ''}${m.instructions ? ` — ${m.instructions}` : ''}`),
      '## Caregivers',
      ...store.caregivers.map((c) => `- ${c.name} (${c.relation}), notified for: ${c.notify}`),
    ].join('\n');
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] };
  });

  server.registerPrompt('daily_check_in', {
    title: 'Daily check-in',
    description: 'A gentle morning or evening check-in routine.',
    argsSchema: { part_of_day: z.enum(['morning', 'evening']).optional() },
  }, ({ part_of_day = 'morning' }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Run a short ${part_of_day} check-in with ${store.household.recipient}: greet them, ask how they're feeling ` +
          '(log it with log_wellbeing), go over the doses that are due using get_today_schedule, and mention any ' +
          'appointment in the next two days. Keep each turn to one or two sentences.',
      },
    }],
  }));

  return server;
}
