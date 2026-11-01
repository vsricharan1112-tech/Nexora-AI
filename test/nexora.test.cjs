const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, before, describe, test } = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
let child;
let base;
let temp;

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function startServer({ geminiKey = '', mockGemini = false, supabaseUrl = '', supabaseAnonKey = '' } = {}) {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await close(probe);
  base = `http://127.0.0.1:${port}`;
  temp = fs.mkdtempSync(path.join(root, '.nexora-test-'));
  const args = [...(mockGemini ? ['--require', path.join(root, 'test-fixtures', 'mock-gemini.cjs')] : []), path.join(root, 'nexora-server.cjs')];
  child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NEXORA_DATA_DIR: path.join(temp, 'data'),
      NEXORA_DISABLE_DOTENV: '1',
      GEMINI_API_KEY: geminiKey,
      SUPABASE_URL: supabaseUrl,
      SUPABASE_ANON_KEY: supabaseAnonKey,
      NEXORA_ADMIN_TOKEN: 'test-only-admin-token'
    },
    stdio: 'ignore'
  });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null && child.exitCode !== undefined) throw new Error(`Nexora server exited early (${child.exitCode}).`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Nexora server did not start within six seconds.');
}

async function stopServer() {
  const current = child;
  if (current && current.exitCode === null) {
    current.kill('SIGTERM');
    await new Promise(resolve => current.once('exit', resolve));
  }
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  child = null;
  temp = null;
}

async function jsonRequest(route, options = {}) {
  const response = await fetch(`${base}${route}`, options);
  const value = await response.json().catch(() => null);
  return { response, value };
}

