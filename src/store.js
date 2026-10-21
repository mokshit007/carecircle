// Tiny JSON-file store. Good enough for a single household; swap for DynamoDB in production.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { localParts, householdNow, toMinutes, addDays } from './time.js';

const DATA_FILE = process.env.CARECIRCLE_DATA || path.resolve('data', 'carecircle.json');

export const newId = () => randomUUID().slice(0, 8);

export class Store {
  constructor(file = DATA_FILE) {
    this.file = file;
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      this.data = seedDemo();
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  reset() {
    this.data = seedDemo();
    this.save();
  }

  get household() { return this.data.household; }
  get medications() { return this.data.medications; }
  get doseLogs() { return this.data.doseLogs; }
  get wellbeing() { return this.data.wellbeing; }
  get appointments() { return this.data.appointments; }
  get alerts() { return this.data.alerts; }
  get caregivers() { return this.data.caregivers; }

  addAlert({ type, urgency = 'info', message }) {
    const alert = { id: newId(), at: new Date().toISOString(), type, urgency, message, acknowledged: false };
    this.data.alerts.unshift(alert);
    this.save();
    return alert;
  }
}

// Demo household with a week of realistic history so the dashboard and digest have something to show.
export function seedDemo() {
  const tz = process.env.CARECIRCLE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const medications = [
    { id: 'lisin', name: 'Lisinopril', dose: '10 mg', times: ['08:00'], instructions: 'For blood pressure', withFood: false, active: true },
    { id: 'metf', name: 'Metformin', dose: '500 mg', times: ['08:00', '19:00'], instructions: 'Take with a meal', withFood: true, active: true },
    { id: 'vitd', name: 'Vitamin D', dose: '1000 IU', times: ['12:00'], instructions: '', withFood: false, active: true },
    { id: 'ator', name: 'Atorvastatin', dose: '20 mg', times: ['21:00'], instructions: 'At bedtime', withFood: false, active: true },
  ];

  const now = new Date();
  const doseLogs = [];
  const wellbeing = [];
  const moods = [4, 3, 4, 2, 3, 4];
  const notes = [
    'Walked to the mailbox and back.',
    'A little tired after lunch.',
    'Daughter visited, good day.',
    'Knee was sore this morning.',
    'Slept poorly, woke up at 3am.',
    'Played cards with neighbours.',
  ];
  for (let d = 6; d >= 1; d--) {
    const { date } = localParts(addDays(now, -d), tz);
    for (const med of medications) {
      for (const time of med.times) {
        // Deterministic gaps: the evening Metformin dose is the one that tends to get missed.
        const missed = (med.id === 'metf' && time === '19:00' && (d === 2 || d === 4)) || (med.id === 'vitd' && d === 5);
        if (missed) continue;
        doseLogs.push({
          id: newId(), medId: med.id, date, time, status: 'taken',
          loggedAt: `${date}T${time}`, source: 'voice',
        });
      }
    }
    wellbeing.push({
      id: newId(), at: `${date}T10:30`, date, mood: moods[6 - d],
      symptoms: d === 3 ? ['knee pain'] : d === 2 ? ['fatigue'] : [],
      note: notes[6 - d], urgent: false,
    });
  }

  // Today: everything already due is taken except the morning Metformin, so the demo opens with one overdue dose.
  const today = householdNow(tz);
  for (const med of medications) {
    for (const time of med.times) {
      if (toMinutes(time) > today.minutes || (med.id === 'metf' && time === '08:00')) continue;
      doseLogs.push({ id: newId(), medId: med.id, date: today.date, time, status: 'taken', loggedAt: `${today.date}T${time}`, source: 'voice' });
    }
  }

  const appt = (days, time, title, location, notes = '') => ({
    id: newId(), title, date: localParts(addDays(now, days), tz).date, time, location, notes,
  });

  return {
    household: {
      recipient: process.env.CARECIRCLE_RECIPIENT || 'Margaret',
      timezone: tz,
      missedGraceMinutes: 60,
    },
    caregivers: [
      { id: 'c1', name: 'Priya', relation: 'daughter', notify: 'urgent' },
      { id: 'c2', name: 'Sam', relation: 'grandson', notify: 'digest' },
    ],
    medications,
    doseLogs,
    wellbeing,
    appointments: [
      appt(2, '10:30', 'Cardiology check-up with Dr. Alvarez', 'Riverside Clinic, 2nd floor', 'Bring blood pressure log'),
      appt(9, '14:00', 'Eye exam', 'Main Street Optometry'),
    ],
    alerts: [],
  };
}
