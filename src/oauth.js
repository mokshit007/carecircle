// OAuth 2.1 account linking, so an assistant (Alexa+, Claude, any MCP client) can connect to CareCircle as a
// specific member of the care circle. Built on the MCP SDK's authorization-server router:
//   discovery      /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp
//   registration   POST /register        (dynamic client registration)
//   authorization  GET  /authorize       → CareCircle consent page (choose who you are + PIN), PKCE required
//   token          POST /token           (authorization_code with PKCE, refresh_token with rotation)
//   revocation     POST /revoke
// Tokens are random 256-bit values; only their SHA-256 hashes are stored.
import { randomBytes, randomUUID } from 'node:crypto';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidGrantError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { sha256, secretEquals } from './store.js';

const ACCESS_TTL = 60 * 60;               // 1 hour
const REFRESH_TTL = 30 * 24 * 60 * 60;    // 30 days
const CODE_TTL = 5 * 60 * 1000;           // 5 minutes
const SCOPES = ['carecircle'];

const hashOf = (token) => sha256(token).toString('hex');
const newToken = () => randomBytes(32).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class CareCircleAuthProvider {
  constructor(store, { resourceUrl }) {
    this.store = store;
    this.resourceUrl = resourceUrl;
    this.codes = new Map();    // code -> { clientId, personId, params, expires }
    this.pending = new Map();  // consent request id -> { client, params, expires }
    this.clientsStore = {
      getClient: async (clientId) => store.data.oauth.clients[clientId],
      registerClient: async (client) => {
        store.data.oauth.clients[client.client_id] = client;
        store.save();
        return client;
      },
    };
  }

  // Called by the SDK after it has validated the client, redirect URI and PKCE parameters.
  async authorize(client, params, res) {
    const requestId = randomUUID();
    this.pending.set(requestId, { client, params, expires: Date.now() + 10 * 60 * 1000 });
    res.type('html').send(consentPage(this.store, client, requestId));
  }

  // POST /oauth/consent from the consent page.
  async consent(req, res) {
    const { request_id: requestId, person_id: personId, pin, decision } = req.body ?? {};
    const pending = this.pending.get(requestId);
    if (!pending || pending.expires < Date.now()) return res.status(400).type('html').send(messagePage('This link has expired. Start linking again from your assistant.'));
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state !== undefined) redirect.searchParams.set('state', pending.params.state);

    if (decision !== 'allow') {
      this.pending.delete(requestId);
      redirect.searchParams.set('error', 'access_denied');
      return res.redirect(redirect.href);
    }
    const person = this.store.person(personId);
    if (!person || !secretEquals(person.pin, pin)) {
      return res.status(401).type('html').send(consentPage(this.store, pending.client, requestId, 'That PIN is not right. Please try again.'));
    }
    this.pending.delete(requestId);
    const code = newToken();
    this.codes.set(code, { clientId: pending.client.client_id, personId: person.id, params: pending.params, expires: Date.now() + CODE_TTL });
    redirect.searchParams.set('code', code);
    res.redirect(redirect.href);
  }

  async challengeForAuthorizationCode(client, code) {
    return this.#code(client, code).params.codeChallenge;
  }

  // PKCE (code_verifier vs. code_challenge) is checked by the SDK's token handler before this runs.
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const data = this.#code(client, code);
    if (redirectUri && redirectUri !== data.params.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
    this.#checkResource(resource ?? data.params.resource);
    this.codes.delete(code);
    return this.#issue(client.client_id, data.personId, data.params.scopes);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const key = hashOf(refreshToken);
    const record = this.store.data.oauth.tokens[key];
    if (!record || record.type !== 'refresh' || record.clientId !== client.client_id || record.expiresAt < Date.now() / 1000) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    this.#checkResource(resource);
    delete this.store.data.oauth.tokens[key]; // rotation: each refresh token works once
    return this.#issue(client.client_id, record.personId, scopes?.length ? scopes : record.scopes);
  }

  async verifyAccessToken(token) {
    const record = this.store.data.oauth.tokens[hashOf(token)];
    if (!record || record.type !== 'access' || record.expiresAt < Date.now() / 1000) throw new Error('Invalid or expired token');
    return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt, extra: { personId: record.personId } };
  }

  async revokeToken(client, { token }) {
    const key = hashOf(token);
    if (this.store.data.oauth.tokens[key]?.clientId === client.client_id) {
      delete this.store.data.oauth.tokens[key];
      this.store.save();
    }
  }

  #code(client, code) {
    const data = this.codes.get(code);
    if (!data || data.expires < Date.now() || data.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return data;
  }

  #checkResource(resource) {
    if (resource && new URL(resource).href.replace(/\/$/, '') !== this.resourceUrl.href.replace(/\/$/, '')) {
      throw new InvalidRequestError(`This server only issues tokens for ${this.resourceUrl.href}`);
    }
  }

  #issue(clientId, personId, scopes = SCOPES) {
    const now = Math.floor(Date.now() / 1000);
    const access = newToken();
    const refresh = newToken();
    const tokens = this.store.data.oauth.tokens;
    // Drop expired tokens while we're here.
    for (const [k, t] of Object.entries(tokens)) if (t.expiresAt < now) delete tokens[k];
    tokens[hashOf(access)] = { type: 'access', clientId, personId, scopes, expiresAt: now + ACCESS_TTL };
    tokens[hashOf(refresh)] = { type: 'refresh', clientId, personId, scopes, expiresAt: now + REFRESH_TTL };
    this.store.save();
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(' ') };
  }
}

