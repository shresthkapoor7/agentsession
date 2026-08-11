// Theme controls + timestamp/truncatable enhancement.
// (In the CLI build these live in a separate embedded script; the web viewer
//  needs them here so the command palette theme commands and local-time
//  formatting work.)
(function() {
  function getSystemTheme() {
    try { return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }
  function getStoredTheme() {
    try { var t = localStorage.getItem('theme'); return (t === 'light' || t === 'dark') ? t : null; }
    catch (e) { return null; }
  }
  function setStoredTheme(theme) {
    try { if (theme === 'light' || theme === 'dark') localStorage.setItem('theme', theme); else localStorage.removeItem('theme'); }
    catch (e) {}
  }
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }
  window.__ctTheme = {
    toggle: function() {
      var effective = getStoredTheme() || getSystemTheme();
      var next = effective === 'dark' ? 'light' : 'dark';
      setStoredTheme(next); applyTheme(next); return next;
    },
    system: function() { setStoredTheme(null); applyTheme(null); return 'system'; },
    effective: function() { return getStoredTheme() || getSystemTheme(); }
  };
  try { var stored = getStoredTheme(); if (stored) applyTheme(stored); } catch (e) {}

  function formatTimestamp(ts) {
    try { var d = new Date(ts); if (isNaN(d.getTime())) return ts; return d.toLocaleString(); }
    catch (e) { return ts; }
  }
  function updateTruncatables(scope) {
    (scope || document).querySelectorAll('.truncatable').forEach(function(el) {
      var content = el.querySelector('.truncatable-content');
      if (!content) return;
      if (content.scrollHeight > 240 && !el.classList.contains('expanded')) el.classList.add('truncated');
      var btn = el.querySelector('.expand-btn');
      if (!btn) return;
      btn.onclick = function() {
        el.classList.toggle('expanded');
        el.classList.toggle('truncated');
        btn.textContent = el.classList.contains('expanded') ? 'Show less' : 'Show more';
      };
    });
  }
  function enhance(root) {
    var scope = root || document;
    scope.querySelectorAll('time').forEach(function(t) {
      var iso = t.getAttribute('datetime') || t.getAttribute('data-timestamp') || t.textContent;
      if (iso) t.textContent = formatTimestamp(iso);
    });
    updateTruncatables(scope);
  }
  window.__codexTranscriptsEnhance = enhance;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function() { enhance(document); });
  else enhance(document);
})();

