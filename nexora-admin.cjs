// Local pilot administration: node nexora-admin.cjs pending | approve <application-id> | requests
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dataDir = path.join(__dirname, 'nexora-data');
function read(file) { try { const v = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } }
function write(file, value) { const p = path.join(dataDir, file), t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(t, p); }
const [cmd, id] = process.argv.slice(2);
if (cmd === 'pending') {
  const rows = read('mentor-applications.json').filter(x => x.status === 'pending');
  if (!rows.length) console.log('No pending mentor applications.');
  else for (const a of rows) console.log(`${a.id}\n  ${a.name} · ${a.year} · ${a.institution}\n  ${a.topics}\n  ${a.email} · applied ${new Date(a.createdAt).toLocaleString()}\n`);
} else if (cmd === 'requests') {
  const rows = read('mentor-requests.json').filter(x => x.status === 'pending');
  if (!rows.length) console.log('No pending mentorship requests.');
  else for (const a of rows) console.log(`${a.id}\n  To: ${a.mentorName}\n  From: ${a.name} <${a.email}>\n  ${a.message}\n`);
} else if (cmd === 'approve' && id) {
  const apps = read('mentor-applications.json'), i = apps.findIndex(a => a.id === id && a.status === 'pending');
  if (i < 0) { console.error('Pending application not found.'); process.exitCode = 1; }
  else {
    const a = apps[i], mentors = read('mentors.json');
    mentors.push({ id: crypto.randomUUID(), name: a.name, email: a.email, institution: a.institution, year: a.year, topics: a.topics, bio: a.bio, availability: a.availability, status: 'approved', approvedAt: Date.now() });
    apps[i] = { ...a, status: 'approved', reviewedAt: Date.now() };
    write('mentors.json', mentors); write('mentor-applications.json', apps);
    console.log(`Approved ${a.name}. They now appear as an opted-in mentor with their public contact email.`);
  }
} else {
  console.log('Usage:\n  node nexora-admin.cjs pending\n  node nexora-admin.cjs approve <application-id>\n  node nexora-admin.cjs requests');
  if (cmd && !['pending', 'requests', 'approve'].includes(cmd)) process.exitCode = 2;
}

