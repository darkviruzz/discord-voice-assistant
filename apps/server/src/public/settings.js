/* Settings-Panel — vollständig dynamisch aus GET /transcript/config.
 *
 * Es gibt KEINE hier gepflegte Variablenliste: Der Server liefert den Katalog
 * (Gruppen, Labels, Beschreibungen, Typen, applyModes, Secret-/Status-Flags,
 * Bot-Ist-Werte), dieses Modul rendert ihn 1:1 und schickt Änderungen per PUT
 * zurück. Neue Einstellungen entstehen ausschließlich durch einen Eintrag in
 * apps/server/src/configCatalog.js (bot-scope zusätzlich in der BOT_KEYS-
 * Whitelist des Bots) — sie erscheinen dann automatisch in diesem Panel.
 *
 * Bot-Werte: `botReported` markiert echte Ist-Werte (vom Bot via config_state
 * gemeldet); `desired` zeigt Drift zwischen gespeichertem Wunsch und Ist an
 * (z. B. applyMode reconnect/restart noch nicht angewendet). Secrets kommen
 * grundsätzlich ohne Wert (nur „gesetzt?"), erzwungen durch die server-seitige
 * Namens-Blacklist — auch hier gibt es nichts zu konfigurieren.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  const body = $('settings-body');
  const botline = $('settings-botline');
  const resultEl = $('settings-result');
  const dirtyChip = $('settings-dirty');
  const saveBtn = $('settings-save');
  const filterEl = $('settings-filter');

  let data = null;                 // letzte GET-Antwort
  const pending = new Map();       // `scope:key` → { scope, key, value } | { scope, key, reset:true }

  const configUrl = () => `${location.pathname.replace(/\/[^/]*$/, '')}/config`;

  const APPLY_CLASS = {
    live: 'apply--live',
    'next-session': 'apply--session',
    'next-finalize': 'apply--finalize',
    reconnect: 'apply--reconnect',
    restart: 'apply--restart',
  };
  const STATUS_META = {
    default: { label: 'Standard', cls: 'st--default', title: 'Unverändert (aus .env bzw. Code-Default)' },
    persisted: { label: 'persistiert', cls: 'st--persisted', title: 'Im Override-Layer — übersteht Neustart' },
    temporary: { label: 'temporär', cls: 'st--temp', title: 'Nur zur Laufzeit — weg bei Neustart' },
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function persistMode() {
    const el = document.querySelector('input[name="persist"]:checked');
    return el ? el.value === 'persist' : true;
  }

  // ── Laden + Kopfzeile ───────────────────────────────────────────────────────
  async function load() {
    body.innerHTML = '<p class="empty">Lade Konfiguration…</p>';
    resultEl.hidden = true;
    pending.clear();
    updateDirty();
    try {
      const res = await fetch(configUrl(), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      renderBotline();
      renderBody();
    } catch (e) {
      body.innerHTML = `<p class="empty">Konfiguration nicht ladbar: ${esc(e.message)}</p>`;
    }
  }

  function renderBotline() {
    if (!data) { botline.textContent = ''; return; }
    const n = data.botConnected || 0;
    const parts = [];
    if (n > 0) {
      parts.push(`<span class="chip chip--ok">Bot verbunden (${n})</span>`);
      if (data.botReportedAt) {
        const age = Math.max(0, Math.round((Date.now() - data.botReportedAt) / 1000));
        parts.push(`<span class="botline-note">Ist-Konfiguration gemeldet vor ${age}s</span>`);
      } else {
        parts.push('<span class="botline-note">noch kein Ist-Stand gemeldet</span>');
      }
    } else {
      parts.push('<span class="chip chip--warn">kein Bot verbunden</span>');
      parts.push('<span class="botline-note">Bot-Änderungen werden gespeichert und beim nächsten Connect angewendet</span>');
    }
    parts.push(`<span class="botline-file" title="Override-Datei des Servers">${esc(data.overridesFile || '')}</span>`);
    botline.innerHTML = parts.join(' ');
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function applyBadge(mode) {
    const am = data.applyModes?.[mode];
    if (!am) return '';
    return `<span class="badge ${APPLY_CLASS[mode] || ''}" title="${esc(am.desc)}">${esc(am.label)}</span>`;
  }
  function statusBadge(item) {
    const st = STATUS_META[item.status] || STATUS_META.default;
    return `<span class="badge ${st.cls}" title="${st.title}">${st.label}</span>`;
  }

  function widgetFor(item) {
    const id = `cfg-${item.scope}-${item.key}`;
    if (item.secret) {
      const stat = item.isSet === null ? 'unbekannt' : item.isSet ? 'gesetzt' : 'nicht gesetzt';
      const cls = item.isSet === null ? 'chip--muted' : item.isSet ? 'chip--ok' : 'chip--warn';
      return `<span class="chip ${cls}">🔒 ${stat}</span>`
        + '<span class="secret-note">Secret — Änderung nur über .env + Neustart</span>';
    }
    const dis = item.editable ? '' : ' disabled';
    if (item.type === 'boolean') {
      const on = String(item.value) === String(item.onValue);
      return `<label class="switch"><input type="checkbox" id="${id}" data-scope="${item.scope}" data-key="${esc(item.key)}"${on ? ' checked' : ''}${dis} /><span class="slider"></span></label>`;
    }
    if (item.type === 'enum') {
      const opts = (item.enumValues || []).map((v) =>
        `<option value="${esc(v)}"${String(item.value) === String(v) ? ' selected' : ''}>${esc(v)}</option>`).join('');
      return `<select id="${id}" data-scope="${item.scope}" data-key="${esc(item.key)}"${dis}>${opts}</select>`;
    }
    const type = item.type === 'number' ? 'number' : 'text';
    const step = item.type === 'number' ? ' step="any"' : '';
    return `<input type="${type}"${step} id="${id}" data-scope="${item.scope}" data-key="${esc(item.key)}" value="${esc(item.value ?? '')}"${dis} />`;
  }

  function itemRow(item) {
    const drift = item.desired !== undefined
      ? `<div class="drift" title="Gespeicherter Wunsch weicht vom gemeldeten Ist-Wert des Bots ab — greift gemäß Wirkungs-Badge (z. B. nach Reconnect/Neustart).">⏳ gewünscht: <code>${esc(item.desired)}</code></div>`
      : '';
    const src = item.scope === 'bot' && !item.secret
      ? (item.botReported
        ? '<span class="badge src--live" title="Vom Bot gemeldeter Ist-Wert">Ist (Bot)</span>'
        : '<span class="badge src--desired" title="Kein Bot-Report — angezeigt wird der gespeicherte Wunschwert bzw. Default">Wunsch</span>')
      : '';
    const note = item.note ? `<div class="note">⚠ ${esc(item.note)}</div>` : '';
    const resetBtn = item.editable && item.status !== 'default'
      ? `<button class="btn btn--reset" data-scope="${item.scope}" data-key="${esc(item.key)}" title="Auf .env-/Code-Default zurücksetzen">↺</button>`
      : '';
    return `<div class="s-item" data-search="${esc(`${item.key} ${item.label} ${item.desc}`.toLowerCase())}">
      <div class="s-item-head">
        <span class="s-label">${esc(item.label)}</span>
        <code class="s-key">${esc(item.key)}</code>
        ${applyBadge(item.applyMode)} ${statusBadge(item)} ${src}
      </div>
      <div class="s-desc">${esc(item.desc)}</div>
      ${note}
      <div class="s-control">${widgetFor(item)} ${resetBtn} ${drift}</div>
    </div>`;
  }

  function renderBody() {
    const groups = data.groups || [];
    const html = [];
    // Legende (Scopes + Wirkungsweisen) aus den Server-Metadaten.
    html.push('<details class="s-legend"><summary>Legende: Scopes & Wirkung</summary><dl>');
    for (const [k, v] of Object.entries(data.scopes || {})) {
      html.push(`<dt>${esc(v.label || k)}</dt><dd>${esc(v.desc || '')}</dd>`);
    }
    for (const [k, v] of Object.entries(data.applyModes || {})) {
      html.push(`<dt><span class="badge ${APPLY_CLASS[k] || ''}">${esc(v.label)}</span></dt><dd>${esc(v.desc)}</dd>`);
    }
    html.push('</dl></details>');
    for (const g of groups) {
      html.push(`<section class="s-group" data-scope="${esc(g.scope)}">`);
      html.push(`<h3>${esc(g.name)}</h3>`);
      for (const item of g.items) html.push(itemRow(item));
      html.push('</section>');
    }
    body.innerHTML = html.join('');
    bindInputs();
    applyFilter();
  }

  // ── Dirty-Tracking + Speichern ─────────────────────────────────────────────
  function findItem(scope, key) {
    for (const g of data.groups || []) {
      for (const it of g.items) if (it.scope === scope && it.key === key) return it;
    }
    return null;
  }
  function updateDirty() {
    const n = pending.size;
    dirtyChip.hidden = n === 0;
    dirtyChip.textContent = `${n} Änderung${n === 1 ? '' : 'en'}`;
    saveBtn.disabled = n === 0;
  }
  function markChange(scope, key, value) {
    const item = findItem(scope, key);
    if (!item) return;
    const id = `${scope}:${key}`;
    const loaded = item.type === 'boolean'
      ? String(item.value) === String(item.onValue)
      : String(item.value ?? '');
    const now = item.type === 'boolean' ? value : String(value);
    if (String(now) === String(loaded)) pending.delete(id);
    else {
      pending.set(id, {
        scope, key,
        value: item.type === 'boolean' ? (value ? item.onValue : item.offValue) : String(value),
      });
    }
    updateDirty();
  }

  function bindInputs() {
    for (const el of body.querySelectorAll('input[data-key], select[data-key]')) {
      const scope = el.dataset.scope;
      const key = el.dataset.key;
      const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        markChange(scope, key, el.type === 'checkbox' ? el.checked : el.value);
      });
    }
    for (const btn of body.querySelectorAll('.btn--reset')) {
      btn.addEventListener('click', () => {
        const id = `${btn.dataset.scope}:${btn.dataset.key}`;
        const active = btn.classList.toggle('btn--active');
        if (active) pending.set(id, { scope: btn.dataset.scope, key: btn.dataset.key, reset: true });
        else pending.delete(id);
        updateDirty();
      });
    }
  }

  async function save() {
    if (!pending.size) return;
    const updates = [];
    const resets = [];
    for (const p of pending.values()) {
      if (p.reset) resets.push({ scope: p.scope, key: p.key });
      else updates.push({ scope: p.scope, key: p.key, value: p.value });
    }
    saveBtn.disabled = true;
    try {
      const res = await fetch(configUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persist: persistMode(), updates, resets }),
      });
      const out = await res.json();
      const lines = [];
      if (out.applied?.length) {
        lines.push(`<div class="ok">✓ ${out.applied.length} Änderung(en) angewendet`
          + `${out.botPushed ? ` · an ${out.botPushed} Bot(s) gepusht` : ''}</div>`);
      }
      for (const w of out.warnings || []) lines.push(`<div class="warn">⚠ ${esc(w)}</div>`);
      for (const e of out.errors || []) lines.push(`<div class="err">✗ ${esc(e)}</div>`);
      resultEl.innerHTML = lines.join('') || '<div class="warn">Keine Änderungen angewendet.</div>';
      resultEl.hidden = false;
      // Ist-Stand neu laden (Statusbadges, Bot-Report, Drift).
      await load();
      resultEl.hidden = lines.length === 0;
    } catch (e) {
      resultEl.innerHTML = `<div class="err">✗ Speichern fehlgeschlagen: ${esc(e.message)}</div>`;
      resultEl.hidden = false;
      saveBtn.disabled = false;
    }
  }

  // ── Filter ─────────────────────────────────────────────────────────────────
  function applyFilter() {
    const q = filterEl.value.trim().toLowerCase();
    for (const sec of body.querySelectorAll('.s-group')) {
      let any = false;
      for (const row of sec.querySelectorAll('.s-item')) {
        const hit = !q || row.dataset.search.includes(q);
        row.hidden = !hit;
        if (hit) any = true;
      }
      sec.hidden = !any;
    }
  }

  // ── Öffnen/Schließen ───────────────────────────────────────────────────────
  function open() {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('settings-overlay--open'));
    if (!data) load();
    else renderBotline();
  }
  function close() {
    overlay.classList.remove('settings-overlay--open');
    setTimeout(() => { overlay.hidden = true; }, 250);
  }

  $('open-settings').addEventListener('click', open);
  $('settings-close').addEventListener('click', close);
  $('settings-reload').addEventListener('click', load);
  saveBtn.addEventListener('click', save);
  filterEl.addEventListener('input', applyFilter);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
})();
