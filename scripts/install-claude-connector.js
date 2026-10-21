// Adds the CareCircle connectors (Priya and Margaret) to the Claude desktop app's config.
// Quit Claude completely first: the app rewrites its config from memory and would drop the change.
//   npm run install-claude
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-bridge.js');
const force = process.argv.includes('--force');

function claudeRunning() {
  try {
    if (process.platform === 'win32') return /claude\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq Claude.exe" /NH', { encoding: 'utf8' }));
    return execSync('pgrep -x Claude || true', { encoding: 'utf8' }).trim().length > 0;
  } catch { return false; }
}

function configFiles() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const dataRoot = path.join(local, 'Claude-Data');
    if (fs.existsSync(dataRoot)) {
      for (const dir of fs.readdirSync(dataRoot)) candidates.push(path.join(dataRoot, dir, 'claude_desktop_config.json'));
    }
    candidates.push(path.join(roaming, 'Claude', 'claude_desktop_config.json'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  } else {
    candidates.push(path.join(home, '.config', 'Claude', 'claude_desktop_config.json'));
  }
  const existing = candidates.filter((f) => fs.existsSync(f));
  return existing.length ? existing : [candidates.at(-1)];
}

if (claudeRunning() && !force) {
  console.error('The Claude desktop app is running. Quit it completely (also from the system tray), then run this again.');
  process.exit(1);
}

for (const file of configFiles()) {
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-carecircle`);
  cfg.mcpServers = {
    ...(cfg.mcpServers || {}),
    'carecircle-priya': { command: process.execPath, args: [bridge, '--as', 'priya'] },
    'carecircle-margaret': { command: process.execPath, args: [bridge, '--as', 'margaret'] },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log(`Added carecircle-priya and carecircle-margaret to ${file}`);
}
console.log('Start CareCircle (npm run demo), then open Claude and enable one CareCircle connector per chat.');