(function() {
  var meta = window.__CODEX_TRANSCRIPTS_META__;
  if (!meta) return;

  // Populated by chunk scripts:
  // window.__CODEX_TRANSCRIPTS__.chunks[chunkIndex] = [messageHtml, ...]
  var CT = window.__CODEX_TRANSCRIPTS__ = window.__CODEX_TRANSCRIPTS__ || {};
  CT.meta = meta;
  CT.chunks = CT.chunks || {};
  CT._chunkCallbacks = CT._chunkCallbacks || [];
  CT.registerChunk = function(chunkIndex, items) {
    CT.chunks[chunkIndex] = items;
    CT._chunkCallbacks.forEach(function(cb) {
      try { cb(chunkIndex); } catch (e) {}
    });
  };
  CT.onChunkLoaded = function(cb) {
    CT._chunkCallbacks.push(cb);
  };

  function isTextInputFocused() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function computeAssetPrefix() {
    var host = window.location.hostname;
    if (host !== 'gisthost.github.io' && host !== 'gistpreview.github.io') return '';

    var qs = window.location.search || '';
    var qm = qs.match(/^\?([a-f0-9]+)(?:\/|$)/i);
    if (qm) return '?' + qm[1] + '/';

    var parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length && /^[a-f0-9]+$/i.test(parts[0])) return '/' + parts[0] + '/';

    return '';
  }

  var assetPrefix = computeAssetPrefix();
  function assetUrl(rel) {
    rel = (rel || '').replace(/^\.\//, '');
    if (!assetPrefix) return rel;
    return assetPrefix + rel;
  }

  function chunkUrl(chunkIndex) {
    return assetUrl(meta.chunks[chunkIndex] || '');
  }

  function loadChunk(chunkIndex) {
    if (CT.chunks[chunkIndex]) return;
    CT._loadingChunks = CT._loadingChunks || {};
    if (CT._loadingChunks[chunkIndex]) return;
    CT._loadingChunks[chunkIndex] = true;

    var src = chunkUrl(chunkIndex);
    if (!src) return;
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = function() { CT._loadingChunks[chunkIndex] = false; };
    s.onerror = function() { CT._loadingChunks[chunkIndex] = false; };
    document.head.appendChild(s);
  }

  function getChunkIndexForItem(index) {
    return Math.floor(index / meta.chunk_size);
  }

  function ensureChunksForRange(startIndex, endIndex) {
    if (meta.total <= 0) return [];
    if (startIndex < 0) startIndex = 0;
    if (endIndex >= meta.total) endIndex = meta.total - 1;
    if (endIndex < startIndex) return [];
    var startChunk = getChunkIndexForItem(startIndex);
    var endChunk = getChunkIndexForItem(endIndex);
    var needed = [];
    for (var c = startChunk; c <= endChunk; c++) {
      needed.push(c);
      loadChunk(c);
    }
    return needed;
  }

  function getItemHtml(index) {
    var chunkIndex = getChunkIndexForItem(index);
    var chunk = CT.chunks[chunkIndex];
    if (!chunk) return null;
    var offset = index - (chunkIndex * meta.chunk_size);
    return chunk[offset] || null;
  }

  function waitForChunks(chunks) {
    chunks = chunks || [];
    if (!chunks.length) return Promise.resolve();
    var pending = {};
    chunks.forEach(function(c) { pending[c] = true; });
    chunks.forEach(function(c) { if (CT.chunks[c]) delete pending[c]; });
    if (!Object.keys(pending).length) return Promise.resolve();
    return new Promise(function(resolve) {
      var done = false;
      function check() {
        if (done) return;
        Object.keys(pending).forEach(function(k) {
          var c = parseInt(k, 10);
          if (CT.chunks[c]) delete pending[c];
        });
        if (!Object.keys(pending).length) {
          done = true;
          resolve();
        }
      }
      CT.onChunkLoaded(function() { check(); });
      check();
      setTimeout(check, 50);
      setTimeout(check, 250);
      setTimeout(check, 1000);
    });
  }

  function enhance(root) {
    if (typeof window.__codexTranscriptsEnhance === 'function') {
      window.__codexTranscriptsEnhance(root || document);
    }
  }

  function kindCharAt(i) {
    if (!meta.kinds || i < 0 || i >= meta.kinds.length) return 's';
    return meta.kinds.charAt(i) || 's';
  }

  function kindLabel(ch) {
    if (ch === 'u') return 'user';
    if (ch === 'a') return 'codex';
    if (ch === 't') return 'tool call';
    if (ch === 'r') return 'tool reply';
    if (ch === 's') return 'system';
    return 'system';
  }

  function clampIndex(idx) {
    if (idx < 0) idx = 0;
    if (idx > meta.total - 1) idx = meta.total - 1;
    return idx;
  }

  function findNextByKind(fromIndex, kindChar, direction) {
    var i = fromIndex;
    while (true) {
      i += direction;
      if (i < 0 || i > meta.total - 1) return null;
      if (kindCharAt(i) === kindChar) return i;
    }
  }

  function groupIndexForMessage(msgIndex) {
    var groups = meta.groups || [];
    var lo = 0;
    var hi = groups.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var g = groups[mid];
      var start = g.start | 0;
      var end = g.end | 0;
      if (msgIndex < start) hi = mid - 1;
      else if (msgIndex > end) lo = mid + 1;
      else return mid;
    }
    return null;
  }

  function getConversationEl(groupIndex) {
    return document.querySelector('.conversation[data-group-index="' + groupIndex + '"]');
  }

  function renderMessagesIncremental(container, startIdx, endIdx) {
    var BATCH = 40;
    var i = startIdx;
    container.innerHTML = '';
    function step() {
      var parts = [];
      for (var n = 0; n < BATCH && i <= endIdx; n++, i++) {
        var html = getItemHtml(i);
        if (html) parts.push(html);
      }
      if (parts.length) container.insertAdjacentHTML('beforeend', parts.join(''));
      if (i <= endIdx) {
        window.requestAnimationFrame(step);
      } else {
        enhance(container);
      }
    }
    window.requestAnimationFrame(step);
  }

  function loadConversation(groupIndex) {
    var el = getConversationEl(groupIndex);
    if (!el) return Promise.resolve(false);
    if (el.dataset.loaded === '1') return Promise.resolve(true);

    var start = parseInt(el.getAttribute('data-start') || '0', 10);
    var end = parseInt(el.getAttribute('data-end') || '0', 10);
    var container = document.getElementById('group-' + groupIndex);
    if (!container) return Promise.resolve(false);

    container.innerHTML = '<div class="conversation-loading">Loading…</div>';
    var chunks = ensureChunksForRange(start, end);
    return waitForChunks(chunks).then(function() {
      el.dataset.loaded = '1';
      renderMessagesIncremental(container, start, end);
      return true;
    });
  }

  // Master-detail: a conversation's full thread renders into the right-side pane.
  var pane, detailBody, detailRole, detailTime;
  var currentPaneGroup = -1;

  function groupCount() { return (meta.groups || []).length; }

  function indexForId(id) {
    if (!meta.ids || !meta.ids.length) return -1;
    for (var i = 0; i < meta.ids.length; i++) {
      if (meta.ids[i] === id) return i;
    }
    return -1;
  }

  function openConversation(gidx, focusMsgId) {
    if (gidx == null || gidx < 0 || gidx >= groupCount()) return Promise.resolve(false);
    var g = meta.groups[gidx];
    var start = g.start | 0;
    var end = g.end | 0;
    var chunks = ensureChunksForRange(start, end);
    return waitForChunks(chunks).then(function() {
      if (!detailBody) return false;
      var parts = [];
      for (var i = start; i <= end; i++) {
        var h = getItemHtml(i);
        if (h) parts.push(h);
      }
      detailBody.innerHTML = parts.length ? parts.join('') : '<div class="detail-empty">No content.</div>';
      enhance(detailBody);

      var card = getConversationEl(gidx);
      var summary = card ? card.querySelector('.conversation-summary') : null;
      var label = summary ? (summary.getAttribute('data-label') || '') : '';
      if (detailRole) detailRole.textContent = label || 'Conversation';
      if (detailTime) detailTime.textContent = (meta.ts && meta.ts[start]) ? meta.ts[start] : '';

      document.body.classList.add('detail-open');
      pane.setAttribute('aria-hidden', 'false');
      document.querySelectorAll('.conversation.detail-active').forEach(function(c) { c.classList.remove('detail-active'); });
      if (card) card.classList.add('detail-active');
      currentPaneGroup = gidx;
      setActiveGroup(gidx);

      detailBody.querySelectorAll('.message.detail-focus').forEach(function(m) { m.classList.remove('detail-focus'); });
      var target = focusMsgId ? detailBody.querySelector('[id="' + focusMsgId + '"]') : null;
      if (target) {
        target.classList.add('detail-focus');
        target.scrollIntoView({ block: 'center' });
      } else {
        detailBody.scrollTop = 0;
      }
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search + '#c' + gidx);
      } catch (e) {}
      return true;
    });
  }

  function closeDetail() {
    document.body.classList.remove('detail-open');
    if (pane) pane.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('.conversation.detail-active').forEach(function(c) { c.classList.remove('detail-active'); });
    currentPaneGroup = -1;
  }

  function handleHash() {
    if (!window.location.hash) return false;
    var h = window.location.hash.slice(1);
    if (!h) return false;
    var m = h.match(/^c(\d+)$/);
    if (m) { openConversation(parseInt(m[1], 10)); return true; }
    var idx = indexForId(h);
    if (idx >= 0) { openConversation(groupIndexForMessage(idx), h); return true; }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Side navigator: one tick per conversation. The active/hovered tick grows.
  // ---------------------------------------------------------------------------
  var sideTicks = [];
  var tickByGroup = {};
  var currentGroup = -1;

  function setActiveGroup(gidx) {
    if (gidx === currentGroup) return;
    currentGroup = gidx;
    for (var i = 0; i < sideTicks.length; i++) {
      sideTicks[i].classList.toggle('active', parseInt(sideTicks[i].dataset.groupIndex, 10) === gidx);
    }
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : text;
    return div.innerHTML;
  }

  function buildSideNav() {
    var nav = document.getElementById('side-nav');
    if (!nav) return;
    var convs = document.querySelectorAll('.conversation');
    if (convs.length < 2) { nav.style.display = 'none'; return; }
    sideTicks = [];
    tickByGroup = {};
    convs.forEach(function(d) {
      var gi = d.getAttribute('data-group-index');
      var summary = d.querySelector('.conversation-summary');
      var label = summary ? (summary.getAttribute('data-label') || '') : '';
      var preview = summary ? (summary.getAttribute('data-preview') || '') : '';
      var btn = document.createElement('button');
      btn.className = 'side-nav-tick';
      btn.type = 'button';
      btn.dataset.groupIndex = gi;
      btn.setAttribute('aria-label', label + ' ' + preview);
      btn.innerHTML =
        '<span class="side-nav-bar"></span>' +
        '<span class="side-nav-tip"><span class="side-nav-tip-label">' + escapeHtml(label) + '</span>' +
        (preview ? '<span class="side-nav-tip-text">' + escapeHtml(preview) + '</span>' : '') + '</span>';
      btn.addEventListener('click', function() {
        var g = parseInt(gi, 10);
        var card = getConversationEl(g);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      nav.appendChild(btn);
      sideTicks.push(btn);
      tickByGroup[gi] = btn;
    });

    setupSideNavScrollSpy();
  }

  function setupSideNavScrollSpy() {
    if (!document.querySelectorAll('.conversation').length) return;
    var ticking = false;

    // Highlight every conversation whose card overlaps a band near the top of the
    // viewport. Usually that's one turn; while scrolling across a boundary two turns
    // straddle the band and both light up (T3-style). Every turn passes through it,
    // so the rail reaches all of them. Cards are re-queried each frame so this stays
    // correct after the list is re-sorted.
    function update() {
      ticking = false;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var bandTop = vh * 0.22;
      var bandBottom = vh * 0.55;
      var convs = document.querySelectorAll('#conversations .conversation');
      var anyActive = false;
      var lastTick = null;
      for (var i = 0; i < convs.length; i++) {
        var tick = tickByGroup[convs[i].getAttribute('data-group-index')];
        if (!tick) continue;
        var rect = convs[i].getBoundingClientRect();
        var inBand = rect.bottom > bandTop && rect.top < bandBottom;
        tick.classList.toggle('active', inBand);
        if (inBand) anyActive = true;
        if (rect.bottom > 0 && rect.top < vh) lastTick = tick;
      }
      var atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      // Fallbacks: at the very bottom (or if nothing hit the band) keep the last
      // visible turn lit so the rail never goes fully dark.
      if ((atBottom || !anyActive) && lastTick) lastTick.classList.add('active');
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  // ---------------------------------------------------------------------------
  // Conversation filters: all checks are against compact per-group metadata, so
  // filtering never forces transcript chunks to load.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Sort conversations by a numeric field, ascending or descending. Reorders the
  // cards (and the matching side-nav ticks) in place — nothing is hidden.
  // ---------------------------------------------------------------------------
  function setupSort() {
    var container = document.getElementById('conversations');
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.sort-btn'));
    if (!container || !buttons.length) return;
    var state = { field: 'index', dir: 'asc' };

    function metric(gi, field) {
      if (field === 'index') return gi;
      var f = (meta.groups[gi] && meta.groups[gi].filters) || {};
      if (field === 'tokens') return f.token_count || 0;
      if (field === 'duration') return f.duration_ms || 0;
      if (field === 'tools') return f.tool_calls || 0;
      return gi;
    }

    function apply() {
      var cards = Array.prototype.slice.call(container.querySelectorAll('.conversation'));
      cards.sort(function(a, b) {
        var ga = parseInt(a.getAttribute('data-group-index'), 10);
        var gb = parseInt(b.getAttribute('data-group-index'), 10);
        var d = metric(ga, state.field) - metric(gb, state.field);
        if (d === 0) d = ga - gb; // stable tiebreak by original order
        return state.dir === 'asc' ? d : -d;
      });
      var nav = document.getElementById('side-nav');
      cards.forEach(function(card) {
        container.appendChild(card);
        var tick = tickByGroup[card.getAttribute('data-group-index')];
        if (nav && tick) nav.appendChild(tick);
      });
      buttons.forEach(function(btn) {
        var on = btn.getAttribute('data-field') === state.field;
        btn.classList.toggle('active', on);
        var caret = btn.querySelector('.sort-caret');
        if (caret) caret.textContent = on ? (state.dir === 'asc' ? '↑' : '↓') : '';
      });
    }

    buttons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var field = btn.getAttribute('data-field');
        if (state.field === field) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.field = field; state.dir = field === 'index' ? 'asc' : 'desc'; }
        apply();
      });
    });
    apply();
  }

  // ---------------------------------------------------------------------------
  // Command palette (Cmd/Ctrl-K): commands + live transcript search.
  // ---------------------------------------------------------------------------
  function setupCommandPalette() {
    var dlg = document.getElementById('cmdk');
    var input = document.getElementById('cmdk-input');
    var list = document.getElementById('cmdk-list');
    var trigger = document.getElementById('cmdk-trigger');
    if (!dlg || !input || !list) return;

    var items = [];       // selectable: { label, sub, hint, run }
    var selected = 0;
    var searchToken = 0;
    var debounceTimer = null;

    var SHORTCUTS = [
      ['n / j', 'next conversation'],
      ['p / k', 'previous conversation'],
      ['g / G', 'first / last conversation'],
      ['⌘K / Ctrl-K', 'open this menu'],
      ['?', 'keyboard shortcuts'],
      ['Esc', 'close menu / detail'],
    ];

    function commands() {
      var effective = (window.__ctTheme && window.__ctTheme.effective()) || 'dark';
      var nextTheme = effective === 'dark' ? 'light' : 'dark';
      var n = groupCount();
      return [
        { label: 'Keyboard shortcuts', hint: '?', run: showShortcuts, keep: true },
        { label: 'Toggle theme — switch to ' + nextTheme, hint: '', run: function() { if (window.__ctTheme) window.__ctTheme.toggle(); } },
        { label: 'Use system theme', hint: '', run: function() { if (window.__ctTheme) window.__ctTheme.system(); } },
        { label: 'Open first conversation', hint: 'g', run: function() { openConversation(0); } },
        { label: 'Open last conversation', hint: 'G', run: function() { openConversation(n - 1); } },
      ];
    }

    function open(prefill) {
      if (!dlg.open) dlg.showModal();
      input.value = prefill || '';
      render(input.value);
      requestAnimationFrame(function() { input.focus(); input.select(); });
    }
    function close() { if (dlg.open) dlg.close(); }

    function setSelected(i) {
      if (!items.length) return;
      selected = (i + items.length) % items.length;
      var rows = list.querySelectorAll('.cmdk-item');
      rows.forEach(function(r, idx) {
        var on = idx === selected;
        r.classList.toggle('selected', on);
        if (on) r.scrollIntoView({ block: 'nearest' });
      });
    }

    function renderList(sections) {
      // sections: [{ title, items: [...] }]
      items = [];
      var html = '';
      sections.forEach(function(sec) {
        if (!sec.items.length) return;
        html += '<div class="cmdk-section-title">' + escapeHtml(sec.title) + '</div>';
        sec.items.forEach(function(it) {
          var i = items.length;
          items.push(it);
          html += '<div class="cmdk-item" role="option" data-i="' + i + '">' +
            '<div class="cmdk-item-main">' +
              '<div class="cmdk-item-label">' + (it.labelHtml || escapeHtml(it.label)) + '</div>' +
              (it.sub ? '<div class="cmdk-item-sub">' + it.sub + '</div>' : '') +
            '</div>' +
            (it.hint ? '<kbd class="cmdk-item-hint">' + escapeHtml(it.hint) + '</kbd>' : '') +
          '</div>';
        });
      });
      if (!items.length) html = '<div class="cmdk-empty">No matches</div>';
      list.innerHTML = html;
      selected = 0;
      setSelected(0);
    }

    function render(q) {
      q = (q || '').trim();
      var cmds = commands();
      var filtered = q ? cmds.filter(function(c) { return c.label.toLowerCase().indexOf(q.toLowerCase()) !== -1; }) : cmds;
      var sections = [{ title: 'Commands', items: filtered }, { title: 'Transcript', items: [] }];
      renderList(sections);
      if (q) liveSearch(q);
    }

    function showShortcuts() {
      var html = '<div class="cmdk-section-title">Keyboard shortcuts</div>';
      html += '<div class="cmdk-shortcuts">';
      SHORTCUTS.forEach(function(s) {
        html += '<div class="cmdk-shortcut"><kbd>' + escapeHtml(s[0]) + '</kbd><span>' + escapeHtml(s[1]) + '</span></div>';
      });
      html += '</div><div class="cmdk-empty">Type to search · Esc to close</div>';
      list.innerHTML = html;
      items = [];
    }

    function snippetFromHtml(html, q) {
      try {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('.message-meta').forEach(function(m) { m.remove(); });
        var msg = tmp.querySelector('.message');
        var text = (msg ? msg.textContent : tmp.textContent) || '';
        text = text.replace(/\s+/g, ' ').trim();
        var lower = text.toLowerCase();
        var qi = lower.indexOf(q.toLowerCase());
        if (qi < 0) return escapeHtml(text.slice(0, 140)) + (text.length > 140 ? '…' : '');
        var start = Math.max(0, qi - 40);
        var end = Math.min(text.length, qi + q.length + 70);
        var pre = text.slice(start, qi);
        var hit = text.slice(qi, qi + q.length);
        var post = text.slice(qi + q.length, end);
        return (start > 0 ? '…' : '') + escapeHtml(pre) + '<mark>' + escapeHtml(hit) + '</mark>' + escapeHtml(post) + (end < text.length ? '…' : '');
      } catch (e) {
        return escapeHtml(String(html).slice(0, 140));
      }
    }

    function yieldToUI() {
      return new Promise(function(resolve) { requestAnimationFrame(function() { resolve(); }); });
    }

    async function liveSearch(query) {
      var q = (query || '').trim();
      var token = ++searchToken;
      if (q.length < 2) return;

      var qLower = q.toLowerCase();
      var results = [];
      var MAX = 40;
      var totalChunks = (meta.chunks || []).length;

      for (var c = 0; c < totalChunks && results.length < MAX; c++) {
        loadChunk(c);
        await waitForChunks([c]);
        if (token !== searchToken) return; // superseded by newer keystroke
        var chunkItems = CT.chunks[c] || [];
        for (var i = 0; i < chunkItems.length && results.length < MAX; i++) {
          var idx = c * meta.chunk_size + i;
          var html = chunkItems[i] || '';
          if (!html || html.toLowerCase().indexOf(qLower) === -1) continue;
          var id = meta.ids && meta.ids[idx] ? meta.ids[idx] : '';
          var k = kindLabel(kindCharAt(idx));
          var ts = meta.ts && meta.ts[idx] ? meta.ts[idx] : '';
          results.push({
            label: k.toUpperCase() + ' · ' + ts,
            sub: snippetFromHtml(html, q),
            run: (function(ix, mid) { return function() { openConversation(groupIndexForMessage(ix), mid); }; })(idx, id),
          });
        }
        if (token !== searchToken) return;
        await yieldToUI();
      }
      if (token !== searchToken) return;

      var cmds = commands();
      var filtered = q ? cmds.filter(function(cc) { return cc.label.toLowerCase().indexOf(qLower) !== -1; }) : cmds;
      renderList([{ title: 'Commands', items: filtered }, { title: 'Transcript · ' + results.length + (results.length >= MAX ? '+' : '') + ' match(es)', items: results }]);
    }

    function activate(i) {
      var it = items[i];
      if (!it) return;
      if (it.keep) { it.run(); return; } // keep palette open (e.g. shortcuts view)
      close();
      it.run();
    }

    // Events
    if (trigger) trigger.addEventListener('click', function() { open(''); });

    input.addEventListener('input', function() {
      if (debounceTimer) clearTimeout(debounceTimer);
      var v = input.value;
      // Commands render immediately; transcript search is debounced.
      var cmds = commands();
      var q = v.trim();
      var filtered = q ? cmds.filter(function(c) { return c.label.toLowerCase().indexOf(q.toLowerCase()) !== -1; }) : cmds;
      renderList([{ title: 'Commands', items: filtered }, { title: 'Transcript', items: [] }]);
      debounceTimer = setTimeout(function() { if (q) liveSearch(q); }, 130);
    });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(selected + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(selected - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); activate(selected); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    list.addEventListener('click', function(e) {
      var row = e.target && e.target.closest ? e.target.closest('.cmdk-item') : null;
      if (!row) return;
      activate(parseInt(row.getAttribute('data-i'), 10));
    });
    list.addEventListener('mousemove', function(e) {
      var row = e.target && e.target.closest ? e.target.closest('.cmdk-item') : null;
      if (!row) return;
      setSelected(parseInt(row.getAttribute('data-i'), 10));
    });

    dlg.addEventListener('click', function(e) {
      if (e.target === dlg) close();
    });
    dlg.addEventListener('close', function() { input.value = ''; });

    // Global open shortcut.
    document.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (dlg.open) close(); else open('');
      }
    });

    // Expose so the '?' handler can open directly to shortcuts.
    CT.openShortcuts = function() { open(''); showShortcuts(); };
    CT.openPalette = function() { open(''); };
  }

  // ---------------------------------------------------------------------------
  // Keyboard navigation (between conversations)
  // ---------------------------------------------------------------------------
  function setupKeyboard() {
    document.addEventListener('keydown', function(e) {
      if (e.defaultPrevented) return;

      if (e.key === 'Escape' && document.body.classList.contains('detail-open') && !isTextInputFocused()) {
        e.preventDefault();
        closeDetail();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextInputFocused()) return;

      var n = groupCount();
      if (!n) return;
      var cur = currentPaneGroup;

      if (e.key === '?') { e.preventDefault(); if (CT.openShortcuts) CT.openShortcuts(); return; }
      if (e.key === 'n' || e.key === 'j') { e.preventDefault(); openConversation(cur < 0 ? 0 : Math.min(n - 1, cur + 1)); return; }
      if (e.key === 'p' || e.key === 'k') { e.preventDefault(); openConversation(cur < 0 ? 0 : Math.max(0, cur - 1)); return; }
      if (e.key === 'g') { e.preventDefault(); openConversation(0); return; }
      if (e.key === 'G') { e.preventDefault(); openConversation(n - 1); return; }
    });
  }

  // ---------------------------------------------------------------------------
  // Detail pane wiring: click a conversation card to open its full thread.
  // ---------------------------------------------------------------------------
  function setupDetailPane() {
    pane = document.getElementById('detail-pane');
    detailBody = document.getElementById('detail-body');
    detailRole = document.getElementById('detail-role');
    detailTime = document.getElementById('detail-time');
    var closeBtn = document.getElementById('detail-close');
    if (!pane || !detailBody) return;

    if (closeBtn) closeBtn.addEventListener('click', closeDetail);

    // Click a conversation card -> open its full thread in the pane.
    document.addEventListener('click', function(e) {
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('.detail-pane, .cmdk, .side-nav')) return;
      var summary = e.target.closest('.conversation-summary');
      if (!summary) return;
      if (e.target.closest('a')) return; // let links inside the prompt work
      e.preventDefault(); // don't toggle the <details> open inline
      var d = summary.closest('.conversation');
      if (!d) return;
      var gidx = parseInt(d.getAttribute('data-group-index') || '0', 10);
      // Clicking the already-open conversation closes the preview.
      if (document.body.classList.contains('detail-open') && gidx === currentPaneGroup) {
        closeDetail();
        return;
      }
      openConversation(gidx);
    });

    // Timestamp permalinks inside the pane scroll within the pane.
    detailBody.addEventListener('click', function(e) {
      var a = e.target && e.target.closest ? e.target.closest('a.timestamp-link') : null;
      if (!a) return;
      e.preventDefault();
      var id = (a.getAttribute('href') || '').slice(1);
      if (!id) return;
      var t = detailBody.querySelector('[id="' + id + '"]');
      if (t) t.scrollIntoView({ block: 'center' });
    });

    CT.closeDetail = closeDetail;
    CT.openConversation = openConversation;
  }

  function init() {
    if (!meta || !meta.total) return;

    loadChunk(0);
    enhance(document);

    buildSideNav();
    setupSort();
    setupDetailPane();
    setupCommandPalette();
    setupKeyboard();

    handleHash();
    window.addEventListener('hashchange', handleHash);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
