/* WhatsApp CRM — single-page app (vanilla JS, hash routing, SSE live updates) */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  let state = {
    token: localStorage.getItem('token') || null,
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    route: 'inbox',
    // inbox state
    convFilter: 'all',
    activeConvId: null,
    conversations: [],
    messages: [],
    activeConv: null,
    simOpen: false,
    simPhone: localStorage.getItem('simPhone') || '15550001111',
    simName: localStorage.getItem('simName') || 'Jane Customer',
  };
  let es = null;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401 && state.token) { logout(); throw new Error('Session expired'); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  }

  function toast(msg, isError = false) {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  function ticks(status) {
    if (status === 'read') return '<span class="ticks read">✓✓</span>';
    if (status === 'delivered') return '<span class="ticks">✓✓</span>';
    if (status === 'sent') return '<span class="ticks">✓</span>';
    if (status === 'failed') return '<span style="color:var(--danger)">✗</span>';
    return '';
  }

  function modal(html) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal">${html}</div>`;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    state.token = null; state.user = null;
    if (es) { es.close(); es = null; }
    render();
  }

  // ---------- SSE live updates ----------
  function connectEvents() {
    if (es) es.close();
    es = new EventSource('/api/events?token=' + encodeURIComponent(state.token));
    const refreshInbox = async (e) => {
      if (state.route !== 'inbox') return;
      const data = JSON.parse(e.data || '{}');
      await loadConversations();
      if (data.conversation_id === state.activeConvId) await loadMessages(state.activeConvId, false);
      renderRoute();
    };
    es.addEventListener('message_created', refreshInbox);
    es.addEventListener('conversation_updated', refreshInbox);
    es.addEventListener('message_status', refreshInbox);
    es.addEventListener('broadcast_progress', () => { if (state.route === 'broadcasts') renderRoute(); });
    es.addEventListener('contact_created', () => { if (state.route === 'contacts') renderRoute(); });
  }

  // ---------- Login page ----------
  function renderLogin() {
    $app.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <h1>💬 WhatsApp CRM</h1>
          <div class="sub">Team inbox · Broadcasts · AI agents</div>
          <div id="login-error"></div>
          <form id="login-form">
            <label class="field">Email <input class="input" name="email" type="email" required autocomplete="username" /></label>
            <label class="field">Password <input class="input" name="password" type="password" required autocomplete="current-password" /></label>
            <button class="btn" style="width:100%" type="submit">Sign in</button>
          </form>
          <div class="login-hint">
            <b>Demo accounts</b><br/>
            Admin — admin@example.com / admin123<br/>
            Agent — ava@example.com / agent123<br/>
            Agent — ben@example.com / agent123
          </div>
        </div>
      </div>`;
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const out = await api('/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
        state.token = out.token; state.user = out.user;
        localStorage.setItem('token', out.token);
        localStorage.setItem('user', JSON.stringify(out.user));
        render();
      } catch (err) {
        document.getElementById('login-error').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    });
  }

  // ---------- Shell ----------
  const NAV = [
    ['inbox', '💬', 'Inbox'],
    ['contacts', '👥', 'Contacts'],
    ['broadcasts', '📣', 'Broadcasts'],
    ['templates', '📄', 'Templates'],
    ['ai', '🤖', 'AI Agents'],
    ['team', '🧑‍💼', 'Team'],
    ['analytics', '📊', 'Analytics'],
    ['settings', '⚙️', 'Settings'],
  ];

  function renderShell() {
    const isAdmin = state.user.role === 'admin';
    const nav = NAV.filter(([r]) => isAdmin || !['team', 'settings'].includes(r));
    $app.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="brand">💬 WhatsApp CRM</div>
          <nav>
            ${nav.map(([r, icon, label]) => `<a href="#${r}" data-route="${r}" class="${state.route === r ? 'active' : ''}">${icon} ${label}</a>`).join('')}
          </nav>
          <div class="me">
            <div class="name">${esc(state.user.name)}</div>
            <div class="muted">${esc(state.user.role)}</div>
            <div class="row">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="avail-toggle" ${state.user.available ? 'checked' : ''}/> Available
              </label>
              <button class="link-btn" id="logout-btn">Sign out</button>
            </div>
          </div>
        </aside>
        <div class="main" id="main"></div>
      </div>
      <button class="sim-fab" id="sim-fab">📱 Simulate customer</button>
      <div id="sim-panel-slot"></div>`;
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('avail-toggle').addEventListener('change', async (e) => {
      await api('/me/availability', { method: 'PATCH', body: { available: e.target.checked } });
      state.user.available = e.target.checked ? 1 : 0;
      localStorage.setItem('user', JSON.stringify(state.user));
      toast(e.target.checked ? 'You are available for new chats' : 'You are away — no new chats will be assigned');
    });
    document.getElementById('sim-fab').addEventListener('click', () => { state.simOpen = !state.simOpen; renderSim(); });
    renderSim();
  }

  // ---------- Simulator (sandbox demo tool) ----------
  function renderSim() {
    const slot = document.getElementById('sim-panel-slot');
    if (!slot) return;
    if (!state.simOpen) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <div class="sim-panel">
        <h4>📱 Customer simulator</h4>
        <div class="sub">Sends an inbound WhatsApp message through the sandbox webhook — watch it hit the inbox, round-robin and AI auto-reply.</div>
        <label class="field">Phone <input class="input" id="sim-phone" value="${esc(state.simPhone)}" /></label>
        <label class="field">Name <input class="input" id="sim-name" value="${esc(state.simName)}" /></label>
        <label class="field">Message <textarea class="input" id="sim-text" rows="2" placeholder="e.g. Hi, where is my order?"></textarea></label>
        <button class="btn" style="width:100%" id="sim-send">Send as customer</button>
      </div>`;
    document.getElementById('sim-send').addEventListener('click', async () => {
      const phone = document.getElementById('sim-phone').value.trim();
      const name = document.getElementById('sim-name').value.trim();
      const text = document.getElementById('sim-text').value.trim();
      if (!phone || !text) return toast('Phone and message are required', true);
      state.simPhone = phone; state.simName = name;
      localStorage.setItem('simPhone', phone); localStorage.setItem('simName', name);
      try {
        await api('/simulator/inbound', { method: 'POST', body: { phone, name, text } });
        document.getElementById('sim-text').value = '';
        toast('Inbound message simulated');
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- Inbox ----------
  async function loadConversations() {
    const q = state.convFilter === 'all' ? '' : `?filter=${state.convFilter}`;
    state.conversations = await api('/conversations' + q);
  }

  async function loadMessages(convId, markRead = true) {
    state.activeConv = await api('/conversations/' + convId);
    state.messages = await api(`/conversations/${convId}/messages`);
  }

  function statusBadge(s) {
    return { open: '<span class="badge green">open</span>', pending: '<span class="badge amber">pending</span>', resolved: '<span class="badge gray">resolved</span>' }[s] || '';
  }

  async function renderInbox($main) {
    await loadConversations();
    if (state.activeConvId && !state.activeConv) await loadMessages(state.activeConvId).catch(() => { state.activeConvId = null; });

    const filters = [['all', 'All'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['ai', '🤖 AI']];
    $main.innerHTML = `
      <div class="inbox">
        <div class="conv-list">
          <div class="filters">
            ${filters.map(([f, l]) => `<button class="chip ${state.convFilter === f ? 'active' : ''}" data-filter="${f}">${l}</button>`).join('')}
          </div>
          <div class="conv-scroll">
            ${state.conversations.map((c) => `
              <button class="conv-item ${c.id === state.activeConvId ? 'active' : ''}" data-conv="${c.id}">
                <div class="top">
                  <span class="who">${esc(c.contact_name || '+' + c.wa_id)}</span>
                  <span class="when">${fmtTime(c.last_message_at)}</span>
                </div>
                <div class="preview">${esc(c.last_message_preview || '')}</div>
                <div class="meta">
                  ${statusBadge(c.status)}
                  ${c.ai_enabled ? `<span class="badge purple">🤖 ${esc(c.ai_agent_name || 'AI')}</span>` : ''}
                  ${c.assigned_name ? `<span class="badge blue">${esc(c.assigned_name)}</span>` : (!c.ai_enabled ? '<span class="badge gray">unassigned</span>' : '')}
                  ${c.unread_count ? `<span class="unread-dot">${c.unread_count}</span>` : ''}
                </div>
              </button>`).join('') || '<div style="padding:20px" class="muted">No conversations yet. Use the simulator to create one!</div>'}
          </div>
        </div>
        ${state.activeConv ? renderThread() : `
          <div class="thread"><div class="empty-thread">
            <div class="big">💬</div>
            <div><b>Select a conversation</b></div>
            <div>or click “📱 Simulate customer” to receive a test message</div>
          </div></div>`}
      </div>`;

    $main.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', async () => {
      state.convFilter = b.dataset.filter; await loadConversations(); renderRoute();
    }));
    $main.querySelectorAll('[data-conv]').forEach((b) => b.addEventListener('click', async () => {
      state.activeConvId = Number(b.dataset.conv);
      await loadMessages(state.activeConvId);
      renderRoute();
    }));
    if (state.activeConv) wireThread($main);
    const scroll = $main.querySelector('.thread-msgs');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function renderThread() {
    const c = state.activeConv;
    return `
      <div class="thread">
        <div class="thread-header">
          <span class="avatar">${initials(c.contact_name)}</span>
          <div class="info">
            <div class="name">${esc(c.contact_name || 'Unknown')}</div>
            <div class="phone">+${esc(c.wa_id)} ${c.contact_tags.map((t) => `<span class="badge gray">${esc(t)}</span>`).join(' ')}</div>
          </div>
          <div class="actions">
            ${statusBadge(c.status)}
            ${c.ai_enabled ? `<span class="badge purple">🤖 ${esc(c.ai_agent_name)}</span>` : ''}
            <select class="input" id="assign-select" style="width:auto;padding:5px 8px"></select>
            <button class="btn small secondary" id="ai-toggle">${c.ai_enabled ? 'Disable AI' : 'Enable AI'}</button>
            ${c.status !== 'resolved'
              ? '<button class="btn small" id="resolve-btn">✓ Resolve</button>'
              : '<button class="btn small secondary" id="reopen-btn">Reopen</button>'}
          </div>
        </div>
        <div class="thread-msgs">
          ${state.messages.map((m) => {
            if (m.sender_type === 'system') return `<div class="sysnote">${esc(m.body)}</div>`;
            const senderLabel = m.sender_type === 'ai' ? `<div class="sender ai">🤖 ${esc(m.ai_agent_name || 'AI Agent')}</div>`
              : m.sender_type === 'broadcast' ? '<div class="sender broadcast">📣 Broadcast</div>'
              : m.sender_type === 'agent' && m.sender_name ? `<div class="sender">${esc(m.sender_name)}</div>` : '';
            return `<div class="bubble ${m.direction}">
              ${senderLabel}
              <div>${esc(m.body)}</div>
              <div class="stamp">${fmtTime(m.created_at)} ${m.direction === 'out' ? ticks(m.status) : ''}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="composer">
          <textarea id="composer-input" rows="1" placeholder="Type a reply… (Enter to send)"></textarea>
          <button class="btn" id="send-btn">Send ➤</button>
        </div>
      </div>`;
  }

  function wireThread($main) {
    const c = state.activeConv;
    const send = async () => {
      const input = document.getElementById('composer-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await api(`/conversations/${c.id}/messages`, { method: 'POST', body: { text } });
        await loadMessages(c.id); await loadConversations(); renderRoute();
      } catch (err) { toast(err.message, true); }
    };
    document.getElementById('send-btn').addEventListener('click', send);
    document.getElementById('composer-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    document.getElementById('composer-input').focus();

    // Assignment dropdown
    api('/users').then((users) => {
      const sel = document.getElementById('assign-select');
      if (!sel) return;
      sel.innerHTML = `<option value="">Unassigned</option>` + users.filter((u) => u.is_active)
        .map((u) => `<option value="${u.id}" ${u.id === c.assigned_user_id ? 'selected' : ''}>${esc(u.name)}${u.available ? '' : ' (away)'}</option>`).join('');
      sel.addEventListener('change', async () => {
        await api(`/conversations/${c.id}`, { method: 'PATCH', body: { assigned_user_id: sel.value ? Number(sel.value) : null } });
        await loadMessages(c.id); await loadConversations(); renderRoute();
      });
    });

    document.getElementById('ai-toggle').addEventListener('click', async () => {
      if (c.ai_enabled) {
        await api(`/conversations/${c.id}`, { method: 'PATCH', body: { ai_enabled: false } });
      } else {
        const agents = (await api('/ai-agents')).filter((a) => a.is_active);
        if (!agents.length) return toast('No active AI agents. Create one in the AI Agents page.', true);
        await api(`/conversations/${c.id}`, { method: 'PATCH', body: { ai_enabled: true, ai_agent_id: agents[0].id } });
      }
      await loadMessages(c.id); await loadConversations(); renderRoute();
    });

    const resolveBtn = document.getElementById('resolve-btn');
    if (resolveBtn) resolveBtn.addEventListener('click', async () => {
      await api(`/conversations/${c.id}`, { method: 'PATCH', body: { status: 'resolved' } });
      await loadMessages(c.id); await loadConversations(); renderRoute();
    });
    const reopenBtn = document.getElementById('reopen-btn');
    if (reopenBtn) reopenBtn.addEventListener('click', async () => {
      await api(`/conversations/${c.id}`, { method: 'PATCH', body: { status: 'open' } });
      await loadMessages(c.id); await loadConversations(); renderRoute();
    });
  }

  // ---------- Contacts ----------
  async function renderContacts($main) {
    const contacts = await api('/contacts');
    $main.innerHTML = `<div class="page">
      <div class="page-header">
        <div><h2>Contacts</h2><div class="sub">${contacts.length} contacts · tag them to build broadcast audiences</div></div>
        <button class="btn" id="add-contact">+ Add contact</button>
      </div>
      <div class="card">
        <table class="table">
          <thead><tr><th>Name</th><th>Phone</th><th>Tags</th><th>Last activity</th><th></th></tr></thead>
          <tbody>
            ${contacts.map((c) => `<tr>
              <td><b>${esc(c.name || '—')}</b>${c.opted_out ? ' <span class="badge red">opted out</span>' : ''}</td>
              <td class="mono">+${esc(c.wa_id)}</td>
              <td>${c.tags.map((t) => `<span class="badge green">${esc(t)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
              <td class="muted">${fmtTime(c.last_message_at) || 'never'}</td>
              <td style="text-align:right">
                <button class="btn small secondary" data-edit="${c.id}">Edit</button>
                <button class="btn small ghost" data-chat="${c.id}">Chat</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="5" class="muted">No contacts yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

    const openEditor = (contact) => {
      const m = modal(`
        <h3>${contact ? 'Edit contact' : 'Add contact'}</h3>
        <label class="field">Name <input class="input" id="ct-name" value="${esc(contact?.name || '')}" /></label>
        <label class="field">Phone (digits, with country code) <input class="input" id="ct-phone" value="${esc(contact?.wa_id || '')}" ${contact ? 'disabled' : ''} /></label>
        <label class="field">Tags (comma separated) <input class="input" id="ct-tags" value="${esc((contact?.tags || []).join(', '))}" placeholder="vip, newsletter" /></label>
        ${contact ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ct-optout" ${contact.opted_out ? 'checked' : ''}/> Opted out of broadcasts</label>` : ''}
        <div class="actions"><button class="btn secondary" id="ct-cancel">Cancel</button><button class="btn" id="ct-save">Save</button></div>`);
      m.querySelector('#ct-cancel').addEventListener('click', () => m.remove());
      m.querySelector('#ct-save').addEventListener('click', async () => {
        const body = {
          name: m.querySelector('#ct-name').value.trim(),
          tags: m.querySelector('#ct-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        };
        try {
          if (contact) {
            body.opted_out = m.querySelector('#ct-optout').checked;
            await api('/contacts/' + contact.id, { method: 'PATCH', body });
          } else {
            body.wa_id = m.querySelector('#ct-phone').value.trim();
            await api('/contacts', { method: 'POST', body });
          }
          m.remove(); renderRoute();
        } catch (err) { toast(err.message, true); }
      });
    };

    document.getElementById('add-contact').addEventListener('click', () => openEditor(null));
    $main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      openEditor(contacts.find((c) => c.id === Number(b.dataset.edit)));
    }));
    $main.querySelectorAll('[data-chat]').forEach((b) => b.addEventListener('click', async () => {
      const conv = await api('/conversations', { method: 'POST', body: { contact_id: Number(b.dataset.chat) } });
      state.activeConvId = conv.id; state.activeConv = null;
      location.hash = '#inbox';
    }));
  }

  // ---------- Broadcasts ----------
  async function renderBroadcasts($main) {
    const [broadcasts, templates, contacts] = await Promise.all([api('/broadcasts'), api('/templates'), api('/contacts')]);
    const allTags = [...new Set(contacts.flatMap((c) => c.tags))];

    const statusBadges = { draft: 'gray', scheduled: 'amber', sending: 'blue', completed: 'green', cancelled: 'red' };
    $main.innerHTML = `<div class="page">
      <div class="page-header">
        <div><h2>Broadcasts</h2><div class="sub">Send template campaigns to all contacts or a tagged segment</div></div>
        <button class="btn" id="new-bcast">+ New broadcast</button>
      </div>
      <div class="card">
        <table class="table">
          <thead><tr><th>Campaign</th><th>Template</th><th>Audience</th><th>Status</th><th>Progress</th><th>Sent / Delivered / Read</th><th></th></tr></thead>
          <tbody>
            ${broadcasts.map((b) => {
              const s = b.stats || {};
              const done = (s.sent || 0) + (s.delivered || 0) + (s.read || 0) + (s.failed || 0);
              const pct = s.total ? Math.round((done / s.total) * 100) : 0;
              return `<tr>
                <td><b>${esc(b.name)}</b><br/><span class="muted" style="font-size:12px">${b.scheduled_at ? '🕐 ' + esc(b.scheduled_at) + ' UTC' : 'by ' + esc(b.created_by_name || '—')}</span></td>
                <td class="mono">${esc(b.template_name)}</td>
                <td>${b.audience_tag ? `<span class="badge green">${esc(b.audience_tag)}</span>` : 'All contacts'}</td>
                <td><span class="badge ${statusBadges[b.status]}">${b.status}</span></td>
                <td><div class="progress"><div style="width:${pct}%"></div></div><span class="muted" style="font-size:11px">${done}/${s.total || 0}</span></td>
                <td>${s.sent + s.delivered + s.read || 0} / ${(s.delivered || 0) + (s.read || 0)} / ${s.read || 0}${s.failed ? ` <span class="badge red">${s.failed} failed</span>` : ''}</td>
                <td style="text-align:right">
                  ${['draft', 'scheduled'].includes(b.status) ? `<button class="btn small" data-send="${b.id}">Send now</button>` : ''}
                  ${['draft', 'scheduled', 'sending'].includes(b.status) ? `<button class="btn small danger" data-cancel="${b.id}">Cancel</button>` : ''}
                </td>
              </tr>`;
            }).join('') || '<tr><td colspan="7" class="muted">No broadcasts yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

    document.getElementById('new-bcast').addEventListener('click', () => {
      if (!templates.length) return toast('Create a template first', true);
      const m = modal(`
        <h3>New broadcast</h3>
        <label class="field">Campaign name <input class="input" id="bc-name" placeholder="July promo blast" /></label>
        <label class="field">Template
          <select class="input" id="bc-template">${templates.map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(t.language)})</option>`).join('')}</select>
        </label>
        <div class="muted mono" id="bc-preview" style="background:var(--bg);border-radius:8px;padding:10px;margin-bottom:12px"></div>
        <div id="bc-vars"></div>
        <label class="field">Audience
          <select class="input" id="bc-audience">
            <option value="">All contacts</option>
            ${allTags.map((t) => `<option value="${esc(t)}">Tag: ${esc(t)}</option>`).join('')}
          </select>
        </label>
        <div class="muted" id="bc-count" style="margin-bottom:12px"></div>
        <label class="field">Schedule (optional, UTC) <input class="input" id="bc-schedule" type="datetime-local" /></label>
        <div class="actions">
          <button class="btn secondary" id="bc-cancel">Cancel</button>
          <button class="btn ghost" id="bc-draft">Save draft</button>
          <button class="btn" id="bc-send">${'Send now'}</button>
        </div>`);

      const varInputs = () => [...m.querySelectorAll('[data-var]')].map((i) => i.value);
      const refreshTemplate = () => {
        const t = templates.find((x) => x.id === Number(m.querySelector('#bc-template').value));
        m.querySelector('#bc-preview').textContent = t.body;
        const nVars = Math.max(0, ...[...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((x) => Number(x[1])), 0);
        m.querySelector('#bc-vars').innerHTML = Array.from({ length: nVars }, (_, i) =>
          `<label class="field">Variable {{${i + 1}}} <input class="input" data-var placeholder="Value for {{${i + 1}}} — you can use {{name}}" /></label>`).join('');
      };
      const refreshCount = async () => {
        const tag = m.querySelector('#bc-audience').value;
        const { count } = await api('/broadcasts/0/audience-preview' + (tag ? '?tag=' + encodeURIComponent(tag) : ''));
        m.querySelector('#bc-count').textContent = `Audience: ${count} contact(s) (excludes opted-out)`;
      };
      refreshTemplate(); refreshCount();
      m.querySelector('#bc-template').addEventListener('change', refreshTemplate);
      m.querySelector('#bc-audience').addEventListener('change', refreshCount);
      m.querySelector('#bc-cancel').addEventListener('click', () => m.remove());

      const create = async (sendNow) => {
        const scheduleRaw = m.querySelector('#bc-schedule').value;
        const body = {
          name: m.querySelector('#bc-name').value.trim() || 'Untitled broadcast',
          template_id: Number(m.querySelector('#bc-template').value),
          variables: varInputs(),
          audience_tag: m.querySelector('#bc-audience').value || null,
          scheduled_at: scheduleRaw ? scheduleRaw.replace('T', ' ') + ':00' : null,
          send_now: sendNow,
        };
        try { await api('/broadcasts', { method: 'POST', body }); m.remove(); toast(sendNow ? 'Broadcast sending 🚀' : 'Broadcast saved'); renderRoute(); }
        catch (err) { toast(err.message, true); }
      };
      m.querySelector('#bc-draft').addEventListener('click', () => create(false));
      m.querySelector('#bc-send').addEventListener('click', () => create(true));
    });

    $main.querySelectorAll('[data-send]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/broadcasts/${b.dataset.send}/send`, { method: 'POST' }); toast('Broadcast sending 🚀'); renderRoute();
    }));
    $main.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/broadcasts/${b.dataset.cancel}/cancel`, { method: 'POST' }); toast('Broadcast cancelled'); renderRoute();
    }));
  }

  // ---------- Templates ----------
  async function renderTemplates($main) {
    const templates = await api('/templates');
    const isAdmin = state.user.role === 'admin';
    const tplBadge = (s) => ({ APPROVED: 'green', PENDING: 'amber', REJECTED: 'red', PAUSED: 'amber' }[s] || 'gray');
    $main.innerHTML = `<div class="page">
      <div class="page-header">
        <div><h2>Message templates</h2><div class="sub">Use {{name}} for the contact's name and {{1}}, {{2}}… for campaign variables. Templates sync with your Meta WhatsApp Business Account.</div></div>
        <div style="display:flex;gap:8px">
          ${isAdmin ? '<button class="btn ghost" id="sync-tpl">⟳ Sync from Meta</button>' : ''}
          <button class="btn" id="new-tpl">+ New template</button>
        </div>
      </div>
      <div class="card">
        <table class="table">
          <thead><tr><th>Name</th><th>Category</th><th>Language</th><th>Body</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${templates.map((t) => `<tr>
              <td class="mono"><b>${esc(t.name)}</b></td>
              <td><span class="badge ${t.category === 'MARKETING' ? 'purple' : 'blue'}">${t.category}</span></td>
              <td>${esc(t.language)}</td>
              <td style="max-width:380px">${esc(t.body)}</td>
              <td><span class="badge ${tplBadge(t.status)}">${esc(t.status)}</span>${t.meta_id ? '<br/><span class="muted" style="font-size:11px">synced to Meta</span>' : ''}</td>
              <td style="text-align:right">${isAdmin ? `
                ${!t.meta_id ? `<button class="btn small ghost" data-submit="${t.id}">Submit to Meta</button>` : ''}
                <button class="btn small danger" data-del="${t.id}">Delete</button>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="muted">No templates yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

    const syncBtn = document.getElementById('sync-tpl');
    if (syncBtn) syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      try {
        const { count } = await api('/templates/sync', { method: 'POST' });
        toast(`Synced ${count} template(s) from Meta`);
        renderRoute();
      } catch (err) { toast(err.message, true); syncBtn.disabled = false; }
    });
    $main.querySelectorAll('[data-submit]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const { status } = await api(`/templates/${b.dataset.submit}/submit`, { method: 'POST' });
        toast(`Submitted to Meta — status: ${status}`);
        renderRoute();
      } catch (err) { toast(err.message, true); b.disabled = false; }
    }));

    document.getElementById('new-tpl').addEventListener('click', () => {
      const m = modal(`
        <h3>New template</h3>
        <label class="field">Name <input class="input" id="tp-name" placeholder="summer_sale" /></label>
        <div class="form-row">
          <label class="field">Category
            <select class="input" id="tp-cat"><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
          </label>
          <label class="field">Language <input class="input" id="tp-lang" value="en" /></label>
        </div>
        <label class="field">Body <textarea class="input" id="tp-body" rows="4" placeholder="Hi {{name}}! Our summer sale starts {{1}} — up to {{2}} off."></textarea></label>
        <div class="actions"><button class="btn secondary" id="tp-cancel">Cancel</button><button class="btn" id="tp-save">Create</button></div>`);
      m.querySelector('#tp-cancel').addEventListener('click', () => m.remove());
      m.querySelector('#tp-save').addEventListener('click', async () => {
        try {
          await api('/templates', { method: 'POST', body: {
            name: m.querySelector('#tp-name').value.trim(),
            category: m.querySelector('#tp-cat').value,
            language: m.querySelector('#tp-lang').value.trim() || 'en',
            body: m.querySelector('#tp-body').value.trim(),
          } });
          m.remove(); renderRoute();
        } catch (err) { toast(err.message, true); }
      });
    });
    $main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/templates/' + b.dataset.del, { method: 'DELETE' }); renderRoute(); }
      catch (err) { toast(err.message, true); }
    }));
  }

  // ---------- AI Agents ----------
  async function renderAiAgents($main) {
    const agents = await api('/ai-agents');
    const isAdmin = state.user.role === 'admin';
    $main.innerHTML = `<div class="page">
      <div class="page-header">
        <div><h2>AI Agents</h2><div class="sub">Auto-reply bots powered by Claude — they pick up new chats and hand off to humans when needed</div></div>
        ${isAdmin ? '<button class="btn" id="new-agent">+ New AI agent</button>' : ''}
      </div>
      ${agents.map((a) => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div>
              <b style="font-size:16px">🤖 ${esc(a.name)}</b>
              ${a.is_active ? '<span class="badge green">active</span>' : '<span class="badge gray">disabled</span>'}
              ${a.auto_assign_new ? '<span class="badge purple">picks up new chats</span>' : ''}
              <div class="muted mt" style="max-width:640px;white-space:pre-wrap">${esc(a.system_prompt)}</div>
              <div class="mt">
                <span class="muted">Model:</span> <span class="mono">${esc(a.model)}</span> ·
                <span class="muted">Handoff keywords:</span> ${a.handoff_keywords.map((k) => `<span class="badge amber">${esc(k)}</span>`).join(' ')}
              </div>
            </div>
            ${isAdmin ? `<div style="display:flex;gap:8px">
              <button class="btn small secondary" data-edit="${a.id}">Edit</button>
              <button class="btn small ${a.is_active ? 'danger' : ''}" data-toggle="${a.id}" data-active="${a.is_active}">${a.is_active ? 'Disable' : 'Enable'}</button>
            </div>` : ''}
          </div>
        </div>`).join('') || '<div class="card muted">No AI agents yet</div>'}
      <div class="card" style="background:#fffbea">
        💡 <b>How it works:</b> when a new customer message arrives, an active agent with “picks up new chats” answers automatically.
        If the customer types a handoff keyword (or the AI decides it can't help), the chat is round-robin assigned to an available teammate.
        A human replying always takes over from the AI. Without an Anthropic API key (Settings), a built-in rule-based responder is used so you can demo the flow.
      </div>
    </div>`;

    const openEditor = (agent) => {
      const m = modal(`
        <h3>${agent ? 'Edit AI agent' : 'New AI agent'}</h3>
        <label class="field">Name <input class="input" id="ag-name" value="${esc(agent?.name || '')}" placeholder="Support Bot" /></label>
        <label class="field">System prompt <textarea class="input" id="ag-prompt" rows="6">${esc(agent?.system_prompt || '')}</textarea></label>
        <div class="form-row">
          <label class="field">Model <input class="input" id="ag-model" value="${esc(agent?.model || 'claude-haiku-4-5-20251001')}" /></label>
          <label class="field">Handoff keywords (comma sep.) <input class="input" id="ag-keywords" value="${esc((agent?.handoff_keywords || ['human', 'agent']).join(', '))}" /></label>
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input type="checkbox" id="ag-auto" ${agent ? (agent.auto_assign_new ? 'checked' : '') : 'checked'}/> Automatically pick up new conversations
        </label>
        <div class="actions"><button class="btn secondary" id="ag-cancel">Cancel</button><button class="btn" id="ag-save">Save</button></div>`);
      m.querySelector('#ag-cancel').addEventListener('click', () => m.remove());
      m.querySelector('#ag-save').addEventListener('click', async () => {
        const body = {
          name: m.querySelector('#ag-name').value.trim(),
          system_prompt: m.querySelector('#ag-prompt').value.trim(),
          model: m.querySelector('#ag-model').value.trim(),
          handoff_keywords: m.querySelector('#ag-keywords').value.split(',').map((k) => k.trim()).filter(Boolean),
          auto_assign_new: m.querySelector('#ag-auto').checked,
        };
        try {
          if (agent) await api('/ai-agents/' + agent.id, { method: 'PATCH', body });
          else await api('/ai-agents', { method: 'POST', body });
          m.remove(); renderRoute();
        } catch (err) { toast(err.message, true); }
      });
    };

    const newBtn = document.getElementById('new-agent');
    if (newBtn) newBtn.addEventListener('click', () => openEditor(null));
    $main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      openEditor(agents.find((a) => a.id === Number(b.dataset.edit)));
    }));
    $main.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      await api('/ai-agents/' + b.dataset.toggle, { method: 'PATCH', body: { is_active: b.dataset.active !== '1' } });
      renderRoute();
    }));
  }

  // ---------- Team ----------
  async function renderTeam($main) {
    const users = await api('/users');
    $main.innerHTML = `<div class="page">
      <div class="page-header">
        <div><h2>Team</h2><div class="sub">Staff sign in to reply. New chats round-robin between active, available members.</div></div>
        <button class="btn" id="new-user">+ Add teammate</button>
      </div>
      <div class="card">
        <table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Round-robin</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `<tr>
              <td><span class="avatar" style="width:28px;height:28px;font-size:11px">${initials(u.name)}</span> <b>${esc(u.name)}</b></td>
              <td class="muted">${esc(u.email)}</td>
              <td><span class="badge ${u.role === 'admin' ? 'purple' : 'blue'}">${u.role}</span></td>
              <td>${u.is_active ? '<span class="badge green">active</span>' : '<span class="badge red">disabled</span>'}</td>
              <td>${u.available && u.is_active ? '<span class="badge green">✓ available</span>' : '<span class="badge gray">away</span>'}</td>
              <td style="text-align:right"><button class="btn small secondary" data-edit="${u.id}">Edit</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

    const openEditor = (user) => {
      const m = modal(`
        <h3>${user ? 'Edit teammate' : 'Add teammate'}</h3>
        <label class="field">Name <input class="input" id="us-name" value="${esc(user?.name || '')}" /></label>
        ${user ? '' : '<label class="field">Email <input class="input" id="us-email" type="email" /></label>'}
        <label class="field">${user ? 'New password (leave blank to keep)' : 'Password'} <input class="input" id="us-pass" type="password" /></label>
        <label class="field">Role
          <select class="input" id="us-role">
            <option value="agent" ${user?.role === 'agent' ? 'selected' : ''}>Agent</option>
            <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </label>
        ${user ? `
          <label style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><input type="checkbox" id="us-active" ${user.is_active ? 'checked' : ''}/> Account active</label>
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="us-avail" ${user.available ? 'checked' : ''}/> Available for round-robin</label>` : ''}
        <div class="actions"><button class="btn secondary" id="us-cancel">Cancel</button><button class="btn" id="us-save">Save</button></div>`);
      m.querySelector('#us-cancel').addEventListener('click', () => m.remove());
      m.querySelector('#us-save').addEventListener('click', async () => {
        try {
          if (user) {
            await api('/users/' + user.id, { method: 'PATCH', body: {
              name: m.querySelector('#us-name').value.trim(),
              role: m.querySelector('#us-role').value,
              is_active: m.querySelector('#us-active').checked,
              available: m.querySelector('#us-avail').checked,
              password: m.querySelector('#us-pass').value || undefined,
            } });
          } else {
            await api('/users', { method: 'POST', body: {
              name: m.querySelector('#us-name').value.trim(),
              email: m.querySelector('#us-email').value.trim(),
              password: m.querySelector('#us-pass').value,
              role: m.querySelector('#us-role').value,
            } });
          }
          m.remove(); renderRoute();
        } catch (err) { toast(err.message, true); }
      });
    };
    document.getElementById('new-user').addEventListener('click', () => openEditor(null));
    $main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      openEditor(users.find((u) => u.id === Number(b.dataset.edit)));
    }));
  }

  // ---------- Analytics ----------
  async function renderAnalytics($main) {
    const { counters, perAgent, daily } = await api('/analytics');
    const maxDaily = Math.max(1, ...daily.map((d) => Math.max(d.inbound, d.outbound)));
    $main.innerHTML = `<div class="page">
      <div class="page-header"><div><h2>Analytics</h2><div class="sub">Live overview of inbox and campaign activity</div></div></div>
      <div class="stat-grid">
        <div class="stat"><div class="num">${counters.contacts}</div><div class="lbl">Contacts</div></div>
        <div class="stat"><div class="num">${counters.conversations_open}</div><div class="lbl">Open conversations</div></div>
        <div class="stat"><div class="num">${counters.messages_in_24h}</div><div class="lbl">Inbound (24h)</div></div>
        <div class="stat"><div class="num">${counters.messages_out_24h}</div><div class="lbl">Outbound (24h)</div></div>
        <div class="stat"><div class="num">${counters.ai_replies_24h}</div><div class="lbl">AI replies (24h)</div></div>
        <div class="stat"><div class="num">${counters.broadcasts_completed}</div><div class="lbl">Broadcasts completed</div></div>
      </div>
      <div class="card">
        <b>Messages per day (last 14 days)</b>
        <div class="bar-chart">
          ${daily.map((d) => `
            <div class="bar-col">
              <div class="bars">
                <div class="bar in" style="height:${(d.inbound / maxDaily) * 100}%" title="${d.inbound} inbound"></div>
                <div class="bar out" style="height:${(d.outbound / maxDaily) * 100}%" title="${d.outbound} outbound"></div>
              </div>
              <div class="lbl">${d.day.slice(5)}</div>
            </div>`).join('') || '<div class="muted">No message activity yet</div>'}
        </div>
        <div class="legend">
          <span><span class="sw" style="background:var(--green)"></span>Inbound</span>
          <span><span class="sw" style="background:#53bdeb"></span>Outbound</span>
        </div>
      </div>
      <div class="card">
        <b>Open chats per teammate</b>
        <table class="table mt">
          <thead><tr><th>Teammate</th><th>Open chats</th></tr></thead>
          <tbody>${perAgent.map((a) => `<tr><td>${esc(a.name)}</td><td>${a.open_chats}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  // ---------- Settings ----------
  async function renderSettings($main) {
    const s = await api('/settings');
    $main.innerHTML = `<div class="page">
      <div class="page-header"><div><h2>Settings</h2><div class="sub">WhatsApp Cloud API & AI configuration</div></div></div>
      <div class="card">
        <h3 style="margin-bottom:12px">Mode</h3>
        <label style="display:flex;gap:8px;align-items:center">
          <input type="checkbox" id="st-sandbox" ${s.sandbox_mode ? 'checked' : ''}/>
          <b>Sandbox mode</b> — simulate WhatsApp locally (no Meta account needed). Uncheck to send via the real Cloud API.
        </label>
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px">WhatsApp Cloud API (live mode)</h3>
        <label class="field">Phone Number ID <input class="input" id="st-phoneid" value="${esc(s.wa_phone_number_id)}" placeholder="e.g. 123456789012345" /></label>
        <label class="field">WhatsApp Business Account (WABA) ID — needed for template sync <input class="input" id="st-wabaid" value="${esc(s.wa_waba_id)}" placeholder="e.g. 987654321098765" /></label>
        <label class="field">Access token ${s.wa_access_token_set ? '<span class="badge green">set</span>' : '<span class="badge gray">not set</span>'}
          <input class="input" id="st-token" type="password" placeholder="Paste a new token to replace" /></label>
        <label class="field">Webhook verify token <input class="input" id="st-verify" value="${esc(s.wa_verify_token)}" placeholder="Any secret string; also enter it in Meta's webhook config" /></label>
        <div class="muted">Point Meta's webhook to <span class="mono">https://your-domain/webhook/whatsapp</span></div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px">AI (Anthropic)</h3>
        <label class="field">Anthropic API key ${s.anthropic_api_key_set ? '<span class="badge green">set</span>' : '<span class="badge gray">not set — rule-based fallback in use</span>'}
          <input class="input" id="st-anthropic" type="password" placeholder="sk-ant-…" /></label>
      </div>
      <button class="btn" id="st-save">Save settings</button>
    </div>`;
    document.getElementById('st-save').addEventListener('click', async () => {
      try {
        await api('/settings', { method: 'PUT', body: {
          sandbox_mode: document.getElementById('st-sandbox').checked,
          wa_phone_number_id: document.getElementById('st-phoneid').value.trim(),
          wa_waba_id: document.getElementById('st-wabaid').value.trim(),
          wa_access_token: document.getElementById('st-token').value.trim() || undefined,
          wa_verify_token: document.getElementById('st-verify').value.trim(),
          anthropic_api_key: document.getElementById('st-anthropic').value.trim() || undefined,
        } });
        toast('Settings saved'); renderRoute();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- Router ----------
  const ROUTES = {
    inbox: renderInbox,
    contacts: renderContacts,
    broadcasts: renderBroadcasts,
    templates: renderTemplates,
    ai: renderAiAgents,
    team: renderTeam,
    analytics: renderAnalytics,
    settings: renderSettings,
  };

  let renderSeq = 0;
  async function renderRoute() {
    const $main = document.getElementById('main');
    if (!$main) return;
    const seq = ++renderSeq;
    const fn = ROUTES[state.route] || renderInbox;
    try {
      // Render into a detached check: only apply if still the latest render.
      if (seq !== renderSeq) return;
      await fn($main);
    } catch (err) {
      if (err.message !== 'Session expired') $main.innerHTML = `<div class="page"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  function onHashChange() {
    const route = location.hash.replace('#', '') || 'inbox';
    if (ROUTES[route]) state.route = route;
    if (!state.token) return renderLogin();
    renderShell();
    renderRoute();
  }

  function render() {
    if (!state.token) return renderLogin();
    connectEvents();
    onHashChange();
  }

  window.addEventListener('hashchange', onHashChange);
  render();
})();
