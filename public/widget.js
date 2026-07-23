/* Embeddable web-chat widget. Drop onto any site with:
     <script src="https://your-crm-host/widget.js" defer></script>
   It talks to the same inbox as WhatsApp, so agents/AI answer both in one place. */
(() => {
  'use strict';
  const ORIGIN = new URL(document.currentScript?.src || location.href).origin;
  const KEY = 'wacrm_webchat_session';
  let sessionId = localStorage.getItem(KEY) || '';
  let lastId = 0;
  let poller = null;
  let open = false;

  const css = `
    .wc-fab{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;background:#008069;color:#fff;border:none;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:26px;cursor:pointer;z-index:2147483000}
    .wc-panel{position:fixed;right:20px;bottom:88px;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
    .wc-panel.open{display:flex}
    .wc-head{background:#008069;color:#fff;padding:12px 14px;font-weight:700}
    .wc-head small{display:block;font-weight:400;opacity:.85;font-size:12px}
    .wc-msgs{flex:1;overflow-y:auto;padding:12px;background:#efeae2;display:flex;flex-direction:column;gap:6px}
    .wc-b{max-width:80%;padding:7px 11px;border-radius:10px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 1px rgba(0,0,0,.12)}
    .wc-b.in{align-self:flex-end;background:#d9fdd3}
    .wc-b.out{align-self:flex-start;background:#fff}
    .wc-b .wc-who{font-size:11px;font-weight:700;color:#6f42c1;margin-bottom:2px}
    .wc-b img{max-width:100%;border-radius:6px;display:block}
    .wc-foot{display:flex;gap:6px;padding:10px;background:#fff;border-top:1px solid #e4e7eb}
    .wc-foot input{flex:1;border:1px solid #e4e7eb;border-radius:18px;padding:9px 14px;font-size:14px;outline:none}
    .wc-foot button{background:#008069;color:#fff;border:none;border-radius:50%;width:38px;height:38px;font-size:15px;cursor:pointer}
    .wc-note{padding:16px;color:#667781;font-size:13px;text-align:center}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.className = 'wc-fab'; fab.innerHTML = '💬'; fab.title = 'Chat with us';
  const panel = document.createElement('div');
  panel.className = 'wc-panel';
  panel.innerHTML = `
    <div class="wc-head">Chat with us <small>We typically reply in a few minutes</small></div>
    <div class="wc-msgs" id="wc-msgs"><div class="wc-note">👋 Hi! Send us a message and our team (or assistant) will help.</div></div>
    <div class="wc-foot"><input id="wc-input" placeholder="Type a message…" autocomplete="off"/><button id="wc-send">➤</button></div>`;
  document.body.appendChild(fab); document.body.appendChild(panel);

  const msgsEl = panel.querySelector('#wc-msgs');
  const inputEl = panel.querySelector('#wc-input');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function addBubble(m) {
    const note = msgsEl.querySelector('.wc-note'); if (note) note.remove();
    const div = document.createElement('div');
    div.className = 'wc-b ' + (m.direction === 'in' ? 'in' : 'out');
    const who = m.direction === 'out' && m.sender_name ? `<div class="wc-who">${esc(m.sender_name)}</div>` : '';
    const media = m.media_url && m.type === 'image' ? `<img src="${ORIGIN}${esc(m.media_url)}" alt=""/>` : '';
    div.innerHTML = who + media + esc(m.body || '');
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function api(path, opts) {
    const res = await fetch(ORIGIN + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) } });
    return res.json();
  }

  async function ensureSession() {
    const out = await api('/chat/session', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) });
    sessionId = out.session_id; localStorage.setItem(KEY, sessionId);
  }

  async function poll() {
    if (!sessionId) return;
    try {
      const out = await api(`/chat/poll?session_id=${encodeURIComponent(sessionId)}&after=${lastId}`);
      for (const m of out.messages || []) { addBubble(m); lastId = Math.max(lastId, m.id); }
    } catch { /* ignore transient errors */ }
  }

  async function send() {
    const text = inputEl.value.trim(); if (!text) return;
    inputEl.value = '';
    await ensureSession();
    await api('/chat/message', { method: 'POST', body: JSON.stringify({ session_id: sessionId, text }) });
    poll();
  }

  fab.addEventListener('click', async () => {
    open = !open; panel.classList.toggle('open', open);
    if (open) {
      await ensureSession();
      await poll();
      if (!poller) poller = setInterval(poll, 3000);
      inputEl.focus();
    }
  });
  panel.querySelector('#wc-send').addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
})();
