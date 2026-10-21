// The CareCircle MCP server. One server, one care circle, many Alexas: every connection is bound to a
// person (via their bearer token), and the tool list is shaped by that person's role.
//   - The care recipient's Echo gets a gentle, voice-first toolset (log a dose, how am I doing, message family).
//   - Each caregiver's Echo gets the family toolset (how's Mum, routine insights, claim tasks, message Mum).
// Tools that benefit from a screen declare an MCP Apps view (ui://) for Echo Show and other UI-capable hosts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  todaySchedule, logDose, missedDoses, logWellbeing, addAppointment, upcomingAppointments, digestFacts,
  templateDigest, claimTask, completeTask, openTasks, supplyStatus, findMedication, recordInteraction, now,
} from './care.js';
import { newId } from './store.js';
import { bedrockEnabled, writeDigest, writeVisitBrief } from './bedrock.js';
import { circleStatus, spokenCircleSummary, driftWithNarrative } from './status.js';
import { spokenTime, parseTime } from './time.js';
import { VIEWS, UI_MIME, viewHtml } from './views.js';

const SAFETY =
  'CareCircle is a reminder, logging and family-coordination tool, not a medical device. Never give dosing or medical ' +
  'advice; for medical questions suggest their doctor or pharmacist. For emergencies, tell them to call emergency services.';

// Every tool returns a short sentence meant to be spoken aloud, plus structured data for screens and models.
const reply = (speech, structured) => ({
  content: [{ type: 'text', text: speech }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
});

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const ui = (view, visibility) => ({ ui: { resourceUri: VIEWS[view].uri, ...(visibility ? { visibility } : {}) } });
const APP_ONLY = { ui: { visibility: ['app'] } };

const ICON = {
  src: 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0b7a75"/>' +
    '<path d="M32 46s-14-8.5-14-18a8 8 0 0 1 14-5.3A8 8 0 0 1 46 28c0 9.5-14 18-14 18z" fill="#fff"/></svg>').toString('base64'),
  mimeType: 'image/svg+xml',
};

