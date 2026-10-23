// Records the CareCircle demo video end to end: starts a fresh demo server, drives Microsoft Edge through the
// story, captures frames, narrates each scene with Windows text-to-speech, and muxes everything into an MP4.
//   node scripts/make-video.js [output.mp4]
// Requirements: Windows (System.Speech), Microsoft Edge, devDependencies puppeteer-core + ffmpeg-static.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import ffmpeg from 'ffmpeg-static';

const OUT = path.resolve(process.argv[2] || 'demo/carecircle-demo.mp4');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'carecircle-video-'));
const PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => fs.existsSync(p));
const VOICE = process.env.VIDEO_VOICE || 'Microsoft Zira Desktop';
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- narration ----------
function narrate(text, file) {
  const txt = file.replace(/\.wav$/, '.txt');
  fs.writeFileSync(txt, text, 'utf8');
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    try { $s.SelectVoice('${VOICE}') } catch {}; $s.Rate = 0;
    $s.SetOutputToWaveFile('${file}'); $s.Speak([IO.File]::ReadAllText('${txt}')); $s.Dispose()`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
  const buf = fs.readFileSync(file);
  const byteRate = buf.readUInt32LE(28);
  const dataIdx = buf.indexOf('data');
  return buf.readUInt32LE(dataIdx + 4) / byteRate; // seconds
}

// ---------- server ----------
async function startServer() {
  const dataFile = path.join(WORK, 'data.json');
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), CARECIRCLE_CLOCK: '13:30', ESCALATION_INTERVAL_MS: '3000', CARECIRCLE_DATA: dataFile, BEDROCK_ENABLED: 'false' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/me`)).ok) return child; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error('server did not start');
}
const api = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// ---------- recording ----------
const screencast = { onFrame: null };
let lastFrame = null;

async function startScreencast(page) {
  const cdp = await page.createCDPSession();
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    screencast.onFrame?.(data);
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
}

async function recordScene(page, index, scene) {
  const dir = path.join(WORK, `scene${String(index).padStart(2, '0')}`);
  fs.mkdirSync(dir);
  const wav = path.join(dir, 'narration.wav');
  const narrationSeconds = narrate(scene.say, wav);
  // Frames arrive from the screencast stream whenever the page repaints; static moments simply hold the last frame.
  const frames = [];
  const start = Date.now();
  if (lastFrame) frames.push({ file: lastFrame, t: start }); // carry the previous image until the first repaint
  screencast.onFrame = (data) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: Date.now() });
    lastFrame = file;
  };
  await scene.do(page).catch((err) => console.warn(`  scene ${index} action error: ${err.message}`));
  const minMs = (narrationSeconds + 0.6) * 1000;
  while (Date.now() - start < minMs) await sleep(50);
  screencast.onFrame = null;
  const total = (Date.now() - start) / 1000;
  if (!frames.length) throw new Error(`scene ${index} produced no frames`);

  // Variable frame timing → concat list with per-frame durations, so video and narration stay in sync.
  const list = frames.map((f, i) => {
    const next = frames[i + 1]?.t ?? (start + total * 1000);
    return `file '${f.file.replace(/\\/g, '/')}'\nduration ${Math.max(0.02, (next - f.t) / 1000).toFixed(3)}`;
  }).join('\n') + `\nfile '${frames.at(-1).file.replace(/\\/g, '/')}'\n`;
  fs.writeFileSync(path.join(dir, 'frames.txt'), list);
  const seg = path.join(dir, 'segment.mp4');
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'), '-i', wav,
    '-filter_complex', '[0:v]fps=30,scale=1280:720,format=yuv420p[v];[1:a]apad,aresample=44100[a]', '-map', '[v]', '-map', '[a]',
    '-t', total.toFixed(2), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', seg]);
  console.log(`  scene ${index}: ${total.toFixed(1)}s (${frames.length} frames)`);
  return { seg, total };
}