export function setupOAuth(app, store, { publicUrl }) {
  const resourceUrl = new URL('/mcp', publicUrl);
  const provider = new CareCircleAuthProvider(store, { resourceUrl });
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(publicUrl),
    resourceServerUrl: resourceUrl,
    scopesSupported: SCOPES,
    resourceName: 'CareCircle',
  }));
  app.post('/oauth/consent', (req, res) => provider.consent(req, res));
  return { provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) };
}

function consentPage(store, client, requestId, error) {
  const people = store.people.map((p) => `<label class="who"><input type="radio" name="person_id" value="${esc(p.id)}" required>
      <span><b>${esc(p.name)}</b><br><small>${p.role === 'recipient' ? 'the person being cared for' : esc(p.relation)}</small></span></label>`).join('');
  return page(`Link ${esc(client.client_name || 'your assistant')} to CareCircle`, `
    <p><b>${esc(client.client_name || 'An assistant')}</b> wants to connect to <b>${esc(store.circle.name)}</b>.
      It will be able to read and update medicines, appointments, check-ins and family tasks for the person you choose.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <form method="post" action="/oauth/consent">
      <input type="hidden" name="request_id" value="${esc(requestId)}">
      <p class="label">Who is this assistant for?</p>
      <div class="people">${people}</div>
      <p class="label">Your CareCircle PIN</p>
      <input name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required>
      <p class="hint">Demo PINs: Margaret 1111 · Priya 2222 · Sam 3333</p>
      <div class="row"><button name="decision" value="allow" class="primary">Allow</button><button name="decision" value="deny" formnovalidate>Cancel</button></div>
    </form>`);
}

const messagePage = (text) => page('CareCircle', `<p>${esc(text)}</p>`);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
:root{--bg:#f4f2ec;--card:#fff;--ink:#1d2330;--muted:#677083;--line:#e6e1d6;--accent:#0b7a75}
@media (prefers-color-scheme:dark){:root{--bg:#0f1217;--card:#181c24;--ink:#e9ecf1;--muted:#98a2b3;--line:#262c37;--accent:#3cc4bc}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;max-width:460px;width:100%}
h1{font-size:20px;margin:0 0 8px}.label{font-weight:700;margin:16px 0 6px}.hint{color:var(--muted);font-size:13px}
.people{display:grid;gap:8px}.who{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:8px 12px;cursor:pointer}
small{color:var(--muted)}input[name=pin]{font:inherit;padding:10px;border-radius:10px;border:1px solid var(--line);width:100%;box-sizing:border-box;background:var(--card);color:var(--ink)}
.row{display:flex;gap:8px;margin-top:16px}button{font:inherit;font-weight:700;padding:10px 18px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}.err{color:#b93a2e;font-weight:600}
</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}