export function createCareServer(store, person) {
  const recipient = store.recipient;
  const isRecipient = person.role === 'recipient';
  const server = new McpServer(
    { name: 'carecircle', title: 'CareCircle', version: '2.0.0', icons: [ICON], websiteUrl: 'https://github.com/mokshit007/carecircle' },
    {
      instructions: isRecipient
        ? `You are talking with ${recipient.name}, an older adult, through their Echo. Help them with medicines, ` +
          `appointments and how they feel, and pass messages to their family. Short, warm, spoken sentences. ${SAFETY}`
        : `You are talking with ${person.name}, ${recipient.name}'s ${person.relation}, a family caregiver. Help them see how ` +
          `${recipient.name} is doing, coordinate family tasks, and keep in touch. ${SAFETY}`,
    },
  );

  // Every call counts as "activity" for the recipient's routine signals.
  const tool = (name, config, handler) => server.registerTool(name, config, async (args, extra) => {
    if (isRecipient) recordInteraction(store, person.id);
    return handler(args ?? {}, extra);
  });

  // ---------- Shared ----------

  tool('get_today_schedule', {
    title: "Today's medicines",
    description: isRecipient
      ? "Show today's medicines and which are done, due, overdue or coming up. Use for \"what do I take today\", \"what's next\" or \"did I take my morning pills\"."
      : `Show ${recipient.name}'s medication schedule for today with what's been taken.`,
    inputSchema: {},
    annotations: READ,
    _meta: ui('today'),
  }, async () => {
    const t = todaySchedule(store);
    const pending = t.slots.filter((s) => s.status === 'due' || s.status === 'missed');
    const later = t.slots.filter((s) => s.status === 'upcoming');
    const who = isRecipient ? "You've" : `${recipient.name} has`;
    let speech = `${who} taken ${t.taken} of ${t.total} doses today.`;
    if (pending.length) speech += ` Still to take: ${pending.map((s) => `${s.medication} from ${s.spokenTime}`).join(', ')}.`;
    if (later.length) speech += ` Later: ${later.map((s) => `${s.medication} at ${s.spokenTime}`).join(', ')}.`;
    return reply(speech, t);
  });

  tool('list_upcoming_appointments', {
    title: 'Upcoming appointments',
    description: 'List appointments in the next N days (default 14), with who is driving if a ride is needed.',
    inputSchema: { days: z.number().int().min(1).max(90).default(14) },
    annotations: READ,
  }, async ({ days = 14 }) => {
    const appts = upcomingAppointments(store, days);
    const when = (a) => (a.inDays === 0 ? 'today' : a.inDays === 1 ? 'tomorrow' : `in ${a.inDays} days`);
    const speech = appts.length
      ? appts.map((a) => `${a.title} ${when(a)}${a.spokenTime ? ` at ${a.spokenTime}` : ''}` +
          (a.needsRide ? (a.driver ? `, ${a.driver} is driving` : ', nobody is driving yet') : '')).join('. ') + '.'
      : `No appointments in the next ${days} days.`;
    return reply(speech, { appointments: appts });
  });

  tool('list_medications', {
    title: 'Medication plan',
    description: 'List the active medication plan: names, doses, times, what each is for, and how many days of supply are left.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const meds = store.medications.filter((m) => m.active);
    const supply = supplyStatus(store);
    const speech = meds.map((m) => `${m.name} ${m.dose}${m.purpose ? ` for ${m.purpose}` : ''} at ${m.times.map(spokenTime).join(' and ')}`).join('; ') + '.';
    return reply(speech, { medications: meds, supply });
  });

  if (isRecipient) registerRecipientTools(); else registerCaregiverTools();

  // ---------- Care recipient ----------

  function registerRecipientTools() {
    tool('log_dose', {
      title: 'Log a dose',
      description:
        'Record that a dose was taken (or deliberately skipped). Use when they say "I took my Metformin" or "I took my blood pressure pill". ' +
        'If no time is given the closest open dose today is used. If they are unsure whether they already took it, call ' +
        'get_today_schedule instead of logging, and never encourage a second dose.',
      inputSchema: {
        medication: z.string().describe('Medication name or what it is for, as spoken, e.g. "metformin" or "blood pressure pill"'),
        status: z.enum(['taken', 'skipped']).default('taken'),
        slot_time: z.string().optional().describe('Scheduled time of the dose, e.g. "8am" or "19:00"'),
      },
      annotations: WRITE,
    }, async ({ medication, status = 'taken', slot_time }) => {
      const result = logDose(store, { medication, status, slotTime: slot_time, by: person.id });
      return reply(result.message, { ok: result.ok, entry: result.entry ?? null, today: todaySchedule(store) });
    });

    tool('confirm_dose_from_screen', {
      title: 'Confirm a dose from the screen',
      description: 'Used by the Today view when the person taps "I took it".',
      inputSchema: { slot_key: z.string().describe('date:medId:HH:MM') },
      annotations: WRITE,
      _meta: APP_ONLY,
    }, async ({ slot_key }) => {
      const [, medId, ...time] = slot_key.split(':');
      const med = store.medications.find((m) => m.id === medId);
      if (!med) return { ...reply('That medicine is no longer on the plan.'), isError: true };
      const result = logDose(store, { medication: med, slotTime: time.join(':'), by: person.id });
      return reply(result.message, { ok: result.ok, today: todaySchedule(store) });
    });

    tool('check_missed_doses', {
      title: 'Anything missed?',
      description: "Check today's doses that are overdue and not logged. Never suggests taking a double dose.",
      inputSchema: {},
      annotations: READ,
    }, async () => {
      const { missed } = missedDoses(store);
      const speech = missed.length
        ? `You haven't logged ${missed.map((s) => `your ${s.spokenTime} ${s.medication}`).join(' or ')}. ` +
          "If you did take it and just forgot to tell me, say so and I'll log it. If you're not sure, it's safest to ask your pharmacist before taking another."
        : "You're all caught up. Nothing missed today.";
      return reply(speech, { missed });
    });

    tool('log_wellbeing', {
      title: 'How I feel',
      description:
        'Save a short check-in: mood from 1 (very low) to 5 (great), any symptoms, and a note in their own words. Use whenever ' +
        'they describe how they feel or slept. Serious symptoms (falls, chest pain, trouble breathing) alert the family immediately.',
      inputSchema: {
        mood: z.number().int().min(1).max(5).optional(),
        symptoms: z.array(z.string()).optional().describe('e.g. ["dizziness", "trouble sleeping"]'),
        note: z.string().optional().describe('Their words, briefly'),
      },
      annotations: WRITE,
    }, async ({ mood, symptoms = [], note = '' }) => {
      const { entry, urgent } = logWellbeing(store, { mood, symptoms, note, by: person.id });
      if (urgent) {
        const names = store.caregivers.filter((c) => c.notify?.includes('urgent')).map((c) => c.name).join(' and ');
        return reply(
          `That sounds serious. I've alerted ${names || 'your family'} right now. ` +
          'If you are hurt, have chest pain, or have trouble breathing, please call emergency services straight away.',
          { entry, urgent },
        );
      }
      return reply(mood && mood <= 2
        ? "Thank you for telling me. I've noted it. Would you like me to let your family know you're having a rough day?"
        : "Thanks, I've added that to your journal.", { entry, urgent });
    });

    tool('message_family', {
      title: 'Message the family',
      description: 'Send a message to the family, e.g. "tell Priya I need more Metformin" or "let everyone know I\'m fine".',
      inputSchema: {
        message: z.string(),
        to: z.string().optional().describe('A family member\'s name; omit for everyone'),
        urgency: z.enum(['info', 'urgent']).default('info'),
      },
      annotations: { ...WRITE, openWorldHint: true },
    }, async ({ message, to, urgency = 'info' }) => {
      const target = to && store.caregivers.find((c) => c.name.toLowerCase() === to.toLowerCase());
      if (target) {
        store.notify.announce(target.id, `Message from ${recipient.name}: ${message}`, urgency === 'urgent' ? 'urgent' : 'family');
        store.notify.alertFamily({ type: 'message', urgency, topic: '_feed', message: `${recipient.name} to ${target.name}: ${message}` });
      } else {
        store.notify.alertFamily({ type: 'message', urgency, topic: 'messages', message: `${recipient.name}: ${message}` });
      }
      return reply(`Done. I've sent that to ${target ? target.name : store.caregivers.map((c) => c.name).join(' and ')}.`);
    });

    tool('get_my_messages', {
      title: 'Messages for me',
      description: 'Read out messages and news from the family that have not been heard yet ("any messages for me?").',
      inputSchema: {},
      annotations: WRITE,
    }, async () => {
      const unheard = store.announcements.filter((a) => a.to === person.id && a.kind === 'family' && !a.heard);
      unheard.forEach((a) => { a.heard = true; });
      store.save();
      return reply(unheard.length ? unheard.map((a) => a.text).join(' ') : 'No new messages from the family.', { messages: unheard });
    });
  }

  // ---------- Caregivers ----------

  function registerCaregiverTools() {
    tool('get_circle_status', {
      title: `How is ${recipient.name}?`,
      description:
        `The answer to "how's Mum doing?": today's doses, anything overdue, whether ${recipient.name}'s routine has changed ` +
        '(routine-drift check across voice logs and Ring front-door activity), open family tasks and recent alerts.',
      inputSchema: {},
      annotations: READ,
      _meta: ui('circle'),
    }, async () => {
      const s = await circleStatus(store, person);
      return reply(spokenCircleSummary(s), s);
    });

    tool('get_routine_insights', {
      title: 'Routine insights',
      description:
        `Explain changes in ${recipient.name}'s routine over the last few days compared with their own two-week baseline: ` +
        'night-time front-door activity (Ring), evening doses, dose timing, when the day starts, mood and new symptoms. ' +
        'Use for "has anything changed?" or "should I be worried?".',
      inputSchema: {},
      annotations: READ,
      _meta: ui('circle'),
    }, async () => {
      const drift = await driftWithNarrative(store);
      const s = await circleStatus(store, person);
      return reply(drift.narrative || drift.summary, { ...s, drift });
    });

    tool('get_care_digest', {
      title: 'Weekly digest',
      description: `Summarise the last week for the family: adherence, missed-dose patterns, mood, symptoms, low supply and upcoming appointments.`,
      inputSchema: { days: z.number().int().min(1).max(30).default(7) },
      annotations: READ,
    }, async ({ days = 7 }) => {
      const facts = digestFacts(store, days);
      let summary = templateDigest(facts);
      if (bedrockEnabled()) {
        try { summary = await writeDigest(facts); } catch (err) { console.warn('Bedrock digest failed:', err.message); }
      }
      return reply(summary, facts);
    });

    tool('list_family_tasks', {
      title: 'Family tasks',
      description: 'List open family tasks (refills, rides to appointments, visits) and who has taken each one.',
      inputSchema: {},
      annotations: READ,
    }, async () => {
      const tasks = openTasks(store);
      const speech = tasks.length
        ? tasks.map((t) => `${t.title.replace(/ \(.*\)$/, '')}: ${t.claimedByName ? `${t.claimedByName} has it` : 'nobody yet'}`).join('. ') + '.'
        : 'There are no open family tasks.';
      return reply(speech, { tasks });
    });

    tool('claim_task', {
      title: "I'll do it",
      description: 'Take on a family task, e.g. "I\'ll pick up the Lisinopril" or "I\'ll drive Mum to cardiology". The rest of the family is told.',
      inputSchema: { task: z.string().describe('Task id, or words from the task such as "lisinopril" or "cardiology"') },
      annotations: WRITE,
      _meta: { ui: { visibility: ['model', 'app'] } },
    }, async ({ task }) => {
      const result = claimTask(store, task, person.id);
      return { ...reply(result.message, { ok: result.ok, task: result.task ?? null, circle: await circleStatus(store, person, { useAi: false }) }), isError: !result.ok };
    });

    tool('complete_task', {
      title: 'Task done',
      description: 'Mark a family task as done, e.g. "I picked up the refill". Refills top up the tracked supply.',
      inputSchema: { task: z.string() },
      annotations: WRITE,
    }, async ({ task }) => {
      const result = completeTask(store, task, person.id);
      return { ...reply(result.message, { ok: result.ok, task: result.task ?? null }), isError: !result.ok };
    });

    tool('message_recipient', {
      title: `Message ${recipient.name}`,
      description: `Send ${recipient.name} a spoken message on their Echo, e.g. "tell Mum I'll visit on Sunday".`,
      inputSchema: { message: z.string() },
      annotations: { ...WRITE, openWorldHint: true },
    }, async ({ message }) => {
      store.notify.announce(recipient.id, `Message from ${person.name}: ${message}`, 'family');
      return reply(`Sent. ${recipient.name}'s Echo will read it out.`);
    });

    tool('add_medication', {
      title: 'Add a medication',
      description: 'Add a prescribed medication to the plan. Only when the caregiver states the name, dose and times; confirm the details back.',
      inputSchema: {
        name: z.string(),
        dose: z.string().describe('e.g. "10 mg" or "one tablet"'),
        times: z.array(z.string()).min(1).describe('Times of day, e.g. ["8am", "8pm"]'),
        purpose: z.string().optional().describe('What it is for, in plain words, e.g. "blood pressure"'),
        instructions: z.string().optional(),
        with_food: z.boolean().optional(),
        supply_count: z.number().int().min(0).optional(),
      },
      annotations: WRITE,
    }, async ({ name, dose, times, purpose = '', instructions = '', with_food = false, supply_count }) => {
      const parsed = times.map(parseTime);
      if (parsed.some((t) => !t)) return { ...reply(`I couldn't understand the times ${times.join(', ')}. Try something like "8 AM".`), isError: true };
      const med = {
        id: newId(), name, dose, purpose, times: [...new Set(parsed)].sort(), instructions, withFood: with_food, active: true,
        supply: supply_count != null ? { count: supply_count, perDose: 1 } : null, prescriber: '',
      };
      store.medications.push(med);
      store.save();
      store.notify.alertFamily({ type: 'plan_change', topic: 'tasks', exclude: person.id, message: `${person.name} added ${name} ${dose} at ${med.times.map(spokenTime).join(', ')}.` });
      store.notify.announce(recipient.id, `${person.name} added ${name} to your medicines, at ${med.times.map(spokenTime).join(' and ')}.`, 'family');
      return reply(`Added ${name}, ${dose}, at ${med.times.map(spokenTime).join(' and ')}. ${recipient.name} and the family have been told.`, { medication: med });
    });

    tool('stop_medication', {
      title: 'Stop a medication',
      description: 'Remove a medication from the plan when their doctor has stopped it. History is kept. Confirm with the caregiver before calling.',
      inputSchema: { medication: z.string(), confirmed: z.boolean().describe('true only after the caregiver confirmed') },
      annotations: { ...WRITE, destructiveHint: true },
    }, async ({ medication, confirmed }) => {
      const med = findMedication(store, medication);
      if (!med) return { ...reply(`I couldn't find ${medication} in the current plan.`), isError: true };
      if (!confirmed) return reply(`Just to confirm: remove ${med.name} ${med.dose} from ${recipient.name}'s plan?`, { needsConfirmation: true, medication: med.name });
      med.active = false;
      store.save();
      store.notify.alertFamily({ type: 'plan_change', topic: 'tasks', exclude: person.id, message: `${person.name} removed ${med.name} from the plan.` });
      return reply(`Okay, ${med.name} is off the plan. I've let the family know.`);
    });

    tool('add_appointment', {
      title: 'Add an appointment',
      description: "Save an appointment. Resolve relative dates (\"next Tuesday\") to YYYY-MM-DD. Set needs_ride if someone must drive; a family task is created.",
      inputSchema: {
        title: z.string().describe('e.g. "Dentist with Dr. Kim"'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`YYYY-MM-DD. Today is ${now(store).date}.`),
        time: z.string().optional().describe('e.g. "2:30 pm"'),
        location: z.string().optional(),
        notes: z.string().optional(),
        needs_ride: z.boolean().optional(),
      },
      annotations: WRITE,
    }, async ({ needs_ride = false, ...args }) => {
      const appt = addAppointment(store, { ...args, needsRide: needs_ride });
      store.notify.announce(recipient.id, `${person.name} added an appointment: ${appt.title} on ${appt.date}${appt.time ? ` at ${spokenTime(appt.time)}` : ''}.`, 'family');
      return reply(`Saved: ${appt.title} on ${appt.date}${appt.time ? ` at ${spokenTime(appt.time)}` : ''}.${needs_ride ? " I've added a family task for the ride." : ''}`, { appointment: appt });
    });

    tool('prepare_visit_brief', {
      title: 'Doctor visit brief',
      description: 'Prepare a one-page brief to take to an upcoming appointment: adherence, routine changes, symptoms, current medications and questions to ask.',
      inputSchema: { appointment: z.string().optional().describe('Words from the appointment title; defaults to the next one') },
      annotations: READ,
    }, async ({ appointment }) => {
      const appts = upcomingAppointments(store, 60);
      const appt = (appointment && appts.find((a) => a.title.toLowerCase().includes(appointment.toLowerCase()))) || appts[0];
      const drift = await driftWithNarrative(store, { useAi: false });
      const facts = {
        appointment: appt ? `${appt.title} on ${appt.date} at ${appt.spokenTime}` : 'next appointment',
        patient: recipient.name,
        last14Days: digestFacts(store, 14),
        routineChanges: drift.signals.filter((s) => s.flagged).map((s) => `${s.label}: ${s.recent} (usually ${s.baseline})`),
        medications: store.medications.filter((m) => m.active).map((m) => `${m.name} ${m.dose} at ${m.times.map(spokenTime).join(', ')}${m.prescriber ? ` (prescribed by ${m.prescriber})` : ''}`),
      };
      let brief = null;
      if (bedrockEnabled()) {
        try { brief = await writeVisitBrief(facts); } catch (err) { console.warn('Visit brief failed:', err.message); }
      }
      brief ??= templateBrief(facts);
      return reply(`Your brief for the ${appt?.title ?? 'appointment'} is ready. It covers adherence, routine changes, symptoms and questions to ask. It's also on the family dashboard to print.`,
        { appointment: appt ?? null, brief, facts });
    });

    tool('acknowledge_alerts', {
      title: 'Mark alerts as seen',
      description: 'Mark the family alerts as seen, e.g. after "okay, I\'ve called her".',
      inputSchema: {},
      annotations: WRITE,
    }, async () => {
      const unseen = store.alerts.filter((a) => !a.acknowledged);
      unseen.forEach((a) => { a.acknowledged = true; a.acknowledgedBy = person.id; });
      store.save();
      return reply(unseen.length ? `Marked ${unseen.length} alert${unseen.length > 1 ? 's' : ''} as seen.` : 'There were no new alerts.');
    });
  }

  // ---------- Resources and prompts ----------

  for (const [name, view] of Object.entries(VIEWS)) {
    server.registerResource(`${name}-view`, view.uri, {
      title: view.title,
      description: `Interactive ${view.title.toLowerCase()} for screens (MCP Apps).`,
      mimeType: UI_MIME,
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
    }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: UI_MIME, text: viewHtml(name) }] }));
  }

  server.registerResource('care-plan', 'carecircle://care-plan', {
    title: 'Care plan',
    description: 'The current medication plan, family members and circle settings as Markdown.',
    mimeType: 'text/markdown',
  }, async (uri) => {
    const c = store.circle;
    const md = [
      `# ${c.name}`,
      `Timezone: ${c.timezone} · Local time now: ${now(store).time} · Quiet hours ${c.quietHours.start}–${c.quietHours.end}`,
      '## Medications',
      ...store.medications.filter((m) => m.active).map((m) =>
        `- **${m.name}** ${m.dose} at ${m.times.map(spokenTime).join(', ')}${m.withFood ? ' (with food)' : ''}${m.purpose ? ` — for ${m.purpose}` : ''}`),
      '## People',
      ...store.people.map((p) => `- ${p.name}: ${p.role === 'recipient' ? 'care recipient' : `${p.relation}, notified about ${p.notify.join(', ')}`} (${p.device})`),
      '## Escalation',
      `Reminder when a dose is due, a second check-in after ${c.escalation.secondReminderAfter} min, family alerted after ${c.escalation.alertFamilyAfter} min.`,
    ].join('\n');
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] };
  });

  if (isRecipient) {
    server.registerPrompt('daily_check_in', {
      title: 'Daily check-in',
      description: 'A gentle morning or evening check-in.',
      argsSchema: { part_of_day: z.enum(['morning', 'evening']).optional() },
    }, ({ part_of_day = 'morning' }) => ({
      messages: [{ role: 'user', content: { type: 'text', text:
        `Run a short ${part_of_day} check-in with ${recipient.name}: greet them, ask how they slept and feel (log it with ` +
        'log_wellbeing), go over the doses that are due using get_today_schedule, read any new family messages with ' +
        'get_my_messages, and mention any appointment in the next two days. One or two sentences per turn.' } }],
    }));
  } else {
    server.registerPrompt('family_huddle', {
      title: 'Family huddle',
      description: `A two-minute catch-up on ${recipient.name} for a family member.`,
      argsSchema: {},
    }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text:
        `Give ${person.name} a two-minute catch-up on ${recipient.name}: use get_circle_status, explain any routine change ` +
        'with get_routine_insights, and ask whether they can take any open family task.' } }],
    }));
  }

  return server;
}

function templateBrief(f) {
  const d = f.last14Days;
  return [
    `# Visit brief: ${f.patient}`,
    `**Appointment:** ${f.appointment}`,
    '## Since the last visit',
    `- Took ${d.dosesTaken} of ${d.dosesScheduled} scheduled doses in the last 14 days (${d.adherenceRate}%).`,
    ...Object.entries(d.missedByMedication).map(([m, c]) => `- Missed ${m} ${c} time(s).`),
    '## Day-to-day',
    `- Average mood ${d.averageMood ?? 'n/a'} out of 5.`,
    ...Object.entries(d.symptoms).map(([s, c]) => `- Mentioned ${s} (${c}×).`),
    ...f.routineChanges.map((r) => `- ${r}`),
    '## Current medications',
    ...f.medications.map((m) => `- ${m}`),
    '## Questions to ask',
    '- Could any of the current medications affect sleep or cause confusion at night?',
    '- Is there a simpler time to take the evening doses?',
    '- What changes should prompt us to call before the next visit?',
  ].join('\n');
}
