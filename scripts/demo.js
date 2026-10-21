// One-command demo: fresh demo data, a pinned household clock (default 1:30 PM) so one dose is overdue,
// and fast reminder ticks. Usage: npm run demo [-- 09:15]
import fs from 'node:fs';
import path from 'node:path';

process.env.CARECIRCLE_CLOCK ||= process.argv[2] || '13:30';
process.env.ESCALATION_INTERVAL_MS ||= '5000';
fs.rmSync(path.resolve('data', 'carecircle.json'), { force: true });
console.log(`Demo mode: household clock pinned to ${process.env.CARECIRCLE_CLOCK}, fresh demo data.`);
await import('../src/server.js');
