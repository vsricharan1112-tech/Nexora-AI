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

async function startServer({ geminiKey = '', mockGemini = false } = {}) {
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
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
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

test('the public homepage and required account/static assets are served', async () => {
  const home = await fetch(`${base}/`);
  const html = await home.text();
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(html, /window\.NEXORA_CONFIG=/);
  assert.match(html, /nexora-account\.js/);

  for (const [url, type] of [['/nexora-account.js', /javascript/], ['/nexora-account.css', /text\/css/], ['/privacy.html', /text\/html/]]) {
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
  assert.equal(value.model, 'gemini-2.5-flash-lite');
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
});
