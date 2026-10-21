// Fan-out for everything proactive: spoken announcements on a person's Echo, the family alert
// feed, live updates to open dashboards, and (optionally) Amazon SNS text/email to caregivers.
import { EventEmitter } from 'node:events';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { newId } from './store.js';

const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
let sns;

export function createNotifier(store) {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);

  async function publishSns(subject, message) {
    if (!SNS_TOPIC_ARN) return;
    try {
      sns ??= new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });
      await sns.send(new PublishCommand({ TopicArn: SNS_TOPIC_ARN, Subject: subject.slice(0, 99), Message: message }));
    } catch (err) {
      console.warn('SNS publish failed:', err.message);
    }
  }

  const notifier = {
    bus,

    // Something a specific person's Echo should say out loud.
    announce(personId, text, kind = 'reminder') {
      const a = { id: newId(), at: new Date().toISOString(), to: personId, text, kind, heard: false };
      store.announcements.push(a);
      if (store.announcements.length > 200) store.announcements.splice(0, store.announcements.length - 200);
      store.save();
      bus.emit('announcement', a);
      return a;
    },

    // An entry in the family feed, announced to caregivers who opted into this topic.
    alertFamily({ type, urgency = 'info', topic = type, message, exclude, key }) {
      if (key && store.alerts.some((a) => a.key === key)) return null;
      const alert = { id: newId(), at: new Date().toISOString(), type, urgency, topic, message, key, acknowledged: false };
      store.alerts.unshift(alert);
      if (store.alerts.length > 100) store.alerts.length = 100;
      store.save();
      bus.emit('alert', alert);
      for (const c of store.caregivers) {
        if (c.id === exclude || !c.notify?.includes(topic)) continue;
        notifier.announce(c.id, urgency === 'urgent' ? `Urgent from CareCircle: ${message}` : `CareCircle update: ${message}`, urgency === 'urgent' ? 'urgent' : 'family');
      }
      if (urgency === 'urgent' || topic === 'escalation' || topic === 'drift') {
        publishSns(`CareCircle: ${store.recipient.name}`, message);
      }
      return alert;
    },
  };

  store.notify = notifier;
  store.onChange(() => bus.emit('changed'));
  return notifier;
}
