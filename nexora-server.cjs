// Nexora AI local/pilot server. Node 20+; intentionally uses only built-in modules.
// Keep GEMINI_API_KEY on the server. Never put it in the HTML or commit it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA = path.resolve(process.env.NEXORA_DATA_DIR || path.join(ROOT, 'nexora-data'));
const HTML = path.join(ROOT, 'index.html');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const BUILD_ID = 'nexora-cloud-gemini-v3';
const PRESENCE_TTL = 25000;
const MAX_BODY = 64000;
const rooms = new Map();
const limits = new Map();

// Optional .env support for local pilots; .env is ignored by git.
if (process.env.NEXORA_DISABLE_DOTENV !== '1') try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

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
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
}
function clean(value, max = 240) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function rateLimit(req, key, max = 40, windowMs = 60000) {
  // Render routes requests through Cloudflare; CF-Connecting-IP is the client IP.
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown').trim().slice(0, 64);
  const now = Date.now();
  const id = `${ip}:${key}`;
  let item = limits.get(id);
  if (!item || now - item.start > windowMs) item = { start: now, count: 0 };
  item.count++;
  limits.set(id, item);
  return item.count <= max;
}
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, item] of limits) if (now - item.start > 3600000) limits.delete(id);
}, 300000);
rateLimitCleanup.unref();
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
function supabaseConfigured() { return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY); }
function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || '';
}
function userIdFromRequest(req) {
  try {
    const payload = bearerToken(req).split('.')[1];
    if (!payload) return '';
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub || '') ? claims.sub : '';
  } catch { return ''; }
}
async function supabaseRest(req, route, { method = 'GET', value, prefer = '' } = {}) {
  const token = bearerToken(req) || process.env.SUPABASE_ANON_KEY;
  const headers = { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (value !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${route}`, {
      method, headers, ...(value !== undefined ? { body: JSON.stringify(value) } : {})
    });
    const text = await response.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch {} }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    console.error('Nexora data store request failed:', error.name || 'Error');
    return { ok: false, status: 502, data: null };
  }
}
async function supabaseUser(req) {
  const token = bearerToken(req);
  if (!token || !supabaseConfigured()) return null;
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}
function cloudError(res, result, fallback) {
  const code = result?.data?.code;
  const status = code === '23505' ? 409 : result?.status === 401 || result?.status === 403 ? 401 : 502;
  return json(res, status, { error: status === 409 ? 'A matching request is already pending.' : status === 401 ? 'Sign in to use this feature, and check that your account session is current.' : fallback });
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
function geminiAnswer(result) {
  return (result.candidates?.[0]?.content?.parts || [])
    .filter(part => typeof part.text === 'string')
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n\n');
}
const queryValue = value => encodeURIComponent(String(value));
async function cloudRoomSnapshot(req, roomKey, since = 0) {
  const cutoff = new Date(Date.now() - PRESENCE_TTL).toISOString();
  const participantsResult = await supabaseRest(req,
    `nexora_room_presence?room_key=eq.${queryValue(roomKey)}&last_seen=gt.${queryValue(cutoff)}&select=client_id,display_name&order=last_seen.desc&limit=41`);
  const messageQuery = since > 0
    ? `nexora_room_messages?room_key=eq.${queryValue(roomKey)}&seq=gt.${queryValue(since)}&select=seq,client_id,display_name,text,created_at&order=seq.asc&limit=100`
    : `nexora_room_messages?room_key=eq.${queryValue(roomKey)}&select=seq,client_id,display_name,text,created_at&order=seq.desc&limit=100`;
  const messagesResult = await supabaseRest(req, messageQuery);
  if (!participantsResult.ok) return { error: participantsResult };
  if (!messagesResult.ok) return { error: messagesResult };
  const rows = Array.isArray(messagesResult.data) ? messagesResult.data : [];
  const ordered = since > 0 ? rows : rows.reverse();
  const messages = ordered.map(m => ({ seq: Number(m.seq), id: String(m.seq), name: m.display_name, text: m.text, at: Date.parse(m.created_at) || Date.now() }));
  return {
    participants: (Array.isArray(participantsResult.data) ? participantsResult.data : []).map(p => ({ id: p.client_id, name: p.display_name })),
    messages,
    cursor: messages.length ? messages[messages.length - 1].seq : since
  };
}
async function handleCloudRoom(req, res, url, parts) {
  const roomKey = parts[2] || '';
  if (!/^[a-z0-9-]{1,80}$/.test(roomKey)) return json(res, 400, { error: 'Invalid room.' });
  const userId = userIdFromRequest(req);
  if (!userId) return json(res, 401, { error: 'Sign in to join a shared study room.' });
  const clientId = value => clean(value, 80);
  const memberPath = `nexora_room_members?room_key=eq.${queryValue(roomKey)}`;
  if (req.method === 'POST' && parts[3] === 'join') {
    if (!rateLimit(req, 'room-join', 30, 60000)) return json(res, 429, { error: 'Please wait before joining more rooms.' });
    const d = await body(req), id = clientId(d.id), name = clean(d.name, 32);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) || !name) return json(res, 400, { error: 'Choose a display name to join.' });
    const encoded = `room_key=eq.${queryValue(roomKey)}&client_id=eq.${queryValue(id)}`;
    const member = await supabaseRest(req, `${memberPath}&on_conflict=room_key,client_id`, {
      method: 'POST', value: { room_key: roomKey, client_id: id, user_id: userId, display_name: name }, prefer: 'resolution=merge-duplicates,return=minimal'
    });
    if (!member.ok) return cloudError(res, member, 'Could not join the study room. Please try again.');
    const presence = await supabaseRest(req, `nexora_room_presence?on_conflict=room_key,client_id`, {
      method: 'POST', value: { room_key: roomKey, client_id: id, user_id: userId, display_name: name, last_seen: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal'
    });
    if (!presence.ok) {
      await supabaseRest(req, `${memberPath}&client_id=eq.${queryValue(id)}&user_id=eq.${queryValue(userId)}`, { method: 'DELETE' });
      return cloudError(res, presence, 'Could not join the study room. Please try again.');
    }
    const participants = await supabaseRest(req, `nexora_room_presence?room_key=eq.${queryValue(roomKey)}&last_seen=gt.${queryValue(new Date(Date.now() - PRESENCE_TTL).toISOString())}&select=client_id&limit=41`);
    if (!participants.ok) return cloudError(res, participants, 'Could not load room participants. Please try again.');
    if ((participants.data || []).length > 40) {
      await supabaseRest(req, `${memberPath}&client_id=eq.${queryValue(id)}&user_id=eq.${queryValue(userId)}`, { method: 'DELETE' });
      return json(res, 409, { error: 'This room is full. Try another room.' });
    }
    const active = (Array.isArray(participants.data) ? participants.data : []).map(p => ({ id: p.client_id, name: p.display_name }));
    return json(res, 200, { participants: active, messages: [], cursor: 0 });
  }
  if (req.method === 'GET' && parts.length === 3) {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    // A visit also removes expired chat from that room; cleanup is enforced by RLS.
    const expired = new Date(Date.now() - 7 * 86400000).toISOString();
    const cleanup = await supabaseRest(req, `nexora_room_messages?room_key=eq.${queryValue(roomKey)}&created_at=lt.${queryValue(expired)}`, { method: 'DELETE' });
    if (!cleanup.ok) return cloudError(res, cleanup, 'Could not refresh the study room. Please try again.');
    const snapshot = await cloudRoomSnapshot(req, roomKey, since);
    if (snapshot.error) return cloudError(res, snapshot.error, 'Could not load the room. Please try again.');
    return json(res, 200, snapshot);
  }
  if (req.method === 'POST' && parts[3] === 'heartbeat') {
    const d = await body(req), id = clientId(d.id);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return json(res, 400, { error: 'Invalid room participant.' });
    const result = await supabaseRest(req,
      `nexora_room_presence?room_key=eq.${queryValue(roomKey)}&client_id=eq.${queryValue(id)}&user_id=eq.${queryValue(userId)}`,
      { method: 'PATCH', value: { last_seen: new Date().toISOString() }, prefer: 'return=representation' });
    if (!result.ok) return cloudError(res, result, 'Could not refresh your room connection. Please rejoin.');
    return json(res, 200, { ok: Array.isArray(result.data) && result.data.length > 0 });
  }
  if (req.method === 'POST' && parts[3] === 'chat') {
    if (!rateLimit(req, `room-chat:${roomKey}`, 10, 60000)) return json(res, 429, { error: 'Chat is moving quickly. Please wait a moment.' });
    const d = await body(req), id = clientId(d.id), text = clean(d.text, 240);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return json(res, 401, { error: 'Rejoin the room before sending a message.' });
    if (!text) return json(res, 400, { error: 'Write a short study message first.' });
    const member = await supabaseRest(req, `nexora_room_presence?room_key=eq.${queryValue(roomKey)}&client_id=eq.${queryValue(id)}&user_id=eq.${queryValue(userId)}&last_seen=gt.${queryValue(new Date(Date.now() - PRESENCE_TTL).toISOString())}&select=display_name&limit=1`);
    if (!member.ok) return cloudError(res, member, 'Could not verify your room connection. Please rejoin.');
    const name = member.data?.[0]?.display_name;
    if (!name) return json(res, 401, { error: 'Rejoin the room before sending a message.' });
    const result = await supabaseRest(req, 'nexora_room_messages', {
      method: 'POST', value: { room_key: roomKey, client_id: id, user_id: userId, display_name: name, text }, prefer: 'return=representation'
    });
    if (!result.ok) return cloudError(res, result, 'Could not send that message. Please try again.');
    const row = result.data?.[0];
    return json(res, 201, { message: row ? { seq: Number(row.seq), id: String(row.seq), name: row.display_name, text: row.text, at: Date.parse(row.created_at) || Date.now() } : null });
  }
  if (req.method === 'POST' && parts[3] === 'leave') {
    const d = await body(req), id = clientId(d.id);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return json(res, 400, { error: 'Invalid room participant.' });
    const result = await supabaseRest(req, `${memberPath}&client_id=eq.${queryValue(id)}&user_id=eq.${queryValue(userId)}`, { method: 'DELETE' });
    if (!result.ok) return cloudError(res, result, 'Could not leave the study room.');
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Room endpoint not found.' });
}
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'POST' && url.pathname === '/api/account/delete') {
    if (!supabaseConfigured()) return json(res, 503, { error: 'Account deletion is not configured.' });
    if (!rateLimit(req, 'account-delete', 3, 3600000)) return json(res, 429, { error: 'Please wait before retrying account deletion.' });
    const d = await body(req);
    const user = await supabaseUser(req);
    if (!user?.id || !user?.email) return json(res, 401, { error: 'Sign in again to delete this account.' });
    if (clean(d.confirmEmail, 254).toLowerCase() !== clean(user.email, 254).toLowerCase()) {
      return json(res, 400, { error: 'The confirmation email does not match the signed-in account.' });
    }
    try {
      const response = await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/delete-account', {
        method: 'POST',
        headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + bearerToken(req), 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(20000)
      });
      if (response.ok) return json(res, 200, { ok: true });
      if (response.status === 401 || response.status === 403) return json(res, 401, { error: 'Your session expired. Sign in again and retry.' });
      console.error('Nexora account deletion function returned:', response.status);
      return json(res, 502, { error: 'Account deletion could not be completed. Please retry.' });
    } catch (error) {
      console.error('Nexora account deletion request failed:', error.name || 'Error');
      return json(res, 502, { error: 'Account deletion could not be completed. Please retry.' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, buildId: BUILD_ID, aiConfigured: !!process.env.GEMINI_API_KEY, aiProvider: process.env.GEMINI_API_KEY ? 'Gemini' : null, aiModel: process.env.GEMINI_API_KEY ? MODEL : null, accountsConfigured: supabaseConfigured(), rooms: supabaseConfigured() ? 'supabase-rls-persisted' : 'live-in-memory', mentors: supabaseConfigured() ? 'supabase-rls-directory' : 'approved-directory' });
  }
  if (req.method === 'POST' && url.pathname === '/api/nexa') {
    if (!rateLimit(req, 'nexa', 12, 60000)) return json(res, 429, { error: 'Too many questions in a short time. Please wait a minute.' });
    if (!process.env.GEMINI_API_KEY) return json(res, 503, { error: 'NEXA AI is not connected yet. Add a Google AI Studio Gemini API key as GEMINI_API_KEY in Render to enable free-tier AI.' });
    const data = await body(req);
    const messages = Array.isArray(data.messages) ? data.messages.slice(-12) : [];
    const input = messages.filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: clean(m.content, 4000) })).filter(m => m.content);
    if (!input.length || input[input.length - 1].role !== 'user') return json(res, 400, { error: 'Ask a question to continue.' });
    try {
      const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are NEXA AI, a careful and encouraging study and opportunity assistant. Explain clearly at the student’s level, show steps for academic questions, ask a brief clarifying question when needed, distinguish verified facts from estimates, and never promise admission, scholarships, eligibility, ranks, or outcomes. Do not request sensitive personal information unless essential. Keep answers useful and direct. Your knowledge may be out of date; direct students to verify time-sensitive information with official sources.' }] },
          contents: input.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 900, temperature: 0.6 }
        })
      });
      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        console.error('NEXA provider error:', upstream.status, result?.error?.status || 'unknown');
        const status = upstream.status === 429 ? 429 : 502;
        return json(res, status, { error: upstream.status === 429 ? 'NEXA is busy or the API limit was reached. Please try again shortly.' : 'NEXA could not complete that answer. Check the server AI setup and try again.' });
      }
      const text = geminiAnswer(result);
      if (!text) return json(res, 502, { error: 'NEXA returned no answer. Please try again.' });
      return json(res, 200, { text, sources: [], model: MODEL, provider: 'Gemini' });
    } catch (error) {
      console.error('NEXA request failed:', error.name || 'Error');
      return json(res, 502, { error: 'NEXA could not reach the AI service. Check the server connection and try again.' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/mentors') {
    if (supabaseConfigured()) {
      const result = await supabaseRest(req, 'nexora_mentors?status=eq.approved&select=id,name,institution,year,topics,bio,email,availability&order=name.asc');
      if (!result.ok) return cloudError(res, result, 'The mentor directory is temporarily unavailable. Please try again.');
      const mentors = Array.isArray(result.data) ? result.data : [];
      return json(res, 200, { mentors });
    }
    const approved = readArray('mentors.json').filter(m => m.status === 'approved');
    return json(res, 200, { mentors: approved.map(({ id, name, institution, year, topics, bio, email, availability }) => ({ id, name, institution, year, topics, bio, email, availability })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/mentors/apply') {
    if (!rateLimit(req, 'mentor-apply', 3, 3600000)) return json(res, 429, { error: 'Application limit reached. Try again later.' });
    const d = await body(req);
    const userId = supabaseConfigured() ? userIdFromRequest(req) : '';
    if (supabaseConfigured() && !userId) return json(res, 401, { error: 'Sign in with a verified account before applying to mentor.' });
    const name = clean(d.name, 70), email = clean(d.email, 150).toLowerCase();
    const institution = clean(d.institution, 100), year = clean(d.year, 50);
    const topics = clean(d.topics, 180), bio = clean(d.bio, 320), availability = clean(d.availability, 120);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !institution || !year || !topics || !availability || d.publicContact !== true) {
      return json(res, 400, { error: 'Complete the fields and consent to a public contact email. Your application will be reviewed before your profile appears.' });
    }
    if (supabaseConfigured()) {
      const result = await supabaseRest(req, 'nexora_mentor_applications', {
        method: 'POST', value: { user_id: userId, name, email, institution, year, topics, bio, availability, status: 'pending' }, prefer: 'return=minimal'
      });
      if (!result.ok) return cloudError(res, result, 'Your application could not be saved. Please try again.');
      return json(res, 201, { ok: true, message: 'Application saved securely for review. Your email will be public only if the application is approved.' });
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
    const userId = supabaseConfigured() ? userIdFromRequest(req) : '';
    if (supabaseConfigured() && !userId) return json(res, 401, { error: 'Sign in with a verified account before contacting a mentor.' });
    if (supabaseConfigured()) {
      const mentorId = clean(d.mentorId, 80);
      const name = clean(d.name, 70), email = clean(d.email, 150).toLowerCase(), message = clean(d.message, 600);
      if (!/^[0-9a-f-]{36}$/i.test(mentorId) || !name || !/^\S+@\S+\.\S+$/.test(email) || message.length < 10) return json(res, 400, { error: 'Add your name, a valid email, and a short message.' });
      const mentor = await supabaseRest(req, `nexora_mentors?id=eq.${queryValue(mentorId)}&status=eq.approved&select=id,name&limit=1`);
      if (!mentor.ok) return cloudError(res, mentor, 'The mentor directory is temporarily unavailable. Please try again.');
      if (!mentor.data?.length) return json(res, 404, { error: 'That approved mentor could not be found. Refresh the directory and try again.' });
      const result = await supabaseRest(req, 'nexora_mentor_requests', {
        method: 'POST', value: { user_id: userId, mentor_id: mentorId, mentor_name: mentor.data[0].name, name, email, message }, prefer: 'return=minimal'
      });
      if (!result.ok) return cloudError(res, result, 'Your mentor request could not be saved. Please try again.');
      return json(res, 201, { ok: true, message: 'Request saved. Use the mentor’s public email in their profile to contact them; Nexora does not send email on your behalf.' });
    }
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
  if (supabaseConfigured() && parts[0] === 'api' && parts[1] === 'rooms') return await handleCloudRoom(req, res, url, parts);
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
    if (supabaseConfigured()) {
      const user = await supabaseUser(req);
      if (user?.app_metadata?.nexora_admin !== true) return json(res, 403, { error: 'This action requires a Nexora administrator account.' });
      if (req.method === 'GET' && url.pathname === '/api/admin/mentor-applications') {
        const result = await supabaseRest(req, 'nexora_mentor_applications?status=eq.pending&select=id,name,email,institution,year,topics,bio,availability,status,created_at&order=created_at.asc');
        if (!result.ok) return cloudError(res, result, 'Could not load mentor applications. Please try again.');
        return json(res, 200, { applications: Array.isArray(result.data) ? result.data : [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/mentor-requests') {
        const result = await supabaseRest(req, 'nexora_mentor_requests?status=eq.pending&select=id,mentor_id,mentor_name,name,email,message,status,created_at&order=created_at.asc');
        if (!result.ok) return cloudError(res, result, 'Could not load mentor requests. Please try again.');
        return json(res, 200, { requests: Array.isArray(result.data) ? result.data : [] });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mentors/approve') {
        const d = await body(req), id = clean(d.applicationId, 80);
        if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'Invalid mentor application.' });
        const lookup = await supabaseRest(req, `nexora_mentor_applications?id=eq.${queryValue(id)}&status=eq.pending&select=id,name,email,institution,year,topics,bio,availability&limit=1`);
        if (!lookup.ok) return cloudError(res, lookup, 'Could not load that mentor application.');
        const app = lookup.data?.[0];
        if (!app) return json(res, 404, { error: 'Pending mentor application not found.' });
        const inserted = await supabaseRest(req, 'nexora_mentors', {
          method: 'POST', value: { application_id: app.id, name: app.name, email: app.email, institution: app.institution, year: app.year, topics: app.topics, bio: app.bio, availability: app.availability, status: 'approved' }, prefer: 'return=representation'
        });
        if (!inserted.ok) return cloudError(res, inserted, 'Could not approve this mentor. Please try again.');
        const mentor = inserted.data?.[0];
        const updated = await supabaseRest(req, `nexora_mentor_applications?id=eq.${queryValue(id)}&status=eq.pending`, {
          method: 'PATCH', value: { status: 'approved' }, prefer: 'return=representation'
        });
        if (!updated.ok || !updated.data?.length) {
          if (mentor?.id) await supabaseRest(req, `nexora_mentors?id=eq.${queryValue(mentor.id)}`, { method: 'DELETE' });
          return updated.ok ? json(res, 409, { error: 'That application has already been reviewed.' }) : cloudError(res, updated, 'Could not finish approving this mentor.');
        }
        return json(res, 201, { ok: true, mentor: { id: mentor?.id, name: app.name } });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mentors/reject') {
        const d = await body(req), id = clean(d.applicationId, 80);
        if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'Invalid mentor application.' });
        const result = await supabaseRest(req, `nexora_mentor_applications?id=eq.${queryValue(id)}&status=eq.pending`, { method: 'PATCH', value: { status: 'rejected' }, prefer: 'return=representation' });
        if (!result.ok) return cloudError(res, result, 'Could not update that application.');
        return result.data?.length ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Pending mentor application not found.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mentor-requests/update') {
        const d = await body(req), id = clean(d.requestId, 80), status = clean(d.status, 20);
        if (!/^[0-9a-f-]{36}$/i.test(id) || !['contacted', 'closed'].includes(status)) return json(res, 400, { error: 'Choose a valid request and status.' });
        const result = await supabaseRest(req, `nexora_mentor_requests?id=eq.${queryValue(id)}&status=eq.pending`, { method: 'PATCH', value: { status }, prefer: 'return=representation' });
        if (!result.ok) return cloudError(res, result, 'Could not update that request.');
        return result.data?.length ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Pending mentor request not found.' });
      }
      return json(res, 404, { error: 'Admin endpoint not found.' });
    }
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
      ['/nexora-account.js', { file: path.join(ROOT, 'nexora-account.js'), type: 'text/javascript; charset=utf-8' }],
      ['/nexora-account.css', { file: path.join(ROOT, 'nexora-account.css'), type: 'text/css; charset=utf-8' }],
      ['/privacy.html', { file: path.join(ROOT, 'privacy.html'), type: 'text/html; charset=utf-8' }],
      ['/terms.html', { file: path.join(ROOT, 'terms.html'), type: 'text/html; charset=utf-8' }],
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
    const publicConfig = JSON.stringify({ supabaseUrl: process.env.SUPABASE_URL || '', anonKey: process.env.SUPABASE_ANON_KEY || '' }).replace(/</g, '\\u003c');
    const document = fs.readFileSync(HTML, 'utf8').replace('</body>', `<script>window.NEXORA_CONFIG=${publicConfig}</script><script defer src="/nexora-account.js"></script></body>`);
    res.end(document);
  } catch (error) {
    console.error('Request error:', error.name || 'Error');
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Server error. Please retry.' });
    else res.destroy();
  }
});
server.listen(PORT, HOST, () => {
  const accessHost = HOST === '0.0.0.0' ? '<server-ip>' : HOST;
  console.log(`Nexora is available at http://${accessHost}:${PORT}/`);
  console.log(`NEXA AI: ${process.env.GEMINI_API_KEY ? `connected (${MODEL})` : 'not configured; add GEMINI_API_KEY to enable free-tier answers'}`);
  console.log('Live room presence and approved mentor directory are enabled.');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

