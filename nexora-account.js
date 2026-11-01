/* Optional Supabase account and cross-device sync layer for Nexora. */
(() => {
  const cfg = window.NEXORA_CONFIG || {};
  const base = String(cfg.supabaseUrl || '').replace(/\/$/, '');
  const anon = cfg.anonKey || '';
  const hasCloud = /^https:\/\//i.test(base) && !!anon;
  const SESSION_KEY = 'nexora.account.session';
  let session = null;
  let applying = false;
  let syncTimer = 0;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const readSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };
  const writeSession = value => { session = value; try { if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); else sessionStorage.removeItem(SESSION_KEY); } catch {} updateAccountButton(); };
  session = readSession();

  function addStyles() {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/nexora-account.css'; document.head.appendChild(link);
  }

  function addAccountUi() {
    const top = document.querySelector('.top-actions');
    if (!top) return;
    const button = document.createElement('button');
    button.id = 'nexoraAccountButton'; button.className = 'btn small account-button'; button.type = 'button'; button.onclick = openAccount;
    top.insertBefore(button, document.querySelector('#quickTask'));
    const overlay = document.createElement('div');
    overlay.id = 'nexoraAccountOverlay'; overlay.className = 'nexora-account-overlay hidden';
    overlay.innerHTML = `<section class="nexora-account-card" role="dialog" aria-modal="true" aria-labelledby="nexoraAccountTitle"><button id="nexoraAccountClose" class="nexora-account-close" type="button" aria-label="Close">×</button><div class="nexora-account-mark">N</div><div class="nexora-account-kicker">YOUR NEXORA ACCOUNT</div><h2 id="nexoraAccountTitle">Save your workspace</h2><p id="nexoraAccountIntro">Create an account to sync your plans and progress across devices.</p><div class="nexora-account-tabs"><button type="button" data-account-mode="signup">Create account</button><button type="button" data-account-mode="login">Sign in</button></div><form id="nexoraAccountForm"><label>Email<input type="email" name="email" autocomplete="email" required maxlength="254"></label><label id="nexoraPasswordLabel">Password<input type="password" name="password" autocomplete="new-password" minlength="8" required maxlength="128"></label><button id="nexoraAccountSubmit" class="btn" type="submit">Create account</button><button id="nexoraForgot" class="nexora-link-button" type="button">Forgot password?</button></form><div id="nexoraAccountNotice" role="status" aria-live="polite"></div><div id="nexoraAccountFooter" class="nexora-account-foot"></div></section>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeAccount(); });
    document.body.appendChild(overlay);
    document.querySelector('#nexoraAccountClose').onclick = closeAccount;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAccount(); });
    overlay.querySelectorAll('[data-account-mode]').forEach(tab => tab.onclick = () => setMode(tab.dataset.accountMode));
    document.querySelector('#nexoraAccountForm').onsubmit = submitAccount;
    document.querySelector('#nexoraForgot').onclick = () => setMode('reset');
    updateAccountButton();
    setMode('signup');
  }

  function updateAccountButton() {
    const button = document.querySelector('#nexoraAccountButton');
    if (!button) return;
    if (session?.access_token && session?.user?.email) {
      button.textContent = `☁ ${session.user.email}`; button.title = 'Account and cloud sync'; button.classList.add('account-connected');
    } else {
      button.textContent = hasCloud ? '☁ Sign in' : '☁ Accounts setup needed'; button.title = hasCloud ? 'Sign in or create an account' : 'Cloud accounts need the site owner to connect storage'; button.classList.remove('account-connected');
    }
  }

  function openAccount() {
    const overlay = document.querySelector('#nexoraAccountOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    if (!hasCloud) {
      setNotice('Cloud accounts are not connected yet. The site owner must configure Supabase and run the included database setup.', 'error');
    } else if (session?.access_token) {
      setMode('account');
      setNotice('Signed in. Your Nexora workspace syncs to your account when you make changes.', 'success');
    } else setMode('signup');
  }

  function closeAccount() { document.querySelector('#nexoraAccountOverlay')?.classList.add('hidden'); }

  function setMode(mode) {
    const form = document.querySelector('#nexoraAccountForm');
    if (!form) return;
    form.dataset.mode = mode;
    const loggedIn = mode === 'account' && !!session?.user?.email;
    form.classList.toggle('hidden', loggedIn);
    document.querySelector('#nexoraAccountTitle').textContent = loggedIn ? 'Your account' : mode === 'login' ? 'Welcome back' : mode === 'reset' ? 'Reset your password' : mode === 'newpassword' ? 'Choose a new password' : 'Save your workspace';
    document.querySelector('#nexoraAccountIntro').textContent = loggedIn ? `Signed in as ${session.user.email}.` : mode === 'login' ? 'Sign in to restore and sync your Nexora workspace.' : mode === 'reset' ? 'We will send a password reset link to your email.' : mode === 'newpassword' ? 'Set a new password to finish recovering your account.' : 'Create an account to sync your plans and progress across devices.';
    document.querySelector('#nexoraAccountSubmit').textContent = mode === 'login' ? 'Sign in' : mode === 'reset' ? 'Send reset link' : mode === 'newpassword' ? 'Save new password' : 'Create account';
    document.querySelector('#nexoraPasswordLabel').classList.toggle('hidden', mode === 'reset');
    form.elements.password.required = mode !== 'reset' && !loggedIn;
    form.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    form.elements.password.placeholder = mode === 'newpassword' ? 'New password (at least 8 characters)' : '';
    document.querySelector('#nexoraForgot').classList.toggle('hidden', mode !== 'login');
    document.querySelector('.nexora-account-tabs').classList.toggle('hidden', loggedIn || mode === 'reset' || mode === 'newpassword');
    document.querySelectorAll('[data-account-mode]').forEach(tab => tab.classList.toggle('active', tab.dataset.accountMode === mode));
    const footer = document.querySelector('#nexoraAccountFooter');
    footer.innerHTML = loggedIn ? `<button id="nexoraSignOut" class="btn ghost" type="button">Sign out</button>` : hasCloud ? 'Your password is handled by the secure account service. Nexora never sees or stores it.' : 'Account service is waiting for setup.';
    if (loggedIn) document.querySelector('#nexoraSignOut').onclick = signOut;
    setNotice('');
  }

  function setNotice(text, kind = '') {
    const node = document.querySelector('#nexoraAccountNotice');
    if (node) { node.textContent = text; node.dataset.kind = kind; }
  }

  async function authRequest(path, payload, token) {
    const response = await fetch(`${base}/auth/v1/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anon, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload || {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.msg || result.message || result.error_description || result.error || 'Account service could not complete the request.');
    return result;
  }

  async function submitAccount(event) {
    event.preventDefault();
    if (!hasCloud) { setNotice('Accounts are not configured yet.'); return; }
    const form = event.currentTarget;
    const email = form.elements.email.value.trim().toLowerCase();
    const password = form.elements.password.value;
    const mode = form.dataset.mode || 'signup';
    const button = document.querySelector('#nexoraAccountSubmit'); button.disabled = true;
    setNotice(mode === 'login' ? 'Signing in…' : mode === 'reset' ? 'Sending reset link…' : 'Creating your account…');
    try {
      if (mode === 'reset') {
        await authRequest(`recover?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { email });
        setNotice('If this email has an account, a password reset link is on the way.', 'success');
        return;
      }
      if (mode === 'newpassword') {
        const response = await fetch(`${base}/auth/v1/user`, { method: 'PUT', headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${session?.access_token || ''}` }, body: JSON.stringify({ password }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.msg || result.message || 'Could not update the password. Request a new reset link and try again.');
        writeSession({ ...session, user: result });
        await restoreCloud();
        setMode('account'); setNotice('Password updated. You are signed in.', 'success');
        return;
      }
      const authPath = mode === 'login' ? 'token?grant_type=password' : `signup?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`;
      const result = await authRequest(authPath, { email, password });
      if (!result.access_token) {
        setNotice('Check your email for the verification link, then return here and sign in.', 'success');
        return;
      }
      writeSession(result);
      await restoreCloud();
      setMode('account');
      setNotice('Signed in. Your Nexora data is synced to your account.', 'success');
      if (window.say) window.say('Nexora account connected.');
    } catch (error) { setNotice(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function sendReset() {
    const email = document.querySelector('#nexoraAccountForm').elements.email.value.trim().toLowerCase();
    if (!email) { setNotice('Enter your email address first.', 'error'); return; }
    try {
      await authRequest(`recover?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { email });
      setNotice('If this email has an account, a password reset link is on the way.', 'success');
    } catch (error) { setNotice(error.message, 'error'); }
  }

  async function signOut() {
    try { if (session?.access_token && hasCloud) await authRequest('logout', {}, session.access_token); } catch {}
    writeSession(null); setMode('signup'); setNotice('Signed out. Your local copy stays on this device.', 'success');
  }

  async function refreshSession() {
    if (!session?.refresh_token) throw new Error('Your sign-in expired. Please sign in again.');
    const updated = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    writeSession(updated); return updated.access_token;
  }

  async function finishPasswordRecovery() {
    if (!hasCloud) return false;
    const values = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (values.get('type') !== 'recovery' || !values.get('access_token')) return false;
    const recovery = { access_token: values.get('access_token'), refresh_token: values.get('refresh_token') || '' };
    const response = await fetch(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${recovery.access_token}` } });
    const user = await response.json().catch(() => ({}));
    if (!response.ok || !user.id) throw new Error('That password reset link expired. Request a new one and try again.');
    writeSession({ ...recovery, user });
    history.replaceState(null, '', location.pathname + location.search);
    openAccount(); setMode('newpassword'); setNotice('Choose a new password to finish account recovery.');
    return true;
  }

  async function cloudRequest(url, options = {}, retried = false) {
    if (!session?.access_token) throw new Error('Sign in to sync your workspace.');
    const response = await fetch(`${base}${url}`, { ...options, headers: { apikey: anon, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
    if (response.status === 401 && !retried) { await refreshSession(); return cloudRequest(url, options, true); }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.message || value.msg || value.error_description || value.error || `Cloud save failed (${response.status}).`);
    return value;
  }

  function localSnapshot() {
    const data = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith('nexora.') || key.startsWith('nexora.account.')) continue;
        const value = localStorage.getItem(key);
        if (value && value.length <= 700000) data[key] = value;
      }
    } catch {}
    return data;
  }

  async function pushCloud() {
    if (!session?.access_token || !hasCloud || applying) return;
    const data = localSnapshot();
    const bytes = new Blob([JSON.stringify(data)]).size;
    if (bytes > 900000) { setNotice('Your local workspace is larger than the account sync limit. Remove large saved photos and retry.', 'error'); return; }
    const id = session.user?.id;
    if (!id) return;
    const query = `/rest/v1/nexora_user_data?on_conflict=user_id`;
    try {
      await cloudRequest(query, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: id, data, updated_at: new Date().toISOString() }) });
      const notice = document.querySelector('#nexoraAccountNotice');
      if (notice && document.querySelector('#nexoraAccountOverlay')?.classList.contains('hidden')) notice.textContent = 'Cloud sync is up to date.';
    } catch (error) { console.warn('Nexora cloud sync failed:', error.message); }
  }

  async function restoreCloud() {
    const id = session.user?.id;
    if (!id) throw new Error('Your account session is incomplete. Sign in again.');
    const rows = await cloudRequest(`/rest/v1/nexora_user_data?select=data&user_id=eq.${encodeURIComponent(id)}&limit=1`);
    const remote = rows?.[0]?.data;
    const local = localSnapshot();
    const combined = remote && typeof remote === 'object' ? { ...remote, ...local } : local;
    applying = true;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key?.startsWith('nexora.') && !key.startsWith('nexora.account.')) localStorage.removeItem(key); }
      for (const [key, value] of Object.entries(combined)) localStorage.setItem(key, value);
    } finally { applying = false; }
    await pushCloud();
    return true;
  }

  function scheduleSync() {
    if (!session?.access_token || applying) return;
    clearTimeout(syncTimer); syncTimer = setTimeout(pushCloud, 900);
  }

  function installSyncHook() {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      const result = original.call(this, key, value);
      if (this === localStorage && String(key).startsWith('nexora.') && !String(key).startsWith('nexora.account.')) scheduleSync();
      return result;
    };
  }

  addStyles(); addAccountUi(); installSyncHook();
  finishPasswordRecovery().then(recovered => {
    if (!recovered && session?.access_token && hasCloud) return restoreCloud().catch(error => { writeSession(null); console.warn('Nexora account restore failed:', error.message); });
  }).catch(error => { openAccount(); setMode('reset'); setNotice(error.message, 'error'); });
})();
