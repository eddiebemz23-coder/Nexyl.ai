(() => {
  'use strict';

  /* ---------- Helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const state = {
    token: localStorage.getItem('nexyl_token'),
    user: null,
    conversations: [],
    activeId: null,
    streaming: false,
    authMode: 'login',
  };

  const INTENT_LABELS = {
    knowledge: 'knowledge base', math: 'calculator', time: 'clock', remember: 'memory · saved',
    recall: 'memory · recall', forget: 'memory · cleared', summarize: 'summariser', greeting: 'greeting',
    identity: 'identity', thanks: 'small talk', bye: 'small talk', llm: 'language model', fallback: 'no match',
  };

  // Inline the logo into every [data-logo] slot (unique gradient ids per copy).
  let logoCount = 0;
  function mountLogos(root = document) {
    const tpl = $('#logo-tpl').innerHTML;
    $$('[data-logo]:not([data-mounted])', root).forEach((slot) => {
      const id = `nexyl-g-${++logoCount}`;
      slot.innerHTML = tpl.replaceAll('nexyl-g', id);
      slot.dataset.mounted = '1';
    });
  }
  function logoEl() {
    const span = document.createElement('span');
    span.className = 'logo';
    const id = `nexyl-g-${++logoCount}`;
    span.innerHTML = $('#logo-tpl').innerHTML.replaceAll('nexyl-g', id);
    span.dataset.mounted = '1';
    return span;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  let toastTimer;
  function toast(message, isError = false) {
    const t = $('#toast');
    t.textContent = message;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  /* ---------- API ---------- */
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && state.token && !path.startsWith('/auth/login')) {
      signOut();
      throw new Error('Please sign in again.');
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  /* ---------- Safe markdown-lite renderer ---------- */
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function inline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }
  function renderMarkdown(text) {
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
    return blocks.map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return '<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('') + '</ul>';
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }

  /* ---------- Views ---------- */
  function showAuth() {
    $('#app-view').hidden = true;
    $('#auth-view').hidden = false;
    setTimeout(() => $('#auth-email').focus(), 0);
  }
  function showApp() {
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    const first = state.user.name.split(' ')[0];
    $('#user-name').textContent = state.user.name;
    $('#user-avatar').textContent = state.user.name.trim().slice(0, 1).toUpperCase();
    $('#empty-greeting').textContent = `Hi ${first}, how can I help?`;
  }

  function signOut() {
    localStorage.removeItem('nexyl_token');
    Object.assign(state, { token: null, user: null, conversations: [], activeId: null });
    $('#convo-list').replaceChildren();
    clearMessages();
    showAuth();
  }

  /* ---------- Auth form ---------- */
  function setAuthMode(mode) {
    state.authMode = mode;
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === mode;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    $('#name-field').hidden = mode !== 'register';
    $('#auth-submit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
    $('#auth-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('#auth-error').hidden = true;
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const btn = $('#auth-submit');
    const errBox = $('#auth-error');
    errBox.hidden = true;
    btn.disabled = true;
    try {
      const body = { email: $('#auth-email').value, password: $('#auth-password').value };
      if (state.authMode === 'register') body.name = $('#auth-name').value;
      const data = await api(`/auth/${state.authMode}`, { method: 'POST', body });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('nexyl_token', data.token);
      $('#auth-form').reset();
      await enterApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Conversations ---------- */
  function renderConversations() {
    const list = $('#convo-list');
    list.replaceChildren();
    if (!state.conversations.length) {
      list.append(el('p', 'convo-empty', 'No chats yet. Say hello!'));
      return;
    }
    for (const c of state.conversations) {
      const row = el('div', 'convo' + (c.id === state.activeId ? ' active' : ''));
      const title = el('button', 'convo-title', c.title);
      title.title = c.title;
      title.addEventListener('click', () => openConversation(c.id));

      const rename = iconButton('Rename chat', 'M4 13.5V16h2.5L14 8.5 11.5 6 4 13.5Zm10.7-7.2a.8.8 0 0 0 0-1.1l-1.4-1.4a.8.8 0 0 0-1.1 0l-1 1 2.5 2.5 1-1Z');
      rename.addEventListener('click', () => renameConversation(c));
      const del = iconButton('Delete chat', 'M5 6h10M8 6V4h4v2m-6 0 .6 9.5h6.8L14 6');
      del.addEventListener('click', () => deleteConversation(c));
      row.append(title, rename, del);
      list.append(row);
    }
  }

  function iconButton(label, path) {
    const b = el('button', 'icon-btn');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
    return b;
  }

  async function loadConversations() {
    const { conversations } = await api('/conversations');
    state.conversations = conversations;
    renderConversations();
  }

  async function createConversation() {
    const { conversation } = await api('/conversations', { method: 'POST' });
    state.conversations.unshift(conversation);
    return conversation;
  }

  async function newChat() {
    if (state.streaming) return;
    state.activeId = null;
    $('#chat-title').textContent = 'New chat';
    clearMessages();
    renderConversations();
    closeSidebar();
    $('#input').focus();
  }

  async function openConversation(id) {
    if (state.streaming) return;
    try {
      const { messages } = await api(`/conversations/${id}/messages`);
      state.activeId = id;
      const convo = state.conversations.find((c) => c.id === id);
      $('#chat-title').textContent = convo ? convo.title : 'Chat';
      clearMessages();
      messages.forEach((m) => appendMessage(m));
      if (!messages.length) showEmpty(true);
      renderConversations();
      closeSidebar();
      scrollToBottom(false);
    } catch (err) { toast(err.message, true); }
  }

  async function renameConversation(c) {
    const title = prompt('Rename chat', c.title);
    if (title == null || !title.trim()) return;
    try {
      const { conversation } = await api(`/conversations/${c.id}`, { method: 'PATCH', body: { title } });
      c.title = conversation.title;
      if (c.id === state.activeId) $('#chat-title').textContent = c.title;
      renderConversations();
    } catch (err) { toast(err.message, true); }
  }

  async function deleteConversation(c) {
    if (!confirm(`Delete “${c.title}”? This can't be undone.`)) return;
    try {
      await api(`/conversations/${c.id}`, { method: 'DELETE' });
      state.conversations = state.conversations.filter((x) => x.id !== c.id);
      if (c.id === state.activeId) newChat(); else renderConversations();
    } catch (err) { toast(err.message, true); }
  }

  /* ---------- Messages ---------- */
  const messagesEl = () => $('#messages');
  function showEmpty(show) { $('#empty').hidden = !show; }
  function clearMessages() {
    $$('.msg', messagesEl()).forEach((m) => m.remove());
    showEmpty(true);
  }
  function scrollToBottom(smooth = true) {
    const m = messagesEl();
    m.scrollTo({ top: m.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function appendMessage(m) {
    showEmpty(false);
    if (m.role === 'user') {
      const row = el('div', 'msg user');
      row.append(el('div', 'bubble', m.content));
      messagesEl().append(row);
      return row;
    }
    const row = el('div', 'msg bot');
    row.append(logoEl());
    const bubble = el('div', 'bubble');
    const body = el('div', 'md');
    body.innerHTML = renderMarkdown(m.content);
    bubble.append(body);
    bubble.append(buildMeta(m));
    row.append(bubble);
    messagesEl().append(row);
    return row;
  }

  function buildMeta(m) {
    const meta = el('div', 'meta');
    const info = m.meta || {};
    if (info.intent) meta.append(el('span', 'chip-meta intent', INTENT_LABELS[info.intent] || info.intent));
    (info.sources || []).slice(0, 2).forEach((s) => meta.append(el('span', 'chip-meta source', s.title)));
    if (info.latency_ms != null) meta.append(el('span', 'chip-meta', `${info.latency_ms} ms`));

    const fb = el('div', 'fb');
    const up = iconButton('Good answer', 'M7 9V16H4V9h3Zm0 0 3-6c1.2 0 2 1 1.7 2.2L11 8h4a1.5 1.5 0 0 1 1.5 1.8l-1 5A1.5 1.5 0 0 1 14 16H7');
    const down = iconButton('Bad answer', 'M7 11V4H4v7h3Zm0 0 3 6c1.2 0 2-1 1.7-2.2L11 12h4a1.5 1.5 0 0 0 1.5-1.8l-1-5A1.5 1.5 0 0 0 14 4H7');
    down.classList.add('down');
    const paint = (r) => { up.classList.toggle('on', r === 1); down.classList.toggle('on', r === -1); };
    paint(m.rating);
    let current = m.rating || 0;
    const rate = (value) => async () => {
      const next = current === value ? 0 : value;
      try { await api(`/messages/${m.id}/feedback`, { method: 'POST', body: { rating: next } }); current = next; paint(next); }
      catch (err) { toast(err.message, true); }
    };
    up.addEventListener('click', rate(1));
    down.addEventListener('click', rate(-1));
    fb.append(up, down);
    meta.append(fb);
    return meta;
  }

  /* ---------- Sending (SSE streaming) ---------- */
  async function sendMessage(text) {
    text = text.trim();
    if (!text || state.streaming) return;
    setStreaming(true);

    let botRow, body, buffer = '';
    try {
      if (!state.activeId) {
        const convo = await createConversation();
        state.activeId = convo.id;
        renderConversations();
      }
      appendMessage({ role: 'user', content: text });

      botRow = el('div', 'msg bot');
      botRow.append(logoEl());
      const bubble = el('div', 'bubble');
      body = el('div', 'md');
      const typing = el('span', 'typing');
      typing.append(el('i'), el('i'), el('i'));
      body.append(typing);
      bubble.append(body);
      botRow.append(bubble);
      messagesEl().append(botRow);
      scrollToBottom();

      const res = await fetch(`/api/conversations/${state.activeId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ content: text, timezone: TZ }),
      });
      if (res.status === 401) { signOut(); throw new Error('Please sign in again.'); }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let finished = false;

      const handle = (event, data) => {
        if (event === 'token') {
          buffer += data.text;
          body.innerHTML = renderMarkdown(buffer);
          body.classList.add('caret');
          scrollToBottom(false);
        } else if (event === 'done') {
          finished = true;
          body.classList.remove('caret');
          body.innerHTML = renderMarkdown(data.message.content);
          botRow.querySelector('.bubble').append(buildMeta(data.message));
          const convo = state.conversations.find((c) => c.id === data.conversation.id);
          if (convo) { convo.title = data.conversation.title; convo.updated_at = new Date().toISOString(); }
          state.conversations.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
          $('#chat-title').textContent = data.conversation.title;
          renderConversations();
        } else if (event === 'error') {
          throw new Error(data.error);
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, idx);
          pending = pending.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const dataLine = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && dataLine) handle(ev, JSON.parse(dataLine));
        }
      }
      if (!finished) throw new Error('The connection closed before the reply finished.');
    } catch (err) {
      if (botRow) {
        botRow.classList.add('error');
        body.classList.remove('caret');
        body.textContent = buffer ? buffer + ' …' : err.message;
      }
      toast(err.message, true);
    } finally {
      setStreaming(false);
      scrollToBottom();
      $('#input').focus();
    }
  }

  function setStreaming(on) {
    state.streaming = on;
    $('#input').disabled = on;
    updateSendButton();
  }
  function updateSendButton() {
    $('#send').disabled = state.streaming || !$('#input').value.trim();
  }
  function autoGrow() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 180) + 'px';
  }

  /* ---------- Memories ---------- */
  async function openMemories() {
    const dialog = $('#memories-dialog');
    const list = $('#memories-list');
    list.replaceChildren(el('li', 'memories-empty', 'Loading…'));
    dialog.showModal();
    try {
      const { memories } = await api('/memories');
      list.replaceChildren();
      if (!memories.length) {
        list.append(el('li', 'memories-empty', 'Nothing saved yet. Try “remember that I prefer dark mode”.'));
        return;
      }
      for (const m of memories) {
        const li = el('li');
        li.append(el('span', null, m.fact));
        const del = iconButton('Forget this', 'M5 5l10 10M15 5L5 15');
        del.addEventListener('click', async () => {
          try { await api(`/memories/${m.id}`, { method: 'DELETE' }); li.remove(); if (!list.children.length) openMemories(); }
          catch (err) { toast(err.message, true); }
        });
        li.append(del);
        list.append(li);
      }
    } catch (err) {
      list.replaceChildren(el('li', 'memories-empty', err.message));
    }
  }

  /* ---------- Sidebar (mobile) ---------- */
  function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }

  /* ---------- Boot ---------- */
  const SUGGESTIONS = [
    'What is PostgreSQL?',
    'Calculate (12 + 8) * 3 / 4',
    'How does the Nexyl engine work?',
    'Remember that my favourite colour is teal',
    'What time is it?',
  ];

  async function checkHealth() {
    const badge = $('#engine-badge');
    try {
      const res = await fetch('/api/health');
      const h = await res.json();
      $('#engine-text').textContent = h.engine + (h.llm ? ' + LLM' : '');
      badge.classList.toggle('down', h.status !== 'ok');
    } catch {
      badge.classList.add('down');
      $('#engine-text').textContent = 'offline';
    }
  }

  async function enterApp() {
    showApp();
    checkHealth();
    try { await loadConversations(); } catch (err) { toast(err.message, true); }
    newChat();
  }

  async function init() {
    mountLogos();

    const chips = $('#chips');
    SUGGESTIONS.forEach((s) => {
      const b = el('button', 'chip', s);
      b.type = 'button';
      b.addEventListener('click', () => sendMessage(s));
      chips.append(b);
    });

    $$('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.tab)));
    $('#auth-form').addEventListener('submit', onAuthSubmit);
    $('#sign-out').addEventListener('click', signOut);
    $('#new-chat').addEventListener('click', newChat);
    $('#open-memories').addEventListener('click', openMemories);
    $('#close-memories').addEventListener('click', () => $('#memories-dialog').close());
    $('#memories-dialog').addEventListener('click', (e) => { if (e.target.id === 'memories-dialog') e.target.close(); });
    $('#menu-btn').addEventListener('click', openSidebar);
    $('#scrim').addEventListener('click', closeSidebar);

    const input = $('#input');
    input.addEventListener('input', () => { autoGrow(); updateSendButton(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
    });
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim() || state.streaming) return;
      input.value = '';
      autoGrow();
      updateSendButton();
      sendMessage(text);
    });

    if (state.token) {
      try {
        const { user } = await api('/auth/me');
        state.user = user;
        await enterApp();
        return;
      } catch { /* fall through to auth */ }
    }
    setAuthMode('login');
    showAuth();
  }

  /* ---------- Install (PWA) ---------- */
  // Chrome/Edge fire beforeinstallprompt and let us show our own button; Safari and Firefox
  // never do, so the same button falls back to per-platform instructions.
  let installPrompt = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function refreshInstallButtons() {
    $$('.install-trigger').forEach((b) => { b.hidden = isStandalone(); });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    refreshInstallButtons();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    refreshInstallButtons();
    toast('Nexyl is installed on this device.');
  });

  async function requestInstall() {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      installPrompt = null;
      if (outcome === 'accepted') toast('Installing Nexyl…');
      refreshInstallButtons();
      return;
    }
    $('#install-dialog').showModal();
  }

  $$('.install-trigger').forEach((b) => b.addEventListener('click', requestInstall));
  $('#close-install').addEventListener('click', () => $('#install-dialog').close());
  $('#install-dialog').addEventListener('click', (e) => { if (e.target.id === 'install-dialog') e.target.close(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* the offline shell is optional */ });
  }
  refreshInstallButtons();

  init();
})();
