// Nexora AI local/pilot server. Node 20+; intentionally uses only built-in modules.
// Keep OPENAI_API_KEY on the server. Never put it in the HTML or commit it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA = path.resolve(process.env.NEXORA_DATA_DIR || path.join(ROOT, 'nexora-data'));
const HTML = path.join(ROOT, 'index.html');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const BUILD_ID = 'nexora-local-pilot-stable-4173-v1';
const PRESENCE_TTL = 25000;
const MAX_BODY = 24000;
const rooms = new Map();
const limits = new Map();

// Optional .env support for local pilots; .env is ignored by git.
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';

fs.mkdirSync(DATA, { recursive: true });
for (const name of ['mentor-applications.json', 'mentors.json']) {
  const file = path.join(DATA, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]\n', { flag: 'wx' });
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  res.end(body);
}
function readArray(name) {
  try { const data = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); return Array.isArray(data) ? data : []; }
  catch { return []; }
}
function writeArray(name, value) {
  const target = path.join(DATA, name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
}
function clean(value, max = 240) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function rateLimit(req, key, max = 40, windowMs = 60000) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const id = `${ip}:${key}`;
  let item = limits.get(id);
  if (!item || now - item.start > windowMs) item = { start: now, count: 0 };
  item.count++;
  limits.set(id, item);
  return item.count <= max;
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}
function roomFor(key) {
  if (!/^[a-z0-9-]{1,80}$/.test(key)) return null;
  if (!rooms.has(key)) rooms.set(key, { users: new Map(), messages: [], seq: 0 });
  return rooms.get(key);
}
function pruneRoom(room) {
  const now = Date.now();
  for (const [id, user] of room.users) if (now - user.lastSeen > PRESENCE_TTL) room.users.delete(id);
  if (room.messages.length > 100) room.messages.splice(0, room.messages.length - 100);
}
function roomSnapshot(room, since = 0) {
  pruneRoom(room);
  return {
    participants: [...room.users.values()].map(({ id, name }) => ({ id, name })),
    messages: room.messages.filter(m => m.seq > since),
    cursor: room.seq
  };
}
function adminAuthorized(req, bodyValue) {
  const secret = process.env.NEXORA_ADMIN_TOKEN;
  const auth = req.headers.authorization || '';
  return !!secret && auth === `Bearer ${secret}`;
}
function outputText(result) {
  if (typeof result.output_text === 'string' && result.output_text.trim()) return result.output_text.trim();
  for (const item of result.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) if (part.type === 'output_text' && part.text) return part.text.trim();
  }
  return '';
}
function citations(result) {
  const found = new Map();
  for (const item of result.output || []) for (const part of item.content || []) {
    for (const a of part.annotations || []) {
      const url = a.url || a.url_citation?.url;
      const title = a.title || a.url_citation?.title || url;
      if (url && /^https:\/\//i.test(url)) found.set(url, { title: clean(title, 180), url });
    }
  }
  return [...found.values()].slice(0, 8);
}
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, buildId: BUILD_ID, aiConfigured: !!process.env.OPENAI_API_KEY, aiModel: process.env.OPENAI_API_KEY ? MODEL : null, rooms: 'live-in-memory', mentors: 'approved-directory' });
  }
  if (req.method === 'POST' && url.pathname === '/api/nexa') {
    if (!rateLimit(req, 'nexa', 12, 60000)) return json(res, 429, { error: 'Too many questions in a short time. Please wait a minute.' });
    if (!process.env.OPENAI_API_KEY) return json(res, 503, { error: 'NEXA AI is not connected yet. Add an OpenAI API key to the server environment and restart Nexora.' });
    const data = await body(req);
    const messages = Array.isArray(data.messages) ? data.messages.slice(-12) : [];
    const input = messages.filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: clean(m.content, 4000) })).filter(m => m.content);
    if (!input.length || input[input.length - 1].role !== 'user') return json(res, 400, { error: 'Ask a question to continue.' });
    try {
      const upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          model: MODEL,
          instructions: 'You are NEXA AI, a careful and encouraging study and opportunity assistant. Explain clearly at the student’s level, show steps for academic questions, ask a brief clarifying question when needed, distinguish verified facts from estimates, cite web sources when web search is used, and never promise admission, scholarships, eligibility, ranks, or outcomes. For time-sensitive questions use web search and cite official sources when available. Do not request sensitive personal information unless essential. Keep answers useful and direct.',
          tools: [{ type: 'web_search' }],
          input,
          max_output_tokens: 900,
          store: false
        })
      });
      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        console.error('NEXA provider error:', upstream.status, result?.error?.code || result?.error?.type || 'unknown');
        const status = upstream.status === 429 ? 429 : 502;
        return json(res, status, { error: upstream.status === 429 ? 'NEXA is busy or the API limit was reached. Please try again shortly.' : 'NEXA could not complete that answer. Check the server AI setup and try again.' });
      }
      const text = outputText(result);
      if (!text) return json(res, 502, { error: 'NEXA returned no answer. Please try again.' });
      return json(res, 200, { text, sources: citations(result), model: MODEL });
    } catch (error) {
      console.error('NEXA request failed:', error.name || 'Error');
      return json(res, 502, { error: 'NEXA could not reach the AI service. Check the server connection and try again.' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/mentors') {
    const approved = readArray('mentors.json').filter(m => m.status === 'approved');
    return json(res, 200, { mentors: approved.map(({ id, name, institution, year, topics, bio, email, availability }) => ({ id, name, institution, year, topics, bio, email, availability })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/mentors/apply') {
    if (!rateLimit(req, 'mentor-apply', 3, 3600000)) return json(res, 429, { error: 'Application limit reached. Try again later.' });
    const d = await body(req);
    const name = clean(d.name, 70), email = clean(d.email, 150).toLowerCase();
    const institution = clean(d.institution, 100), year = clean(d.year, 50);
    const topics = clean(d.topics, 180), bio = clean(d.bio, 320), availability = clean(d.availability, 120);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !institution || !year || !topics || !availability || d.publicContact !== true) {
      return json(res, 400, { error: 'Complete the fields and consent to a public contact email. Your application will be reviewed before your profile appears.' });
    }
    const applications = readArray('mentor-applications.json');
    const recent = applications.filter(a => a.email === email && Date.now() - a.createdAt < 86400000);
    if (recent.length) return json(res, 409, { error: 'An application from this email is already awaiting review.' });
    const application = { id: crypto.randomUUID(), name, email, institution, year, topics, bio, availability, publicContact: true, status: 'pending', createdAt: Date.now() };
    applications.push(application);
    writeArray('mentor-applications.json', applications);
    return json(res, 201, { ok: true, message: 'Application received. It will stay private until a project admin verifies and approves it.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/mentorship/request') {
    if (!rateLimit(req, 'mentor-request', 8, 3600000)) return json(res, 429, { error: 'Request limit reached. Try again later.' });
    const d = await body(req);
    const mentors = readArray('mentors.json').filter(m => m.status === 'approved');
    const mentor = mentors.find(m => m.id === clean(d.mentorId, 80));
    if (!mentor) return json(res, 404, { error: 'That approved mentor could not be found. Refresh the directory and try again.' });
    const name = clean(d.name, 70), email = clean(d.email, 150).toLowerCase(), message = clean(d.message, 600);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || message.length < 10) return json(res, 400, { error: 'Add your name, a valid email, and a short message.' });
    const requests = readArray('mentor-requests.json');
    const item = { id: crypto.randomUUID(), mentorId: mentor.id, mentorName: mentor.name, name, email, message, status: 'pending', createdAt: Date.now() };
    requests.push(item); writeArray('mentor-requests.json', requests);
    return json(res, 201, { ok: true, message: 'Request saved. The mentor is contacted through the email shown on their approved profile; your request is also available to the project operator.' });
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'join') {
    if (!rateLimit(req, 'room-join', 30, 60000)) return json(res, 429, { error: 'Please wait before joining more rooms.' });
    const key = parts[2], room = roomFor(key); if (!room) return json(res, 400, { error: 'Invalid room.' });
    const d = await body(req), id = clean(d.id, 80), name = clean(d.name, 32);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) || !name) return json(res, 400, { error: 'Choose a display name to join.' });
    pruneRoom(room);
    if (!room.users.has(id) && room.users.size >= 40) return json(res, 409, { error: 'This room is full. Try another room.' });
    room.users.set(id, { id, name, lastSeen: Date.now() });
    return json(res, 200, roomSnapshot(room));
  }
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 3) {
    const room = roomFor(parts[2]); if (!room) return json(res, 400, { error: 'Invalid room.' });
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    return json(res, 200, roomSnapshot(room, since));
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'heartbeat') {
    const room = roomFor(parts[2]); if (!room) return json(res, 400, { error: 'Invalid room.' });
    const d = await body(req), id = clean(d.id, 80), user = room.users.get(id);
    if (user) user.lastSeen = Date.now();
    return json(res, 200, { ok: !!user });
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'chat') {
    if (!rateLimit(req, 'room-chat', 10, 60000)) return json(res, 429, { error: 'Chat is moving quickly. Please wait a moment.' });
    const room = roomFor(parts[2]); if (!room) return json(res, 400, { error: 'Invalid room.' });
    const d = await body(req), id = clean(d.id, 80), user = room.users.get(id), text = clean(d.text, 240);
    if (!user || Date.now() - user.lastSeen > PRESENCE_TTL) return json(res, 401, { error: 'Rejoin the room before sending a message.' });
    if (!text) return json(res, 400, { error: 'Write a short study message first.' });
    const message = { seq: ++room.seq, id: crypto.randomUUID(), name: user.name, text, at: Date.now() };
    room.messages.push(message); pruneRoom(room);
    return json(res, 201, { message });
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'leave') {
    const room = roomFor(parts[2]); if (!room) return json(res, 400, { error: 'Invalid room.' });
    const d = await body(req); room.users.delete(clean(d.id, 80));
    return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith('/api/admin/')) {
    if (!adminAuthorized(req)) return json(res, 401, { error: 'Admin token required.' });
    if (req.method === 'GET' && url.pathname === '/api/admin/mentor-applications') return json(res, 200, { applications: readArray('mentor-applications.json').filter(a => a.status === 'pending') });
    if (req.method === 'GET' && url.pathname === '/api/admin/mentor-requests') return json(res, 200, { requests: readArray('mentor-requests.json').filter(a => a.status === 'pending') });
    if (req.method === 'POST' && url.pathname === '/api/admin/mentors/approve') {
      const d = await body(req), applications = readArray('mentor-applications.json'), ix = applications.findIndex(a => a.id === clean(d.applicationId, 80) && a.status === 'pending');
      if (ix < 0) return json(res, 404, { error: 'Pending mentor application not found.' });
      const a = applications[ix];
      const mentor = { id: crypto.randomUUID(), name: a.name, email: a.email, institution: a.institution, year: a.year, topics: a.topics, bio: a.bio, availability: a.availability, status: 'approved', approvedAt: Date.now() };
      const mentors = readArray('mentors.json'); mentors.push(mentor); writeArray('mentors.json', mentors);
      applications[ix] = { ...a, status: 'approved', reviewedAt: Date.now() }; writeArray('mentor-applications.json', applications);
      return json(res, 201, { ok: true, mentor: { id: mentor.id, name: mentor.name } });
    }
    return json(res, 404, { error: 'Admin endpoint not found.' });
  }
  return json(res, 404, { error: 'API route not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    const accepted = new Set(['/', '/index.html', '/NEXORA%20-%20AI%20PROTOTYPE%20FINAL.html', '/Nexora-AI-Prototype.html']);
    const staticAssets = new Map([
      ['/nexora-ai-assets/Nexora-Daily-Habit-Tracker.xlsx', { file: path.join(ROOT, 'nexora-ai-assets', 'Nexora-Daily-Habit-Tracker.xlsx'), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
      ['/nexora-ai-assets/Nexora-AI-5-Slide-Deck.pptx', { file: path.join(ROOT, 'nexora-ai-assets', 'Nexora-AI-5-Slide-Deck.pptx'), type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }]
    ]);
    const asset = staticAssets.get(url.pathname);
    if (asset) {
      if (!fs.existsSync(asset.file)) { res.writeHead(404); return res.end('Asset not found'); }
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(asset.file).pipe(res);
    }
    if (!accepted.has(url.pathname)) { res.writeHead(404); return res.end('Not found'); }
    if (!fs.existsSync(HTML)) { res.writeHead(500); return res.end('Nexora HTML file is missing.'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(HTML).pipe(res);
  } catch (error) {
    console.error('Request error:', error.name || 'Error');
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Server error. Please retry.' });
    else res.destroy();
  }
});
server.listen(PORT, HOST, () => {
  const accessHost = HOST === '0.0.0.0' ? '<server-ip>' : HOST;
  console.log(`Nexora is available at http://${accessHost}:${PORT}/`);
  console.log(`NEXA AI: ${process.env.OPENAI_API_KEY ? `connected (${MODEL})` : 'not configured; add OPENAI_API_KEY to enable real answers'}`);
  console.log('Live room presence and approved mentor directory are enabled.');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

