// Settings-Panel: lädt den Konfigurations-Katalog von /transcript/config,
// rendert alle Variablen mit Doku + Persistenz-/Wirkungs-Badges und schickt
// Änderungen (dauerhaft oder temporär) per PUT zurück.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  const body = $('settings-body');
  const legendEl = $('settings-legend');
  const resultEl = $('settings-result');
  const dirtyChip = $('settings-dirty');
  const saveBtn = $('settings-save');
  const filterEl = $('settings-filter');

  let data = null;                 // letzte GET-Antwort
  const pending = new Map();       // key `scope:key` → { scope, key, value } | { scope, key, reset:true }

  // Basis-Pfad wie in app.js: aus /transcript/ (oder /transcript/index.html)
  // wird /transcript → Endpunkt /transcript/config.
  const configUrl = () => `${location.pathname.replace(/\/[^/]*$/, '')}/config`;

  // Farb-/Text-Zuordnung der applyMode-Badges.
  const APPLY_CLASS = {
    live: 'apply--live',
    'next-session': 'apply--session',
    'next-finalize': 'apply--finalize',
    reconnect: 'apply--reconnect',
    restart: 'apply--restart',
  };
  const STATUS_META = {
    default: { label: 'Standard', cls: 'st--default', title: 'Unverändert (aus .env bzw. Code-Default)' },
    persisted: { label: 'persistiert', cls: 'st--persisted', title: 'Im Override-Layer gespeichert — übersteht Neustart' },
    temporary: { label: 'temporär', cls: 'st--temp', title: 'Nur zur Laufzeit gesetzt — geht bei Neustart verloren' },
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function persistMode() {
    const el = document.querySelector('input[name="persist"]:checked');
    return el ? el.value : 'persist';
  }

  async function load() {
    body.innerHTML = '<p class="empty">Lade Konfiguration…</p>';
    resultEl.hidden = true;
    pending.clear();
    updateDirty();
    try {
      const res = await fetch(configUrl(), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) {
      body.innerHTML = `<p class="empty err">Konnte Konfiguration nicht laden: ${esc(e.message)}</p>`;
      return;
    }
    renderLegend();
    render();
  }

  function renderLegend() {
    const modes = data.applyModes || {};
    const parts = ['<details class="legend-details"><summary>Legende & Erklärungen (Wirkung · Persistenz · Scopes)</summary><div class="legend-grid">'];
    parts.push('<div class="legend-block"><b>Wirkung (wann greift eine Änderung):</b><ul>');
    for (const [k, m] of Object.entries(modes)) {
      parts.push(`<li><span class="apply ${APPLY_CLASS[k] || ''}">${esc(m.label)}</span> ${esc(m.desc)}</li>`);
    }
    parts.push('</ul></div>');
    parts.push('<div class="legend-block"><b>Persistenz:</b><ul>'
      + '<li><span class="st st--persisted">persistiert</span> im Override-Layer gespeichert (Variante B), übersteht Neustart.</li>'
      + '<li><span class="st st--temp">temporär</span> nur zur Laufzeit gesetzt, geht bei Neustart verloren.</li>'
      + '<li><span class="st st--default">Standard</span> unverändert (Wert aus .env bzw. Code-Default).</li>'
      + '</ul></div>');
    const scopes = data.scopes || {};
    parts.push('<div class="legend-block"><b>Scopes:</b><ul>');
    for (const [k, s] of Object.entries(scopes)) {
      parts.push(`<li><span class="scope scope--${esc(k)}">${esc(s.label)}</span> ${esc(s.desc)}</li>`);
    }
    parts.push('</ul></div>');
    parts.push(`<p class="legend-file">Override-Datei (Server): <code>${esc(data.overridesFile)}</code> · `
      + 'Bot-Overrides liegen im DATA_DIR des jeweiligen Bots.</p>');
    parts.push('</div></details>');
    legendEl.innerHTML = parts.join('');
  }

  function widgetFor(item) {
    const id = `cfg_${item.scope}_${item.key}`;
    if (!item.editable) {
      if (item.secret) {
        if (item.isSet === null) return '<span class="secret-status unknown" title="Der Server-Prozess kennt Bot-Secrets nicht">Status im Bot</span>';
        return `<span class="secret-status ${item.isSet ? 'is-set' : 'not-set'}">${item.isSet ? '•••••• gesetzt' : 'nicht gesetzt'}</span>`;
      }
      return `<span class="ro-value">${esc(item.value)}</span>`;
    }
    if (item.type === 'boolean') {
      const on = String(item.value) === String(item.onValue);
      return `<label class="switch"><input type="checkbox" id="${id}" data-scope="${item.scope}" data-key="${esc(item.key)}" ${on ? 'checked' : ''}/><span>${on ? 'an' : 'aus'}</span></label>`;
    }
    if (item.type === 'enum') {
      const opts = item.enumValues.map((v) => `<option value="${esc(v)}" ${String(v) === String(item.value) ? 'selected' : ''}>${esc(v)}</option>`).join('');
      return `<select id="${id}" data-scope="${item.scope}" data-key="${esc(item.key)}">${opts}</select>`;
    }
    const type = item.type === 'number' ? 'number' : 'text';
    const ph = item.type === 'list' ? 'kommagetrennt' : '';
    return `<input type="${type}" id="${id}" data-scope="${item.scope}" data-key="${esc(item.key)}" value="${esc(item.value)}" placeholder="${esc(ph)}" ${item.type === 'number' ? 'step="any"' : ''}/>`;
  }

  function itemRow(item) {
    const mode = (data.applyModes && data.applyModes[item.applyMode]) || { label: item.applyMode };
    const st = STATUS_META[item.status] || STATUS_META.default;
    const badges = [
      `<span class="scope scope--${item.scope}">${esc((data.scopes[item.scope] || {}).label || item.scope)}</span>`,
      `<span class="apply ${APPLY_CLASS[item.applyMode] || ''}" title="${esc(mode.desc || '')}">${esc(mode.label)}</span>`,
      `<span class="st ${st.cls}" title="${esc(st.title)}">${esc(st.label)}</span>`,
    ];
    if (!item.editable) badges.push(`<span class="st st--lock" title="nicht editierbar">${item.secret ? '🔒 Secret' : '🔒 read-only'}</span>`);
    const note = item.note ? `<p class="cfg-note">⚠ ${esc(item.note)}</p>` : '';
    const def = item.editable && !item.secret ? `<span class="cfg-def" title="Default">def: <code>${esc(item.def)}</code></span>` : '';
    const reset = item.editable ? `<button class="btn-reset" data-scope="${item.scope}" data-key="${esc(item.key)}" title="Auf .env/Default zurücksetzen (entfernt Override)">↺ reset</button>` : '';
    return `<div class="cfg-item" data-scope="${item.scope}" data-key="${esc(item.key)}" data-search="${esc((item.label + ' ' + item.key + ' ' + item.desc).toLowerCase())}">
        <div class="cfg-main">
          <div class="cfg-label">${esc(item.label)} <code class="cfg-key">${esc(item.key)}</code></div>
          <div class="cfg-badges">${badges.join('')}</div>
          <p class="cfg-desc">${esc(item.desc)}</p>
          ${note}
        </div>
        <div class="cfg-control">
          ${widgetFor(item)}
          <div class="cfg-meta">${def} ${reset}</div>
        </div>
      </div>`;
  }

  function render() {
    const groups = data.groups || [];
    const html = groups.map((g) => {
      const rows = g.items.map(itemRow).join('');
      return `<section class="cfg-group" data-scope="${g.scope}">
          <h3 class="cfg-group-title"><span class="scope scope--${g.scope}">${esc((data.scopes[g.scope] || {}).label || g.scope)}</span> ${esc(g.name)}</h3>
          ${rows}
        </section>`;
    }).join('');
    body.innerHTML = html || '<p class="empty">Keine Variablen.</p>';
    applyFilter();
    updateDirty();
    refreshRowStates();
  }

  // Markiert Zeilen mit ausstehender Änderung.
  function refreshRowStates() {
    body.querySelectorAll('.cfg-item').forEach((row) => {
      const key = `${row.dataset.scope}:${row.dataset.key}`;
      row.classList.toggle('is-dirty', pending.has(key));
    });
  }

  function setPending(scope, key, entry) {
    const k = `${scope}:${key}`;
    if (entry == null) pending.delete(k);
    else pending.set(k, entry);
    updateDirty();
    refreshRowStates();
  }

  function updateDirty() {
    const n = pending.size;
    dirtyChip.hidden = n === 0;
    dirtyChip.textContent = `${n} Änderung${n === 1 ? '' : 'en'}`;
    saveBtn.disabled = n === 0;
    updateOpenBadge();
  }

  // Findet den Original-Wert einer Variable aus dem letzten GET (für Dirty-Vergleich).
  function originalValue(scope, key) {
    for (const g of (data.groups || [])) {
      for (const it of g.items) if (it.scope === scope && it.key === key) return it;
    }
    return null;
  }

  function onInputChange(e) {
    const el = e.target;
    const scope = el.dataset.scope;
    const key = el.dataset.key;
    if (!scope || !key) return;
    const item = originalValue(scope, key);
    if (!item) return;
    let value;
    if (item.type === 'boolean') {
      value = el.checked ? item.onValue : item.offValue;
      const span = el.parentElement.querySelector('span');
      if (span) span.textContent = el.checked ? 'an' : 'aus';
    } else {
      value = el.value;
    }
    // Unverändert gegenüber dem geladenen Wert → Pending entfernen.
    if (String(value) === String(item.value)) setPending(scope, key, null);
    else setPending(scope, key, { scope, key, value });
  }

  function onReset(scope, key) {
    setPending(scope, key, { scope, key, reset: true });
  }

  async function save() {
    const persist = persistMode() === 'persist';
    const updates = [];
    const resets = [];
    for (const p of pending.values()) {
      if (p.reset) resets.push({ scope: p.scope, key: p.key });
      else updates.push({ scope: p.scope, key: p.key, value: p.value });
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichere…';
    let out;
    try {
      const res = await fetch(configUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persist, updates, resets }),
      });
      out = await res.json();
    } catch (e) {
      showResult(false, ['Netzwerkfehler: ' + e.message], [], []);
      saveBtn.textContent = 'Änderungen anwenden';
      return;
    }
    saveBtn.textContent = 'Änderungen anwenden';
    showResult(out.ok, out.errors || [], out.warnings || [], out.applied || []);
    // Neu laden, um Status-Badges (persistiert/temporär) zu aktualisieren —
    // dabei die Scrollposition beibehalten (sonst springt es nach ganz oben).
    const scrollTop = body.scrollTop;
    await load();
    body.scrollTop = scrollTop;
  }

  function showResult(ok, errors, warnings, applied) {
    const parts = [];
    if (applied.length) {
      parts.push(`<p class="res-ok">✔ ${applied.length} Änderung(en) angewendet.</p>`);
    }
    if (warnings.length) parts.push('<ul class="res-warn">' + warnings.map((w) => `<li>⚠ ${esc(w)}</li>`).join('') + '</ul>');
    if (errors.length) parts.push('<ul class="res-err">' + errors.map((w) => `<li>✕ ${esc(w)}</li>`).join('') + '</ul>');
    resultEl.innerHTML = parts.join('') || '<p class="res-ok">Keine Änderungen.</p>';
    resultEl.hidden = false;
    resultEl.className = 'settings-result ' + (errors.length ? 'has-err' : ok ? 'has-ok' : '');
  }

  function applyFilter() {
    const q = (filterEl.value || '').trim().toLowerCase();
    body.querySelectorAll('.cfg-item').forEach((row) => {
      const hit = !q || (row.dataset.search || '').includes(q);
      row.style.display = hit ? '' : 'none';
    });
    body.querySelectorAll('.cfg-group').forEach((sec) => {
      const anyVisible = Array.from(sec.querySelectorAll('.cfg-item')).some((r) => r.style.display !== 'none');
      sec.style.display = anyVisible ? '' : 'none';
    });
  }

  const panel = () => overlay.querySelector('.settings-panel');
  let closingTimer = null;

  function open() {
    if (closingTimer) { clearTimeout(closingTimer); closingTimer = null; }
    overlay.classList.remove('closing');
    overlay.hidden = false;
    document.body.classList.add('settings-open');
    // Nur beim ersten Öffnen laden. Danach bleiben nicht angewendete Änderungen
    // erhalten (Slide-in), bis sie angewendet oder verworfen werden.
    if (!data) load();
    updateOpenBadge();
    updateNarrow();
  }
  // Schließen mit Slide-out-Animation (Gegenstück zum Einblenden). Nicht
  // angewendete Änderungen bleiben erhalten.
  function close() {
    if (overlay.hidden || overlay.classList.contains('closing')) return;
    overlay.classList.add('closing');
    closingTimer = setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove('closing');
      document.body.classList.remove('settings-open');
      closingTimer = null;
      updateOpenBadge(); // roter Badge weist im geschlossenen Zustand auf offene Änderungen hin
    }, 180);
  }
  function toggle() { overlay.hidden ? open() : close(); }

  // Roter Badge am Zahnrad-Button: Anzahl nicht angewendeter Änderungen, nur
  // solange das Panel geschlossen ist.
  function updateOpenBadge() {
    const btn = $('open-settings');
    if (!btn) return;
    let dot = btn.querySelector('.open-badge');
    const n = pending.size;
    const show = n > 0 && overlay.hidden;
    if (show) {
      if (!dot) { dot = document.createElement('span'); dot.className = 'open-badge'; btn.appendChild(dot); }
      dot.textContent = String(n);
    } else if (dot) {
      dot.remove();
    }
  }

  // Unter 900px Panelbreite die zweispaltigen Grids auf eine Spalte umstellen
  // (basiert auf der PANELBREITE, nicht der Viewportbreite — das Panel ist ziehbar).
  function updateNarrow() {
    const p = panel();
    if (p) p.classList.toggle('narrow', p.clientWidth < 900);
  }

  // Breite ziehbar (Griff am linken Panelrand), Wert in localStorage gemerkt.
  const WIDTH_KEY = 'settingsPanelWidth';
  const clampWidth = (w) => Math.max(320, Math.min(w, window.innerWidth));
  function applySavedWidth() {
    const w = parseInt(localStorage.getItem(WIDTH_KEY) || '', 10);
    if (Number.isFinite(w)) overlay.style.width = clampWidth(w) + 'px';
  }
  (function initResize() {
    const handle = $('settings-resize');
    if (!handle) return;
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch {}
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      overlay.style.width = clampWidth(window.innerWidth - e.clientX) + 'px';
      updateNarrow();
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      localStorage.setItem(WIDTH_KEY, String(parseInt(overlay.style.width, 10) || ''));
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  })();
  applySavedWidth();
  if (window.ResizeObserver) {
    const p = panel();
    if (p) new ResizeObserver(updateNarrow).observe(p);
  }

  // --- Events ---
  $('open-settings')?.addEventListener('click', toggle);
  $('settings-close')?.addEventListener('click', close);
  $('settings-reload')?.addEventListener('click', () => load());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  // Klick neben das Panel schließt es (nicht-destruktiv — Änderungen bleiben).
  document.addEventListener('mousedown', (e) => {
    if (overlay.hidden || overlay.classList.contains('closing')) return;
    if (overlay.contains(e.target) || $('open-settings')?.contains(e.target)) return;
    close();
  });
  filterEl.addEventListener('input', applyFilter);
  saveBtn.addEventListener('click', save);

  // Delegation für dynamisch gerenderte Widgets.
  body.addEventListener('change', onInputChange);
  body.addEventListener('input', (e) => { if (e.target.matches('input[type="text"],input[type="number"]')) onInputChange(e); });
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-reset');
    if (btn) onReset(btn.dataset.scope, btn.dataset.key);
  });
})();