// ---------- helpers for the story ----------
async function card(page, title, subtitle, footer = '') {
  await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;
    background:radial-gradient(circle at 75% 20%,#17465a,#0e1a24 65%);color:#eef3f7;font-family:'Segoe UI',system-ui,sans-serif;text-align:center">
    <div style="max-width:980px;padding:0 40px">
      <div style="width:84px;height:84px;border-radius:50%;background:#0b7a75;display:grid;place-items:center;margin:0 auto 28px">
        <svg viewBox="0 0 64 64" width="48" height="48"><path d="M32 50s-17-10.3-17-21.8a9.7 9.7 0 0 1 17-6.4 9.7 9.7 0 0 1 17 6.4C49 39.7 32 50 32 50z" fill="#fff"/></svg></div>
      <div style="font-size:60px;font-weight:700;letter-spacing:-.5px">${title}</div>
      <div style="font-size:28px;color:#bfe3ea;margin-top:14px;line-height:1.4">${subtitle}</div>
      <div style="font-size:20px;color:#8fb3c4;margin-top:34px;line-height:1.6">${footer}</div>
    </div></body></html>`);
}

async function echo(page, device) {
  await page.goto(`${BASE}/echo.html?device=${device}`, { waitUntil: 'networkidle2' });
  await sleep(800);
}

async function say(page, text) {
  await page.$eval('#capAlexa', (el) => { el.textContent = ''; });
  await page.locator(`#chips button::-p-text(${text})`).click();
  await page.waitForFunction(() => {
    const t = document.querySelector('#capAlexa').textContent;
    return t && t !== '…';
  }, { timeout: 15000 });
  await sleep(400);
}

async function viewFrame(page) {
  const handle = await page.waitForSelector('#viewwrap iframe', { timeout: 10000 });
  const frame = await handle.contentFrame();
  await frame.waitForFunction(() => document.querySelector('#sub')?.textContent && !document.querySelector('#sub').textContent.includes('Loading'), { timeout: 15000 });
  return frame;
}

async function smoothScroll(target, y, ms = 1500) {
  await target.evaluate(async (y, ms) => {
    const from = window.scrollY, steps = Math.max(1, Math.round(ms / 30));
    for (let i = 1; i <= steps; i++) { window.scrollTo(0, from + ((y - from) * i) / steps); await new Promise((r) => setTimeout(r, 30)); }
  }, y, ms);
}

async function dashboard(page) {
  await page.goto(`${BASE}/?as=priya`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('#driftLevel')?.textContent !== '–');
  await sleep(500);
}

// ---------- the story ----------
const scenes = [
  {
    say: 'Amazon retired its Alexa Together caregiving service in 2024. But families still need it. This is CareCircle: one Alexa Plus for the whole family, built as an MCP server.',
    do: (p) => card(p, 'CareCircle', 'One Alexa+ for the whole family', 'An MCP server that connects an older adult’s Echo<br>with the Echo of everyone who cares for them'),
  },
  {
    say: 'Meet Margaret. She takes four medicines a day, and her daughter Priya lives in another city. This is Priya’s family dashboard, and it already has something to tell her.',
    do: async (p) => { await dashboard(p); await sleep(3000); },
  },
  {
    say: 'At half past one, Margaret’s morning Metformin still isn’t logged, so her kitchen Echo Show gently reminds her. If she still doesn’t confirm it, the family is told after an hour.',
    do: async (p) => {
      await echo(p, 'margaret');
      await api('/api/reset');
      await p.waitForSelector('#announce.on', { timeout: 10000 });
    },
  },
  {
    say: 'She asks what to take today. The Echo Show displays her medicines as an MCP Apps view, and one tap on, I took it, calls an app-only tool on the server.',
    do: async (p) => {
      await p.click('#annOk');
      await say(p, 'What do I take today?');
      const frame = await viewFrame(p);
      await sleep(1500);
      await frame.evaluate(() => document.querySelector('button[data-key]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      await sleep(1200);
      await frame.click('button[data-key]');
      await sleep(2500);
    },
  },
  {
    say: 'Older adults repeat themselves. When she says she took her Metformin again, CareCircle won’t log the evening dose hours early. It reassures her, and quietly tells the family.',
    do: async (p) => { await p.click('#closeView'); await say(p, 'I took my Metformin'); await sleep(1000); },
  },
  {
    say: 'Now Priya’s Echo. It’s the same MCP server, but Priya gets the caregiver tools. She asks how Mum is doing, and sees today’s doses, family tasks, and a routine check.',
    do: async (p) => {
      await echo(p, 'priya');
      await say(p, "How's Mum doing?");
      const frame = await viewFrame(p);
      await sleep(2500);
      await smoothScroll(frame, 420, 2500);
    },
  },
  {
    say: 'CareCircle compares the last three days with Margaret’s own baseline. Her Ring doorbell saw movement at the front door between two and three in the morning, three nights running. Evening doses are slipping, mornings start later, and her mood is lower. Every signal shows its numbers. None of it is a diagnosis.',
    do: async (p) => {
      await say(p, 'Has anything changed with her routine?');
      const frame = await viewFrame(p);
      await sleep(2000);
      await smoothScroll(frame, 130, 2000);
      await sleep(5000);
      await smoothScroll(frame, 0, 1500);
    },
  },
  {
    say: 'Priya says she’ll drive Mum to her cardiology appointment, and the task is hers. When she sends Mum a message, Margaret’s own Echo reads it out.',
    do: async (p) => {
      await p.click('#closeView').catch(() => {});
      await say(p, "I'll drive her to cardiology");
      await sleep(2500);
      await echo(p, 'margaret');
      await api('/api/app-tool', { personId: 'priya', name: 'message_recipient', arguments: { message: "I'll pick you up at ten on Saturday for your heart check-up. Love you." } });
      await p.waitForSelector('#announce.on', { timeout: 10000 });
    },
  },
  {
    say: 'Emergencies are never left to the AI. A fall, chest pain or trouble breathing triggers an instant family alert, from rules on the server.',
    do: async (p) => { await echo(p, 'margaret'); await say(p, 'I fell in the kitchen'); await sleep(1500); },
  },
  {
    say: 'Ring webhooks arrive signed and verified. Front door motion at 2:47 in the morning alerts the family. And the scariest case is silence. If Margaret hasn’t spoken to Alexa by mid morning, her Echo checks in, and if she doesn’t answer, the family is told.',
    do: async (p) => {
      await dashboard(p);
      await p.evaluate(() => document.querySelector('#nights').scrollIntoView({ block: 'start', behavior: 'smooth' }));
      await sleep(1500);
      await p.click('button[data-ring*="last-night"]');
      await sleep(4500);
      await p.click('#quiet');
      await sleep(2000);
      await p.evaluate(() => document.querySelector('#alerts').scrollIntoView({ block: 'center', behavior: 'smooth' }));
      await sleep(4000);
    },
  },
  {
    say: 'And before the cardiology visit, Priya gets a one page brief to hand to the doctor.',
    do: async (p) => {
      await dashboard(p);
      await p.evaluate(() => document.querySelector('#appts').scrollIntoView({ block: 'center' }));
      await sleep(600);
      await p.click('button[data-brief]');
      await p.waitForSelector('#briefDialog[open]', { timeout: 10000 });
      await sleep(1500);
      await p.evaluate(() => document.querySelector('#briefDialog').scrollBy({ top: 250, behavior: 'smooth' }));
    },
  },
  {
    say: 'CareCircle runs on MCP, version 2025-11-25, over Streamable HTTP, with role-scoped tools, MCP Apps, OAuth account linking, an Agent Skill, and Ring webhooks. It’s open source, with unit tests and continuous integration. CareCircle: peace of mind for the whole family.',
    do: (p) => card(p, 'CareCircle', 'MCP 2025-11-25 · Streamable HTTP · MCP Apps · OAuth 2.1 · Agent Skill · Ring',
      'Open source (MIT) · 15 unit tests + end-to-end tests in CI<br><b style="color:#eef3f7">github.com/mokshit007/carecircle</b>'),
  },
];

// ---------- main ----------
const server = await startServer();
const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true, protocolTimeout: 60_000,
  defaultViewport: { width: W, height: H }, args: [`--window-size=${W},${H}`],
});
try {
  const page = await browser.newPage();
  // The simulator speaks through the browser; the video gets narration instead.
  await page.evaluateOnNewDocument(() => {
    const quiet = { speak(u) { setTimeout(() => u.onend?.(), 50); }, cancel() {} };
    Object.defineProperty(window, 'speechSynthesis', { value: quiet });
    localStorage.clear();
  });
  page.on('dialog', (d) => d.accept());
  await startScreencast(page);
  const segments = [];
  console.log(`Recording ${scenes.length} scenes…`);
  for (const [i, scene] of scenes.entries()) segments.push(await recordScene(page, i, scene));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const list = path.join(WORK, 'segments.txt');
  fs.writeFileSync(list, segments.map((s) => `file '${s.seg.replace(/\\/g, '/')}'`).join('\n'));
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', OUT]);
  const total = segments.reduce((a, s) => a + s.total, 0);
  console.log(`\nDone: ${OUT} (${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')})`);
} finally {
  await browser.close();
  server.kill();
}