test('the inline app JavaScript parses and the 16 module routes are unique', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline application script exists');
  new vm.Script(match[1], { filename: 'index.html inline script' });

  const list = match[1].match(/const P=(\[[\s\S]*?\]);/);
  assert.ok(list, 'module catalogue exists');
  const ids = [...list[1].matchAll(/\['([^']+)'/g)].map(item => item[1]);
  assert.equal(ids.length, 16);
  assert.equal(new Set(ids).size, ids.length, 'module IDs do not conflict');
  assert.match(match[1], /GEMINI_API_KEY/, 'the interface explains how the free-tier AI is enabled');
  assert.doesNotMatch(match[1], /OPENAI_API_KEY|web search enabled/, 'the interface does not claim the old paid provider or unsupported web search');
  assert.equal((match[1].match(/function go\(/g) || []).length, 1, 'only one active route handler exists');
  assert.equal((match[1].match(/function show\(/g) || []).length, 1, 'only one navigation entry point exists');
  assert.match(match[1], /window\.addEventListener\('popstate'/, 'browser Back and Forward restore app sections');

  const values = new Map();
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] || null,
    get length() { return values.size; }
  };
  const nodes = new Map();
  const documentEvents = new Map();
  const makeNode = () => ({ innerHTML: '', textContent: '', className: '', title: '', onclick: null, onkeydown: null,
    classList: { toggle() {}, add() {}, remove() {} }, insertBefore() {}, querySelectorAll() { return []; } });
  for (const selector of ['#navCore', '#navExplore', '#main', '#crumb', '#view', '.top-actions', '#quickTask', '#search']) nodes.set(selector, makeNode());
  const document = {
    querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener: (name, handler) => documentEvents.set(name, handler)
  };
  const history = { state: null, pushState(state) { this.state = state; } };
  const context = vm.createContext({ document, window: { scrollTo() {}, addEventListener() {} }, history,
    location: { protocol: 'https:', pathname: '/', search: '', hash: '' }, localStorage: storage, sessionStorage: storage,
    fetch: async () => { throw new Error('unexpected network access in module render check'); }, console, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(match[1], context, { filename: 'index.html inline app' });
  const pageMap = vm.runInContext('pageMap', context);
  for (const id of ids) {
    const html = pageMap[id]();
    assert.equal(typeof html, 'string', `${id} returns HTML`);
    assert.match(html, /<section|<div|<form|<article/, `${id} renders visible content`);

    let prevented = false;
    const target = { dataset: { page: id }, closest() { return this; } };
    documentEvents.get('click')({ target, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, `${id} click stays inside the app`);
    assert.equal(nodes.get('#crumb').textContent, `Workspace / ${vm.runInContext(`P.find(item=>item[0]===${JSON.stringify(id)})[2]`, context)}`, `${id} routes to its own section`);
    assert.equal(history.state.nexoraPage, id, `${id} has the correct history state`);
  }
  for (const url of ['https://www.youtube.com/results?search_query=', 'https://www.myscheme.gov.in/', 'https://scholarships.gov.in/', 'https://www.ugc.gov.in/Home/student_Corner']) {
    assert.ok(match[1].includes(url), `expected learning/government source ${url}`);
  }
});

describe('Nexora HTTP server', () => {
before(startServer);
after(stopServer);

test('self-service deletion only uses the verified caller and a server-side admin key', () => {
  const source = fs.readFileSync(path.join(root, 'supabase', 'functions', 'delete-account', 'index.ts'), 'utf8');
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /auth\/v1\/user/, 'the function verifies the bearer token with Supabase Auth');
  assert.match(source, /auth\/v1\/admin\/users\//, 'admin deletion targets the verified user id');
  assert.match(source, /user\.id/);
  assert.doesNotMatch(source, /request\.json/, 'the caller cannot provide a different account id');
});

test('the public homepage and required account/static assets are served', async () => {
  const home = await fetch(`${base}/`);
  const html = await home.text();
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(html, /window\.NEXORA_CONFIG=/);
  assert.match(html, /nexora-account\.js/);

  const accountClient = await fetch(`${base}/nexora-account.js`);
  const accountScript = await accountClient.text();
  assert.match(accountScript, /signup\?redirect_to=/, 'new accounts return to the hosted Nexora page for email verification');
  assert.match(accountScript, /api\/account\/delete/, 'signed-in users can request account and cloud-data deletion');

  for (const [url, type] of [['/nexora-account.js', /javascript/], ['/nexora-account.css', /text\/css/], ['/privacy.html', /text\/html/], ['/terms.html', /text\/html/]]) {
    const asset = await fetch(`${base}${url}`);
    assert.equal(asset.status, 200, `${url} is served`);
    assert.match(asset.headers.get('content-type'), type);
  }
});

test('health reports optional AI and account integrations accurately while keys are absent', async () => {
  const { response, value } = await jsonRequest('/api/health');
  assert.equal(response.status, 200);
  assert.equal(value.ok, true);
  assert.equal(value.aiConfigured, false);
  assert.equal(value.accountsConfigured, false);
  assert.equal(value.rooms, 'live-in-memory');
});

test('NEXA fails clearly without a Gemini key and makes no provider call', async () => {
  const { response, value } = await jsonRequest('/api/nexa', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] })
  });
  assert.equal(response.status, 503);
  assert.match(value.error, /GEMINI_API_KEY/);
});

test('NEXA sends the last 12 turns to Gemini and returns its answer without exposing the key', async () => {
  await stopServer();
  await startServer({ geminiKey: 'test-only-gemini-key', mockGemini: true });
  const messages = Array.from({ length: 13 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message-${i}` }));
  const { response, value } = await jsonRequest('/api/nexa', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages })
  });
  assert.equal(response.status, 200);
  assert.equal(value.text, 'Mock Gemini answer');
  assert.equal(value.provider, 'Gemini');
  assert.equal(value.model, 'gemini-3.5-flash-lite');
  assert.doesNotMatch(JSON.stringify(value), /test-only-gemini-key/);
  const health = await jsonRequest('/api/health');
  assert.equal(health.value.aiConfigured, true);
});

test('study rooms support join, chat, poll, heartbeat and leave', async () => {
  const id = 'testStudent_01';
  const join = await jsonRequest('/api/rooms/test-room/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: 'Test Student' })
  });
  assert.equal(join.response.status, 200);
  assert.equal(join.value.participants[0].name, 'Test Student');

  const chat = await jsonRequest('/api/rooms/test-room/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text: 'Ready to study together.' })
  });
  assert.equal(chat.response.status, 201);
  assert.equal(chat.value.message.text, 'Ready to study together.');

  const poll = await jsonRequest('/api/rooms/test-room?since=0');
  assert.equal(poll.response.status, 200);
  assert.equal(poll.value.messages.length, 1);

  const heartbeat = await jsonRequest('/api/rooms/test-room/heartbeat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
  });
  assert.equal(heartbeat.response.status, 200);
  assert.equal(heartbeat.value.ok, true);

  const leave = await jsonRequest('/api/rooms/test-room/leave', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
  });
  assert.equal(leave.response.status, 200);
  assert.equal(leave.value.ok, true);
});

test('mentor applications are private until approval and the admin route is protected', async () => {
  const application = await jsonRequest('/api/mentors/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Student', email: 'nexora-test@example.invalid', institution: 'Test College', year: '1st year', topics: 'Math', bio: 'A test profile.', availability: 'Weekends', publicContact: true })
  });
  assert.equal(application.response.status, 201);

  const denied = await jsonRequest('/api/admin/mentor-applications');
  assert.equal(denied.response.status, 401);

  const review = await jsonRequest('/api/admin/mentor-applications', { headers: { Authorization: 'Bearer test-only-admin-token' } });
  assert.equal(review.response.status, 200);
  assert.equal(review.value.applications.length, 1);
  assert.equal(review.value.applications[0].status, 'pending');

  const publicMentors = await jsonRequest('/api/mentors');
  assert.equal(publicMentors.response.status, 200);
  assert.equal(publicMentors.value.mentors.length, 0);
});

test('invalid JSON, missing routes, unsupported methods and private admin data fail closed', async () => {
  const invalidJson = await fetch(`${base}/api/rooms/test-room/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
  });
  assert.equal(invalidJson.status, 400);

  const missing = await jsonRequest('/api/does-not-exist');
  assert.equal(missing.response.status, 404);

  const adminDenied = await jsonRequest('/api/admin/mentor-requests');
  assert.equal(adminDenied.response.status, 401);

  const unsupported = await fetch(`${base}/`, { method: 'POST' });
  assert.equal(unsupported.status, 405);
});

test('Supabase mode uses per-user bearer tokens and fails closed without sign-in', async () => {
  await stopServer();
  const authTokens = new Map();
  const calls = [];
  const jwt = (sub, admin = false) => {
    const token = `test.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
    authTokens.set(token, { id: sub, app_metadata: admin ? { nexora_admin: true } : {} });
    return token;
  };
  const studentId = '0c31d835-4b64-41b7-bdd6-94164dcd2267';
  const adminId = '60d7957f-1956-4d52-b4d6-66c43088ac7a';
  const studentToken = jwt(studentId);
  const adminToken = jwt(adminId, true);
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    calls.push({ path: url.pathname, method: req.method, bearer, apikey: req.headers.apikey, body });
    const send = (status, value = '') => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (url.pathname === '/auth/v1/user') {
      const user = authTokens.get(bearer);
      if (user) user.email = 'student@example.invalid';
      return user ? send(200, user) : send(401, { message: 'Invalid token' });
    }
    if (url.pathname === '/functions/v1/delete-account' && req.method === 'POST') {
      if (!authTokens.has(bearer)) return send(401, { message: 'Invalid token' });
      authTokens.delete(bearer);
      return send(200, { ok: true });
    }
    if (!authTokens.has(bearer) && bearer !== 'test-publishable-key') return send(401, { message: 'Invalid bearer' });
    if (url.pathname === '/rest/v1/nexora_mentors' && req.method === 'GET') return send(200, []);
    if (url.pathname === '/rest/v1/nexora_room_members' && req.method === 'POST') return send(201);
    if (url.pathname === '/rest/v1/nexora_room_presence' && req.method === 'POST') return send(201);
    if (url.pathname === '/rest/v1/nexora_room_presence' && req.method === 'GET') return send(200, []);
    if (url.pathname === '/rest/v1/nexora_mentor_applications' && req.method === 'POST') return send(201);
    if (url.pathname === '/rest/v1/nexora_mentor_applications' && req.method === 'GET') return send(200, []);
    return send(404, { message: `Unexpected fake Supabase request: ${req.method} ${url.pathname}` });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const supabaseUrl = `http://127.0.0.1:${provider.address().port}`;
  try {
    await startServer({ supabaseUrl, supabaseAnonKey: 'test-publishable-key' });
    const health = await jsonRequest('/api/health');
    assert.equal(health.value.accountsConfigured, true);
    assert.equal(health.value.rooms, 'supabase-rls-persisted');

    const mentors = await jsonRequest('/api/mentors');
    assert.equal(mentors.response.status, 200);
    assert.ok(calls.some(call => call.path === '/rest/v1/nexora_mentors' && call.apikey === 'test-publishable-key'));

    for (const route of ['/api/rooms/test-room/join', '/api/mentors/apply', '/api/mentorship/request']) {
      const denied = await jsonRequest(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(denied.response.status, 401, `${route} requires an account`);
    }
    const adminDenied = await jsonRequest('/api/admin/mentor-applications');
    assert.equal(adminDenied.response.status, 403);
    const studentAdminDenied = await jsonRequest('/api/admin/mentor-applications', { headers: { Authorization: `Bearer ${studentToken}` } });
    assert.equal(studentAdminDenied.response.status, 403, 'a signed-in student without the trusted admin claim cannot review data');

    const join = await jsonRequest('/api/rooms/test-room/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ id: 'testStudent_01', name: 'Cloud Student' })
    });
    assert.equal(join.response.status, 200);
    assert.ok(calls.some(call => call.path === '/rest/v1/nexora_room_members' && call.bearer === studentToken));

    const application = await jsonRequest('/api/mentors/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ name: 'Cloud Student', email: 'cloud@example.invalid', institution: 'Test College', year: '1st year', topics: 'Math', availability: 'Weekends', publicContact: true })
    });
    assert.equal(application.response.status, 201);
    assert.ok(calls.some(call => call.path === '/rest/v1/nexora_mentor_applications' && call.method === 'POST' && call.bearer === studentToken));

    const adminReview = await jsonRequest('/api/admin/mentor-applications', { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(adminReview.response.status, 200);
    assert.ok(calls.some(call => call.path === '/rest/v1/nexora_mentor_applications' && call.method === 'GET' && call.bearer === adminToken));
    const anonymousDelete = await jsonRequest('/api/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(anonymousDelete.response.status, 401);
    const wrongEmailDelete = await jsonRequest('/api/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + studentToken }, body: JSON.stringify({ confirmEmail: 'someone-else@example.invalid' }) });
    assert.equal(wrongEmailDelete.response.status, 400);
    assert.equal(calls.some(call => call.path === '/functions/v1/delete-account'), false, 'a mismatched confirmation never reaches the deletion function');
    const deletion = await jsonRequest('/api/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + studentToken }, body: JSON.stringify({ confirmEmail: 'STUDENT@example.invalid' }) });
    assert.equal(deletion.response.status, 200);
    assert.equal(deletion.value.ok, true);
    assert.ok(calls.some(call => call.path === '/functions/v1/delete-account' && call.bearer === studentToken));
    const deletedSession = await jsonRequest('/api/rooms/deleted-check/join', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + studentToken }, body: JSON.stringify({ id: 'testStudent_01', name: 'Deleted Student' }) });
    assert.equal(deletedSession.response.status, 401, 'deleted accounts cannot continue using Supabase-backed features');
  } finally {
    await stopServer();
    await close(provider);
  }
});
});

