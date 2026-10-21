// MCP Apps views. Each view is a single self-contained HTML document (the host renders it in a
// sandboxed iframe with a strict CSP), so the ext-apps App runtime is inlined into the page.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

const require = createRequire(import.meta.url);
const VIEWS_DIR = path.resolve('src', 'views');

export const UI_MIME = RESOURCE_MIME_TYPE;
export const VIEWS = {
  today: { uri: 'ui://carecircle/today.html', file: 'today.html', title: "Today's medicines" },
  circle: { uri: 'ui://carecircle/circle.html', file: 'circle.html', title: 'Care circle overview' },
};

let runtime;
// The published bundle is an ES module ending in `export{...}`; turn the exports into a global
// so the view's own inline script can use them without a second network request.
function appRuntime() {
  if (runtime) return runtime;
  const file = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
  const src = fs.readFileSync(file, 'utf8');
  const match = src.match(/export\s*\{([^}]*)\}\s*;?\s*(\/\/#.*)?\s*$/);
  if (!match) throw new Error('Unexpected ext-apps bundle format');
  const pairs = match[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [local, exported] = p.split(/\s+as\s+/);
    return `${JSON.stringify((exported || local).trim())}: ${local.trim()}`;
  });
  runtime = `${src.slice(0, match.index)}\nglobalThis.McpApps = { ${pairs.join(', ')} };\n`;
  return runtime;
}

const cache = new Map();
export function viewHtml(name) {
  if (process.env.NODE_ENV === 'production' && cache.has(name)) return cache.get(name);
  const html = fs.readFileSync(path.join(VIEWS_DIR, VIEWS[name].file), 'utf8')
    // A separate module script keeps the bundle's identifiers out of the view's scope; module
    // scripts run in document order, so McpApps is defined before the view code needs it.
    .replace('<script type="module">', () => `<script type="module">\n${appRuntime()}\n</script>\n<script type="module">`);
  cache.set(name, html);
  return html;
}
