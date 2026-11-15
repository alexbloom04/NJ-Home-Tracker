/* NJ Home Tracker: client-side dashboard over the JSON produced by scripts/build.py */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const PAGE = 60;

  // Towns selected by default. Other towns stay in the list to add. Names are matched ignoring case
  // and a trailing "Twp"/"Township", so "Warren" also covers "Warren Twp".
  const MY_TOWNS = [
    'Short Hills', 'Millburn', 'Scotch Plains', 'Summit', 'New Providence', 'Chatham', 'Madison',
    'Florham Park', 'Berkeley Heights', 'Stirling', 'Watchung', 'Warren', 'Basking Ridge', 'Bernards',
    'Bernardsville', 'Cedar Knolls', 'Whippany', 'Morris Plains', 'Parsippany', 'Parsippany Troy Hills',
    'Par Troy Hills', 'East Hanover', 'Hanover', 'Livingston', 'Fairfield',
  ];
  const townNorm = (c) => String(c || '').toLowerCase().replace(/\s+(township|twp)\.?$/, '').trim();
  const MY_TOWN_SET = new Set(MY_TOWNS.map(townNorm));
  // Spellings of one town grouped under one tag in the towns bar
  const TOWN_ALIASES = { 'parsippany troy hills': 'parsippany', 'par troy hills': 'parsippany' };
  const townGroup = (city) => TOWN_ALIASES[townNorm(city)] || townNorm(city);
  const MY_TOWN_NAME = new Map();
  MY_TOWNS.forEach((t) => { if (!MY_TOWN_NAME.has(townGroup(t))) MY_TOWN_NAME.set(townGroup(t), t); });

  const S = {
    defaultTowns: new Set(),
    homes: [], towns: [], changes: [], history: [], meta: {}, details: {}, byId: new Map(),
    filtered: [], view: 'houses', mode: 'grid', shown: PAGE, sort: 'recent',
    tableSort: null, townSort: { key: 'active', dir: -1 }, changeType: 'all',
    map: null, cluster: null, charts: {},
  };
  const DEFAULT_F = () => ({
    st: new Set(), towns: new Set(S.defaultTowns), scMin: '', scMax: '', scKeepUnknown: true,
    lpMin: '600000', lpMax: '850000', spMin: '600000', spMax: '999999', sdFrom: '', bedsMin: '', bathsMin: '', sqftMin: '', domMax: '', type: '',
  });
  let F = DEFAULT_F();

  const STATUS = { A: 'Available', P: 'Under contract', S: 'Sold' };
  const CHANGE = {
    new: 'New listing', pending: 'Went under contract', sold: 'Sold',
    price: 'Price change', back: 'Back on market',
  };

  // ------------------------------------------------------------ formatting
  const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
  const shortMoney = (n) => {
    if (n == null) return '—';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + n;
  };
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const date = (s) => {
    if (!s) return '—';
    const d = new Date(s + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const median = (xs) => {
    const a = xs.filter((x) => x != null && x > 0).sort((p, q) => p - q);
    if (!a.length) return null;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const ppsf = (h) => (h.sqft && (h.st === 'S' ? h.sp || h.lp : h.lp) ? Math.round((h.st === 'S' ? h.sp || h.lp : h.lp) / h.sqft) : null);
  const townKey = (h) => `${h.city}|${h.county}`;
  const slug = (s) => (s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  const activity = (h) => (h.st === 'S' ? h.sd : h.st === 'P' ? h.pd || h.fs : h.ld || h.fs) || '';
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Listing data comes from a third party: only allow https (and inline sample data:image) URLs,
  // and percent-encode characters that could break out of a CSS url("...") or an HTML attribute.
  // Realtor.com sends photo links as http://, so upgrade those to https:// instead of dropping them.
  const safeUrl = (u) => {
    if (typeof u !== 'string') return null;
    const s = u.trim().replace(/^http:\/\//i, 'https://');
    return /^(https:\/\/|data:image\/)/i.test(s) ? s : null;
  };
  // Single quotes: the result goes inside a double-quoted style="..." attribute.
  const cssUrl = (u) => (safeUrl(u) ? `background-image:url('${safeUrl(u).replace(/["'()\\\s<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase())}')` : '');
  const fullAddr = (h) => [h.addr, h.unit && `Unit ${h.unit}`].filter(Boolean).join(' ');

  // ------------------------------------------------------------ favorites
  // Saved in this browser only (localStorage), so they stay private and cost nothing.
  // Each entry keeps the address so a saved home that drops out of the data can still be listed.
  const FAV_STORE = 'njFavs';
  let FAVS = {};
  const isFav = (id) => Object.prototype.hasOwnProperty.call(FAVS, id);
  function loadFavs() {
    try {
      const v = JSON.parse(localStorage.getItem(FAV_STORE) || '{}');
      FAVS = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { FAVS = {}; }
  }
  function saveFavs() {
    try { localStorage.setItem(FAV_STORE, JSON.stringify(FAVS)); } catch { /* storage unavailable */ }
  }
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5l-1.3-1.2C5.6 14.7 2.5 11.9 2.5 8.4 2.5 5.6 4.7 3.5 7.4 3.5c1.6 0 3.2.8 4.1 2 .9-1.2 2.5-2 4.1-2 2.7 0 4.9 2.1 4.9 4.9 0 3.5-3.1 6.3-8.2 10.9L12 20.5z"/></svg>';
  const favLabel = (on) => (on ? 'Remove from favorites' : 'Add to favorites');
  const favBtn = (id) => `<button class="fav${isFav(id) ? ' on' : ''}" data-fav="${esc(id)}" aria-pressed="${isFav(id)}" aria-label="${favLabel(isFav(id))}" title="${favLabel(isFav(id))}">${HEART}</button>`;
  function toggleFav(id) {
    if (isFav(id)) delete FAVS[id];
    else {
      const h = S.byId.get(id);
      FAVS[id] = { addr: h ? fullAddr(h) : '', city: h?.city || '', t: Date.now() };
    }
    saveFavs();
    const on = isFav(id);
    $$('[data-fav]').filter((b) => b.dataset.fav === id).forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
      b.setAttribute('aria-label', favLabel(on));
      b.title = favLabel(on);
    });
    updateFavCount();
    if (S.view === 'favorites') renderFavorites();
  }
  function updateFavCount() {
    const n = Object.keys(FAVS).length;
    $('#favCount').textContent = n ? `(${n})` : '';
  }

  // ------------------------------------------------------------ data
  // Data files are AES-GCM encrypted (scripts/vault.py) when data/crypto.json exists.
  let KEY = null;
  const KEY_STORE = 'njKey';
  const CHECK = 'nj-home-tracker';
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

  async function decryptText(key, bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12));
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  async function deriveKey(password, meta) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(meta.salt), iterations: meta.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }

  async function keyWorks(key, meta) {
    try { return (await decryptText(key, b64(meta.check))) === CHECK; } catch { return false; }
  }

  async function unlock(meta) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY_STORE) || 'null');
      if (saved && saved.salt === meta.salt) {
        const key = await crypto.subtle.importKey('raw', b64(saved.key), 'AES-GCM', true, ['decrypt']);
        if (await keyWorks(key, meta)) return key;
      }
    } catch { /* storage unavailable or stale key */ }

    document.body.classList.add('locked');
    $('#lock').hidden = false;
    $('#lockPw').focus();
    return new Promise((resolve) => {
      $('#lockForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#lockForm button');
        btn.disabled = true;
        btn.textContent = 'Unlocking…';
        $('#lockErr').hidden = true;
        const key = await deriveKey($('#lockPw').value, meta);
        if (await keyWorks(key, meta)) {
          if ($('#lockRemember').checked) {
            try {
              const raw = await crypto.subtle.exportKey('raw', key);
              localStorage.setItem(KEY_STORE, JSON.stringify({ salt: meta.salt, key: toB64(raw) }));
            } catch { /* ignore */ }
          }
          $('#lock').hidden = true;
          document.body.classList.remove('locked');
          resolve(key);
        } else {
          $('#lockErr').hidden = false;
          $('#lockPw').select();
        }
        btn.disabled = false;
        btn.textContent = 'Unlock';
      });
    });
  }

  async function getJSON(path, fallback) {
    try {
      const r = await fetch(KEY ? path.replace(/\.json$/, '.bin') : path, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      if (KEY) return JSON.parse(await decryptText(KEY, await r.arrayBuffer()));
      return await r.json();
    } catch (e) {
      console.warn('Could not load', path, e);
      return fallback;
    }
  }

  async function init() {
    applyStoredTheme();
    let cryptoMeta = null;
    try {
      const r = await fetch('data/crypto.json', { cache: 'no-cache' });
      if (r.ok) cryptoMeta = await r.json();
    } catch { /* not encrypted (local preview / sample data) */ }
    if (cryptoMeta) {
      KEY = await unlock(cryptoMeta);
      $('#lockBtn').hidden = false;
    }
    let [homes, towns, changes, history, meta] = await Promise.all([
      getJSON('data/listings.json', []), getJSON('data/towns.json', []), getJSON('data/changes.json', []),
      getJSON('data/history.json', []), getJSON('data/meta.json', {}),
    ]);
    // Show only homes whose current status started within recent_days (the build does this too;
    // repeating it here applies the window to data built before that setting existed).
    const days = meta.recent_days || 180;
    const ref = meta.updated ? new Date(meta.updated + 'T12:00:00') : new Date();
    const cut = new Date(ref - days * 864e5).toISOString().slice(0, 10);
    const when = (h) => (h.st === 'S' ? h.sd : h.st === 'P' ? h.pd : h.ld || h.fs);
    homes = homes.filter((h) => !when(h) || when(h) >= cut);
    // "New" = listed within new_days. Older builds also flagged homes the tracker had only just
    // started seeing, so recompute from the listing date where there is one.
    const newCut = new Date(ref - (meta.new_days || 7) * 864e5).toISOString().slice(0, 10);
    homes.forEach((h) => { if (h.st === 'A' && h.ld) h.new = h.ld >= newCut ? 1 : 0; });
    Object.assign(S, { homes, towns, changes, history, meta });
    homes.forEach((h) => { h.img = safeUrl(h.img); S.byId.set(h.id, h); });
    S.defaultTowns = new Set(homes.filter((h) => MY_TOWN_SET.has(townNorm(h.city))).map(townKey));
    changes.forEach((e) => { e.img = safeUrl(e.img); });
    S.townInfo = new Map(towns.map((t) => [`${t.town}|${t.county}`, t]));

    $('#updated').textContent = meta.updated
      ? `Updated ${date(meta.updated)} · ${num(homes.length)} homes from the last ${Math.round(days / 30)} months · ${(meta.counties || []).length} counties`
      : 'No data yet';
    $('#sampleBanner').hidden = !meta.sample;

    const types = [...new Set(homes.map((h) => h.type).filter(Boolean))].sort();
    $('#typeSel').insertAdjacentHTML('beforeend', types.map((t) => `<option value="${esc(t)}">${esc(prettyType(t))}</option>`).join(''));

    loadFavs();
    updateFavCount();
    readHash();
    buildTownList();
    bindUI();
    syncInputs();
    render();
  }

  const prettyType = (t) => String(t).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // ------------------------------------------------------------ filters
  function matches(h, ignoreTown = false, ignoreStatus = false) {
    if (!ignoreStatus) {
      // Statuses are multi-select: a home shows if it matches any selected one (none selected = all)
      if (F.st.size && !(F.st.has(h.st) || (F.st.has('new') && h.new))) return false;
    }
    if (!ignoreTown && F.towns.size && !F.towns.has(townKey(h))) return false;
    if (h.sc == null) {
      if (!F.scKeepUnknown && (F.scMin || F.scMax)) return false;
    } else {
      if (F.scMin && h.sc < +F.scMin) return false;
      if (F.scMax && h.sc > +F.scMax) return false;
    }
    // List price range applies to available and under-contract homes; sold price range to sold homes
    if (h.st === 'S') {
      if (F.spMin && !(h.sp >= +F.spMin)) return false;
      if (F.spMax && !(h.sp <= +F.spMax)) return false;
    } else {
      if (F.lpMin && !(h.lp >= +F.lpMin)) return false;
      if (F.lpMax && !(h.lp <= +F.lpMax)) return false;
    }
    if (F.sdFrom && !((h.sd || '') >= F.sdFrom)) return false;
    if (F.bedsMin && !(h.beds >= +F.bedsMin)) return false;
    if (F.bathsMin && !(h.baths >= +F.bathsMin)) return false;
    if (F.sqftMin && !(h.sqft >= +F.sqftMin)) return false;
    if (F.domMax && !(h.dom != null && h.dom <= +F.domMax)) return false;
    if (F.type && h.type !== F.type) return false;
    return true;
  }

  const STATUS_KEYS = ['new', 'A', 'P', 'S'];
  const PRICE_FIELDS =['lpMin', 'lpMax', 'spMin', 'spMax'];
  const FIELDS = ['scMin', 'scMax', 'lpMin', 'lpMax', 'spMin', 'spMax', 'sdFrom', 'bedsMin', 'bathsMin', 'sqftMin', 'domMax'];

  const isDefaultTowns = () => F.towns.size === S.defaultTowns.size && [...F.towns].every((k) => S.defaultTowns.has(k));

  function writeHash() {
    const p = new URLSearchParams();
    if (S.view !== 'houses') p.set('view', S.view);
    if (F.st.size) p.set('st', [...F.st].join(','));
    // No "towns" in the link = your default towns; "towns=all" = every town
    if (!isDefaultTowns()) p.set('towns', F.towns.size ? [...F.towns].join(';') : 'all');
    // Only store fields that differ from the defaults (an empty value means "cleared")
    const D = DEFAULT_F();
    FIELDS.forEach((k) => F[k] !== D[k] && p.set(k, F[k]));
    if (!F.scKeepUnknown) p.set('scKeep', '0');
    if (F.type) p.set('type', F.type);
    if (S.sort !== 'recent') p.set('sort', S.sort);
    if (S.mode !== 'grid') p.set('mode', S.mode);
    history.replaceState(null, '', p.toString() ? '#' + p : location.pathname + location.search);
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    F = DEFAULT_F();
    if (p.get('st')) F.st = new Set(p.get('st').split(',').filter((s) => STATUS_KEYS.includes(s)));
    if (p.get('towns') === 'all') F.towns = new Set();
    else if (p.get('towns')) F.towns = new Set(p.get('towns').split(';'));
    FIELDS.forEach((k) => p.has(k) && (F[k] = p.get(k)));
    F.scKeepUnknown = p.get('scKeep') !== '0';
    F.type = p.get('type') || '';
    S.sort = p.get('sort') || 'recent';
    S.mode = p.get('mode') || 'grid';
    S.view = p.get('view') || 'houses';
  }

  function syncInputs() {
    FIELDS.forEach((k) => ($('#' + k).value = F[k]));
    $('#scKeepUnknown').checked = F.scKeepUnknown;
    $('#typeSel').value = F.type;
    $('#sortSel').value = S.sort;
    $$('#statusChips button').forEach((b) => {
      const on = b.dataset.st === 'all' ? !F.st.size : F.st.has(b.dataset.st);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
    $$('#townList input').forEach((i) => (i.checked = F.towns.has(i.value)));
    updateTownCount();
  }

  function buildTownList() {
    const counts = new Map();
    S.homes.forEach((h) => counts.set(townKey(h), (counts.get(townKey(h)) || 0) + 1));
    const byCounty = {};
    [...counts.keys()].forEach((k) => {
      const [town, county] = k.split('|');
      (byCounty[county] ||= []).push(town);
    });
    $('#townList').innerHTML = Object.keys(byCounty).sort().map((county) => `
      <div class="county-group" data-county="${esc(county)}">
        <div class="county">${esc(county)} County <button class="link" data-all="${esc(county)}">all</button></div>
        ${byCounty[county].sort().map((t) => {
          const k = `${t}|${county}`;
          return `<label data-name="${esc(t.toLowerCase())}"><input type="checkbox" value="${esc(k)}"> ${esc(t || 'Unknown')}<span class="n">${counts.get(k)}</span></label>`;
        }).join('')}
      </div>`).join('');
  }

  function updateTownCount() {
    $('#townCount').textContent = F.towns.size ? `(${F.towns.size} selected)` : '';
  }

  // ------------------------------------------------------------ UI events
  function bindUI() {
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#statusChips').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const s = b.dataset.st;
      if (s === 'all') F.st.clear();
      else if (F.st.has(s)) F.st.delete(s);
      else F.st.add(s);
      changed();
    });
    FIELDS.forEach((k) => $('#' + k).addEventListener('input', debounce(() => { F[k] = $('#' + k).value; changed(); }, 250)));
    $('#scKeepUnknown').addEventListener('change', (e) => { F.scKeepUnknown = e.target.checked; changed(); });
    $('#typeSel').addEventListener('change', (e) => { F.type = e.target.value; changed(); });
    $('#sortSel').addEventListener('change', (e) => { S.sort = e.target.value; S.tableSort = null; changed(); });
    $$('.seg button').forEach((b) => b.addEventListener('click', () => { S.mode = b.dataset.mode; changed(); }));
    $('#townList').addEventListener('change', (e) => {
      if (e.target.type !== 'checkbox') return;
      e.target.checked ? F.towns.add(e.target.value) : F.towns.delete(e.target.value);
      changed();
    });
    $('#townList').addEventListener('click', (e) => {
      const county = e.target.dataset?.all;
      if (!county) return;
      e.preventDefault();
      const boxes = $$(`.county-group[data-county="${CSS.escape(county)}"] label:not([hidden]) input`);
      const allOn = boxes.every((b) => F.towns.has(b.value));
      boxes.forEach((b) => (allOn ? F.towns.delete(b.value) : F.towns.add(b.value)));
      changed();
    });
    $('#townSearch').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('#townList label').forEach((l) => (l.hidden = q && !l.dataset.name.includes(q)));
      $$('#townList .county-group').forEach((g) => (g.hidden = !$$('label:not([hidden])', g).length));
    });
    $('#clearTowns').addEventListener('click', () => { F.towns.clear(); changed(); });
    $('#myTowns').addEventListener('click', () => { F.towns = new Set(S.defaultTowns); changed(); });
    $('#townBar').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm-town]');
      if (rm) {
        [...F.towns].forEach((k) => townGroup(k.split('|')[0]) === rm.dataset.rmTown && F.towns.delete(k));
        changed();
        return;
      }
      const b = e.target.closest('[data-towns]');
      if (b) {
        F.towns = b.dataset.towns === 'my' ? new Set(S.defaultTowns) : new Set();
        changed();
        return;
      }
      const pb = e.target.closest('[data-prices]');
      if (pb) {
        const D = DEFAULT_F();
        PRICE_FIELDS.forEach((k) => (F[k] = pb.dataset.prices === 'my' ? D[k] : ''));
        changed();
      }
    });
    $('#resetFilters').addEventListener('click', () => { F = DEFAULT_F(); changed(); });
    $('#loadMore').addEventListener('click', () => { S.shown += PAGE; renderHouses(); });
    $('#filtersToggle').addEventListener('click', () => $('#filters').classList.toggle('open'));
    $('#themeToggle').addEventListener('click', toggleTheme);
    $('#lockBtn').addEventListener('click', () => {
      try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
      location.reload();
    });
    $('#kpis').addEventListener('click', (e) => {
      const k = e.target.closest('.kpi[data-st]');
      if (!k) return;
      F.st = new Set([k.dataset.st]);
      setView('houses');
      changed();
    });
    $('#changeChips').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.changeType = b.dataset.ct;
      $$('#changeChips button').forEach((x) => x.classList.toggle('active', x === b));
      renderChanges();
    });
    document.addEventListener('click', (e) => {
      const fb = e.target.closest('[data-fav]');
      if (fb) {
        e.preventDefault();
        toggleFav(fb.dataset.fav);
        return;
      }
      const el = e.target.closest('[data-id]');
      if (el && !e.target.closest('dialog')) {
        e.preventDefault();
        openDetail(el.dataset.id);
      }
    });
    $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') $('#detail').close(); });
    window.addEventListener('hashchange', () => { readHash(); syncInputs(); render(); });
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function changed() {
    S.shown = PAGE;
    syncInputs();
    writeHash();
    render();
  }

  function setView(v) {
    S.view = v;
    writeHash();
    render();
  }

  // ------------------------------------------------------------ render
  function render() {
    S.filtered = S.homes.filter((h) => matches(h));
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
    $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + S.view));
    document.body.classList.toggle('no-filters', S.view === 'favorites');
    renderTownBar();
    renderKPIs();
    if (S.view === 'houses') renderHouses();
    if (S.view === 'towns') renderTowns();
    if (S.view === 'map') renderMap();
    if (S.view === 'market') renderMarket();
    if (S.view === 'changes') renderChanges();
    if (S.view === 'favorites') renderFavorites();
  }

  function renderFavorites() {
    const ids = Object.keys(FAVS).sort((a, b) => (FAVS[b].t || 0) - (FAVS[a].t || 0));
    const here = ids.filter((id) => S.byId.has(id));
    const gone = ids.filter((id) => !S.byId.has(id));
    $('#favGrid').innerHTML = here.length
      ? here.map((id) => cardHTML(S.byId.get(id))).join('')
      : gone.length ? '' : '<div class="empty">No favorites yet. Tap the heart on any home to save it here.</div>';
    $('#favGone').innerHTML = gone.length ? `
      <div class="day">No longer in the data</div>
      <p class="muted small">These homes dropped out of the listings (for example, sold more than ${S.meta.sold_days || 180} days ago). They'll reappear here if they come back.</p>
      ${gone.map((id) => `<div class="change"><div><div class="what">${esc(FAVS[id].addr || 'Unknown address')}</div><div class="where">${esc(FAVS[id].city || '')}</div></div><span style="margin-left:auto">${favBtn(id)}</span></div>`).join('')}` : '';
  }

  // Always-visible summary of the town filter, one tag per town (spelling variants grouped)
  function renderTownBar() {
    const bar = $('#townBar');
    bar.hidden = S.view === 'favorites';
    if (bar.hidden) return;
    const groups = new Map();
    [...F.towns].forEach((k) => {
      const city = k.split('|')[0];
      const g = townGroup(city);
      if (!groups.has(g)) groups.set(g, { name: MY_TOWN_NAME.get(g) || city, cities: [] });
      groups.get(g).cities.push(city);
    });
    const list = [...groups].sort((a, b) => a[1].name.localeCompare(b[1].name));
    const mine = isDefaultTowns();
    const label = !F.towns.size ? 'Showing all towns' : `${mine ? 'My towns' : 'Selected towns'} (${list.length})`;
    const range = (a, b) => (a && b ? `${money(+a)}–${money(+b)}` : a ? `${money(+a)} and up` : b ? `up to ${money(+b)}` : null);
    const lpR = range(F.lpMin, F.lpMax);
    const spR = range(F.spMin, F.spMax);
    const prices = [lpR && `Available &amp; under contract <b>${lpR}</b>`, spR && `Sold <b>${spR}</b>`].filter(Boolean);
    const D = DEFAULT_F();
    const myPrices = PRICE_FIELDS.every((k) => F[k] === D[k]);
    bar.innerHTML = `<div class="tb-row"><span class="tb-label">${label}</span>
      ${list.map(([g, v]) => `<span class="tchip" title="${esc(v.cities.join(', '))}">${esc(v.name)}<button data-rm-town="${esc(g)}" aria-label="Remove ${esc(v.name)}" title="Remove ${esc(v.name)}">×</button></span>`).join('')}
      <span class="tb-actions">
        ${mine ? '' : '<button class="link" data-towns="my">Use my towns</button>'}
        ${F.towns.size ? '<button class="link" data-towns="all">Show all towns</button>' : ''}
      </span></div>
      <div class="tb-row"><span class="tb-label">Prices</span>
      <span class="tb-prices">${prices.length ? prices.join(' · ') : 'Any price'}</span>
      <span class="tb-actions">
        ${myPrices ? '' : '<button class="link" data-prices="my">Use my prices</button>'}
        ${prices.length ? '<button class="link" data-prices="any">Any price</button>' : ''}
      </span></div>`;
  }

  function renderKPIs() {
    const base = S.homes.filter((h) => matches(h, false, true));
    const act = base.filter((h) => h.st === 'A');
    const sold = base.filter((h) => h.st === 'S');
    const ratios = sold.filter((h) => h.sp && h.lp).map((h) => h.sp / h.lp);
    const stl = ratios.length ? (ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100 : null;
    const tiles = [
      { st: 'A', label: 'Available', dot: '--st-A', value: num(act.length), sub: `median ${shortMoney(median(act.map((h) => h.lp)))}` },
      { st: 'new', label: `New (${S.meta.new_days || 7} days)`, dot: '--new', value: num(base.filter((h) => h.new).length), sub: 'just listed' },
      { st: 'P', label: 'Under contract', dot: '--st-P', value: num(base.filter((h) => h.st === 'P').length), sub: `median list ${shortMoney(median(base.filter((h) => h.st === 'P').map((h) => h.lp)))}` },
      { st: 'S', label: `Sold (${S.meta.sold_days || 180} days)`, dot: '--st-S', value: num(sold.length), sub: `median ${shortMoney(median(sold.map((h) => h.sp)))}` },
      { label: 'Sale-to-list', value: stl ? stl.toFixed(1) + '%' : '—', sub: stl ? (stl >= 100 ? 'selling over asking' : 'selling under asking') : '' },
      { label: 'Median days on market', value: num(median(act.map((h) => h.dom))), sub: 'available homes' },
    ];
    $('#kpis').innerHTML = tiles.map((t) => `
      <div class="kpi" ${t.st ? `data-st="${t.st}" role="button" tabindex="0"` : ''}>
        <div class="label">${t.dot ? `<span class="dot" style="background:var(${t.dot})"></span>` : ''}${t.label}</div>
        <div class="value">${t.value}</div>
        <div class="sub">${t.sub}</div>
      </div>`).join('');
  }

  const SORTS = {
    recent: (a, b) => activity(b).localeCompare(activity(a)),
    'lp-asc': (a, b) => (a.lp ?? 1e12) - (b.lp ?? 1e12),
    'lp-desc': (a, b) => (b.lp ?? 0) - (a.lp ?? 0),
    'sp-desc': (a, b) => (b.sp ?? 0) - (a.sp ?? 0),
    'sd-desc': (a, b) => (b.sd || '').localeCompare(a.sd || ''),
    'sc-desc': (a, b) => (b.sc ?? 0) - (a.sc ?? 0),
    'dom-asc': (a, b) => (a.dom ?? 1e9) - (b.dom ?? 1e9),
    'ppsf-asc': (a, b) => (ppsf(a) ?? 1e9) - (ppsf(b) ?? 1e9),
  };

  function statusBadge(h) {
    const label = h.st === 'P' && /contingent/i.test(h.sub || '') ? 'Contingent' : STATUS[h.st];
    return `<span class="badge"><span class="dot" style="background:var(--st-${h.st})"></span>${label}</span>`;
  }

  function cardHTML(h) {
    const price = h.st === 'S'
      ? `${money(h.sp ?? h.lp)} <small>sold ${date(h.sd)}</small>`
      : `${money(h.lp)}${h.st === 'P' ? ' <small>list price</small>' : ''}`;
    const extra = h.st === 'S'
      ? `List ${shortMoney(h.lp)}${h.sp && h.lp ? ` · ${((h.sp / h.lp) * 100).toFixed(0)}% of list` : ''}`
      : h.st === 'P'
        ? `Under contract ${h.pd ? 'since ' + date(h.pd) : ''}`
        : `Listed ${date(h.ld || h.fs)}`;
    return `
      <article class="card" data-id="${esc(h.id)}">
        <div class="photo" style="${cssUrl(h.img)}">
          ${h.img ? '' : '<div class="no-photo">No photo</div>'}
          <div class="badges">${statusBadge(h)}${h.new ? '<span class="badge new">NEW</span>' : ''}${h.drop ? `<span class="badge drop">▼ ${shortMoney(h.drop)}</span>` : ''}</div>
          ${favBtn(h.id)}
        </div>
        <div class="info">
          <div class="price">${price}</div>
          <div class="facts">${h.beds ?? '—'} bd · ${h.baths ?? '—'} ba · ${num(h.sqft)} sqft</div>
          <div class="addr" title="${esc(fullAddr(h))}">${esc(fullAddr(h))}, ${esc(h.city)}</div>
          <div class="meta"><span>${extra}</span><span title="School score (1–10)">School <span class="sc">${h.sc ?? '—'}</span></span></div>
        </div>
      </article>`;
  }

  const HOUSE_COLS = [
    { k: 'fav', t: '♥', f: (h) => favBtn(h.id), v: (h) => (isFav(h.id) ? 1 : 0), n: 1 },
    { k: 'st', t: 'Status', f: (h) => statusBadge(h), v: (h) => h.st },
    { k: 'addr', t: 'Address', f: (h) => esc(fullAddr(h)), v: (h) => h.addr || '' },
    { k: 'city', t: 'Town', f: (h) => esc(h.city), v: (h) => h.city },
    { k: 'lp', t: 'List price', n: 1, f: (h) => money(h.lp) },
    { k: 'sp', t: 'Sold price', n: 1, f: (h) => money(h.sp) },
    { k: 'sd', t: 'Sold date', f: (h) => (h.sd ? date(h.sd) : ''), v: (h) => h.sd || '' },
    { k: 'pd', t: 'Under contract', f: (h) => (h.st === 'P' && h.pd ? date(h.pd) : ''), v: (h) => h.pd || '' },
    { k: 'ld', t: 'Listed', f: (h) => date(h.ld), v: (h) => h.ld || '' },
    { k: 'beds', t: 'Beds', n: 1, f: (h) => h.beds ?? '—' },
    { k: 'baths', t: 'Baths', n: 1, f: (h) => h.baths ?? '—' },
    { k: 'sqft', t: 'Sqft', n: 1, f: (h) => num(h.sqft) },
    { k: 'ppsf', t: '$/sqft', n: 1, f: (h) => money(ppsf(h)), v: ppsf },
    { k: 'sc', t: 'School', n: 1, f: (h) => h.sc ?? '—' },
    { k: 'dom', t: 'DOM', n: 1, f: (h) => h.dom ?? '—' },
  ];

  function sortedHomes() {
    const list = [...S.filtered];
    if (S.tableSort) {
      const col = HOUSE_COLS.find((c) => c.k === S.tableSort.key);
      const get = col.v || ((h) => h[col.k]);
      const d = S.tableSort.dir;
      list.sort((a, b) => {
        const x = get(a), y = get(b);
        if (x == null || x === '') return 1;
        if (y == null || y === '') return -1;
        return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d;
      });
    } else list.sort(SORTS[S.sort] || SORTS.recent);
    return list;
  }

  function renderHouses() {
    const list = sortedHomes();
    const shown = list.slice(0, S.shown);
    $('#resultCount').textContent = `${num(list.length)} homes`;
    $('#houseGrid').hidden = S.mode !== 'grid';
    $('#houseTable').hidden = S.mode !== 'table';
    if (!list.length) {
      $('#houseGrid').innerHTML = '<div class="empty">No homes match these filters.</div>';
      $('#houseTable').innerHTML = '';
    } else if (S.mode === 'grid') {
      $('#houseGrid').innerHTML = shown.map(cardHTML).join('');
    } else {
      $('#houseTable').innerHTML = tableHTML(HOUSE_COLS, shown, S.tableSort, (h) => `data-id="${esc(h.id)}"`);
      $$('#houseTable th').forEach((th) => th.addEventListener('click', () => {
        const k = th.dataset.k;
        S.tableSort = S.tableSort?.key === k ? { key: k, dir: -S.tableSort.dir } : { key: k, dir: HOUSE_COLS.find((c) => c.k === k).n ? -1 : 1 };
        renderHouses();
      }));
    }
    $('#loadMore').hidden = list.length <= S.shown;
    $('#loadMore').textContent = `Show more (${num(list.length - S.shown)} left)`;
  }

  function tableHTML(cols, rows, sort, rowAttr) {
    return `<table><thead><tr>${cols.map((c) => `<th data-k="${c.k}" class="${c.n ? 'num' : ''}">${c.t}${sort?.key === c.k ? ` <span class="arrow">${sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr ${rowAttr(r)}>${cols.map((c) => `<td class="${c.n ? 'num' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  // ------------------------------------------------------------ towns
  const TOWN_COLS = [
    { k: 'town', t: 'Town', f: (r) => `<b>${esc(r.town)}</b>` },
    { k: 'county', t: 'County', f: (r) => esc(r.county) },
    { k: 'sc', t: 'School score', n: 1, f: (r) => (r.sc != null ? `<span class="sc" title="${esc(r.district || '')}">${r.sc}</span>` : '—') },
    { k: 'active', t: 'Available', n: 1, f: (r) => num(r.active) },
    { k: 'new', t: 'New', n: 1, f: (r) => num(r.new) },
    { k: 'pending', t: 'Under contract', n: 1, f: (r) => num(r.pending) },
    { k: 'sold', t: 'Sold', n: 1, f: (r) => num(r.sold) },
    { k: 'med_list', t: 'Median list', n: 1, f: (r) => money(r.med_list) },
    { k: 'med_sold', t: 'Median sold', n: 1, f: (r) => money(r.med_sold) },
    { k: 'stl', t: 'Sale / list', n: 1, f: (r) => (r.stl ? r.stl.toFixed(1) + '%' : '—') },
    { k: 'med_dom', t: 'Median DOM', n: 1, f: (r) => r.med_dom ?? '—' },
    { k: 'ppsf', t: 'Median $/sqft', n: 1, f: (r) => money(r.ppsf) },
    { k: 'district', t: 'School district', f: (r) => esc(r.district || '—') },
  ];

  function townRows() {
    const groups = new Map();
    S.homes.forEach((h) => {
      if (!matches(h, true, true)) return;
      const k = townKey(h);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(h);
    });
    return [...groups].map(([k, hs]) => {
      const info = S.townInfo.get(k) || {};
      const [town, county] = k.split('|');
      const act = hs.filter((h) => h.st === 'A');
      const sold = hs.filter((h) => h.st === 'S');
      const r = sold.filter((h) => h.sp && h.lp).map((h) => h.sp / h.lp);
      return {
        key: k, town, county, sc: info.sc ?? hs[0].sc, district: info.district,
        active: act.length, new: hs.filter((h) => h.new).length,
        pending: hs.filter((h) => h.st === 'P').length, sold: sold.length,
        med_list: median(act.map((h) => h.lp)), med_sold: median(sold.map((h) => h.sp)),
        stl: r.length ? (r.reduce((a, b) => a + b, 0) / r.length) * 100 : null,
        med_dom: median(act.map((h) => h.dom)), ppsf: median(act.map(ppsf)),
      };
    });
  }

  function renderTowns() {
    const rows = townRows();
    const { key, dir } = S.townSort;
    rows.sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
    $('#townTable').innerHTML = rows.length
      ? tableHTML(TOWN_COLS, rows, S.townSort, (r) => `data-town="${esc(r.key)}"`)
      : '<div class="empty">No towns match these filters.</div>';
    $$('#townTable th').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.k;
      S.townSort = S.townSort.key === k ? { key: k, dir: -S.townSort.dir } : { key: k, dir: TOWN_COLS.find((c) => c.k === k).n ? -1 : 1 };
      renderTowns();
    }));
    $$('#townTable tbody tr').forEach((tr) => tr.addEventListener('click', () => {
      F.towns = new Set([tr.dataset.town]);
      S.view = 'houses';
      changed();
    }));
  }

  // ------------------------------------------------------------ map
  function renderMap() {
    const statusColor = { A: cssVar('--st-A'), P: cssVar('--st-P'), S: cssVar('--st-S') };
    $('#mapLegend').innerHTML = Object.entries(STATUS).map(([k, v]) => `<span><span class="pin" style="background:${statusColor[k]}"></span>${v}</span>`).join('')
      + `<span class="muted">${num(S.filtered.filter((h) => h.lat && h.lng).length)} homes on map</span>`;
    if (!window.L) return;
    if (!S.map) {
      S.map = L.map('map', { preferCanvas: true }).setView([40.65, -74.45], 9);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
      }).addTo(S.map);
    }
    if (S.cluster) S.map.removeLayer(S.cluster);
    S.cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 45, disableClusteringAtZoom: 16 });
    const pts = [];
    S.filtered.forEach((h) => {
      if (!h.lat || !h.lng) return;
      const m = L.circleMarker([h.lat, h.lng], { radius: 7, weight: 2, color: '#fff', fillColor: statusColor[h.st], fillOpacity: 0.95 });
      m.bindPopup(() => `${h.img ? `<img src="${esc(h.img)}" alt="">` : ''}
        <b>${money(h.st === 'S' ? h.sp ?? h.lp : h.lp)}</b> · ${STATUS[h.st]}<br>
        ${h.beds ?? '—'} bd · ${h.baths ?? '—'} ba · ${num(h.sqft)} sqft<br>
        ${esc(fullAddr(h))}, ${esc(h.city)}<br>
        <a href="#" data-id="${esc(h.id)}">View details</a>`);
      pts.push(m);
      S.cluster.addLayer(m);
    });
    S.map.addLayer(S.cluster);
    setTimeout(() => {
      S.map.invalidateSize();
      if (pts.length) S.map.fitBounds(L.featureGroup(pts).getBounds(), { padding: [20, 20], maxZoom: 14 });
    }, 50);
  }

  // ------------------------------------------------------------ charts
  function chartTheme() {
    return {
      text: cssVar('--text-2'), muted: cssVar('--muted'), grid: cssVar('--grid'),
      A: cssVar('--st-A'), P: cssVar('--st-P'), S: cssVar('--st-S'), surface: cssVar('--surface'),
    };
  }

  function makeChart(id, config) {
    if (!window.Chart) return;
    S.charts[id]?.destroy();
    const c = chartTheme();
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.color = c.muted;
    const base = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: config.data.datasets.length > 1, labels: { color: c.text, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: { backgroundColor: c.surface, titleColor: cssVar('--text'), bodyColor: c.text, borderColor: c.grid, borderWidth: 1, padding: 10 },
      },
      scales: {
        x: { grid: { display: false }, border: { color: cssVar('--axis') }, ticks: { color: c.muted } },
        y: { grid: { color: c.grid }, border: { display: false }, ticks: { color: c.muted } },
      },
    };
    S.charts[id] = new Chart($('#' + id), { ...config, options: deepMerge(base, config.options || {}) });
  }

  function deepMerge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] ? deepMerge(a[k], v) : v;
    return out;
  }

  function renderMarket() {
    const c = chartTheme();
    const sold = S.homes.filter((h) => h.st === 'S' && h.sd && matches(h, false, true));
    const months = {};
    sold.forEach((h) => (months[h.sd.slice(0, 7)] ||= []).push(h.sp));
    const keys = Object.keys(months).sort();
    const label = (m) => new Date(m + '-15').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    makeChart('chartMonthly', {
      type: 'line',
      data: { labels: keys.map(label), datasets: [{ label: 'Median sold price', data: keys.map((k) => median(months[k])), borderColor: c.S, backgroundColor: c.S, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0.25 }] },
      options: { scales: { y: { ticks: { callback: (v) => shortMoney(v) } } }, plugins: { tooltip: { callbacks: { label: (ctx) => ` Median ${money(ctx.parsed.y)} (${months[keys[ctx.dataIndex]].length} sales)` } } } },
    });
    makeChart('chartVolume', {
      type: 'bar',
      data: { labels: keys.map(label), datasets: [{ label: 'Homes sold', data: keys.map((k) => months[k].length), backgroundColor: c.S, borderRadius: 4, maxBarThickness: 36 }] },
    });

    const rows = townRows().filter((r) => r.med_list).sort((a, b) => b.active - a.active).slice(0, 25).sort((a, b) => b.med_list - a.med_list);
    makeChart('chartTowns', {
      type: 'bar',
      data: { labels: rows.map((r) => r.town), datasets: [{ label: 'Median list price', data: rows.map((r) => r.med_list), backgroundColor: c.A, borderRadius: 4, maxBarThickness: 18 }] },
      options: {
        indexAxis: 'y', interaction: { mode: 'nearest', axis: 'y', intersect: false },
        scales: { x: { grid: { color: c.grid, display: true }, ticks: { callback: (v) => shortMoney(v) } }, y: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed.x)} · ${rows[ctx.dataIndex].active} available` } } },
      },
    });

    const towns = F.towns.size === 1 ? [[...F.towns][0].split('|')[0]] : ['All'];
    const hist = S.history.filter((r) => r.town === towns[0]).sort((a, b) => a.d.localeCompare(b.d));
    makeChart('chartTrend', {
      type: 'line',
      data: {
        labels: hist.map((r) => date(r.d)),
        datasets: [
          { label: 'Available', data: hist.map((r) => r.active), borderColor: c.A, backgroundColor: c.A, borderWidth: 2, pointRadius: 3 },
          { label: 'Under contract', data: hist.map((r) => r.pending), borderColor: c.P, backgroundColor: c.P, borderWidth: 2, pointRadius: 3 },
        ],
      },
    });
  }

  // ------------------------------------------------------------ changes feed
  function renderChanges() {
    const towns = new Set([...F.towns].map((k) => k.split('|')[0]));
    const items = S.changes.filter((e) => (S.changeType === 'all' || e.type === S.changeType) && (!towns.size || towns.has(e.city)));
    if (!items.length) {
      $('#changeFeed').innerHTML = '<div class="empty">No changes recorded yet for this selection. The feed builds up as the tracker runs each day.</div>';
      return;
    }
    let html = '', day = '';
    items.slice(0, 600).forEach((e) => {
      if (e.d !== day) { day = e.d; html += `<div class="day">${date(day)}</div>`; }
      const h = S.byId.get(e.id);
      let what = CHANGE[e.type];
      if (e.type === 'sold') what += ` for ${money(e.sp)}${e.lp ? ` (list ${shortMoney(e.lp)})` : ''}`;
      else if (e.type === 'price') what += `: ${shortMoney(e.old)} → ${shortMoney(e.lp)}`;
      else what += ` · ${money(e.lp)}`;
      html += `<div class="change" ${h ? `data-id="${esc(e.id)}"` : ''}>
        <div class="thumb" style="${cssUrl(e.img)}"></div>
        <div><div class="what">${what}</div><div class="where">${esc(e.addr)}, ${esc(e.city)}</div></div>
      </div>`;
    });
    if (items.length > 600) html += `<div class="empty">Showing the 600 most recent of ${num(items.length)} changes. Narrow by town to see more.</div>`;
    $('#changeFeed').innerHTML = html;
  }

  // ------------------------------------------------------------ detail modal
  async function openDetail(id) {
    const h = S.byId.get(id);
    if (!h) return;
    const dlg = $('#detail');
    $('#detailBody').innerHTML = '<div class="empty">Loading…</div>';
    if (!dlg.open) dlg.showModal();
    const s = slug(h.city);
    if (!S.details[s]) S.details[s] = await getJSON(`data/details/${s}.json`, {});
    const d = S.details[s][id] || {};
    const photos = (d.photos?.length ? d.photos : [h.img]).map(safeUrl).filter(Boolean);
    let idx = 0;
    const stat = (k, v) => (v == null || v === '' || v === '—' ? '' : `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`);
    const tl = h.st === 'S' && h.sp && h.lp ? ((h.sp / h.lp) * 100).toFixed(1) + '%' : null;
    $('#detailBody').innerHTML = `
      <button class="close" aria-label="Close">×</button>
      ${photos.length ? `
        <div class="carousel">
          <img id="dImg" src="${esc(photos[0])}" alt="Photo of ${esc(fullAddr(h))}">
          ${photos.length > 1 ? '<button class="nav prev" aria-label="Previous photo">‹</button><button class="nav next" aria-label="Next photo">›</button>' : ''}
          <span class="count" id="dCount">1 / ${photos.length}</span>
        </div>
        ${photos.length > 1 ? `<div class="thumbs">${photos.map((p, i) => `<img src="${esc(p)}" data-i="${i}" class="${i ? '' : 'on'}" loading="lazy" alt="">`).join('')}</div>` : ''}`
      : '<div class="carousel"><div class="no-photo">No photos available</div></div>'}
      <div class="detail-main">
        <div class="detail-head">
          <div>
            <div class="price">${money(h.st === 'S' ? h.sp ?? h.lp : h.lp)}</div>
            <div>${esc(fullAddr(h))}, ${esc(h.city)}, NJ ${esc(h.zip || '')}</div>
            <div class="muted">${h.beds ?? '—'} beds · ${h.baths ?? '—'} baths · ${num(h.sqft)} sqft${h.type ? ' · ' + esc(prettyType(h.type)) : ''}</div>
          </div>
          <div>${statusBadge(h)} ${h.new ? '<span class="badge new">NEW</span>' : ''} ${favBtn(h.id)}</div>
        </div>
        <div class="stats">
          ${stat('List price', money(h.lp))}
          ${h.st === 'S' ? stat('Sold price', money(h.sp)) + stat('Sold date', date(h.sd)) + stat('Sale / list', tl) : ''}
          ${h.st === 'P' ? stat('Under contract since', h.pd ? date(h.pd) : null) : ''}
          ${stat('Listed', h.ld ? date(h.ld) : null)}
          ${stat('Days on market', h.dom)}
          ${stat('$ / sqft', ppsf(h) ? money(ppsf(h)) : null)}
          ${stat('Lot size', h.lot ? `${num(h.lot)} sqft (${(h.lot / 43560).toFixed(2)} ac)` : null)}
          ${stat('Year built', h.yb)}
          ${stat('Stories', d.stories)}
          ${stat('Garage', d.garage ? d.garage + ' car' : null)}
          ${stat('Annual tax', d.tax ? money(d.tax) : null)}
          ${stat('HOA / month', d.hoa ? money(d.hoa) : null)}
          ${stat('Est. value', d.est ? money(d.est) : null)}
          ${stat('Assessed value', d.assessed ? money(d.assessed) : null)}
          ${stat('School score', h.sc != null ? `${h.sc} / 10` : null)}
          ${stat('School district', d.district ? esc(d.district) : null)}
          ${stat('Reading / Math proficient', d.ela ? `${d.ela}% / ${d.math ?? '—'}%` : null)}
          ${stat('County', esc(h.county))}
          ${stat('MLS #', d.mls ? esc(d.mls) : null)}
        </div>
        ${d.desc ? `<h3>About this home</h3><p class="desc">${esc(d.desc)}</p>` : ''}
        ${d.ph?.length > 1 ? `<h3>List price history</h3><ul class="ph-list">${d.ph.map(([dt, p]) => `<li>${date(dt)}: ${money(p)}</li>`).join('')}</ul>` : ''}
        ${d.schools_near ? `<p class="muted small">Nearby schools: ${esc(d.schools_near)}</p>` : ''}
        ${safeUrl(d.url) ? `<a class="ext" href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">View full listing on Realtor.com ↗</a>` : ''}
      </div>`;
    const show = (i) => {
      idx = (i + photos.length) % photos.length;
      $('#dImg').src = photos[idx];
      $('#dCount').textContent = `${idx + 1} / ${photos.length}`;
      $$('.thumbs img').forEach((t, j) => t.classList.toggle('on', j === idx));
    };
    $('.close', dlg).onclick = () => dlg.close();
    $('.prev', dlg)?.addEventListener('click', () => show(idx - 1));
    $('.next', dlg)?.addEventListener('click', () => show(idx + 1));
    $$('.thumbs img', dlg).forEach((t) => t.addEventListener('click', () => show(+t.dataset.i)));
    dlg.onkeydown = (e) => {
      if (photos.length < 2) return;
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    };
  }

  // ------------------------------------------------------------ theme
  function applyStoredTheme() {
    try {
      const t = localStorage.getItem('theme');
      if (t) document.documentElement.dataset.theme = t;
    } catch { /* storage unavailable */ }
  }

  function toggleTheme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
    if (S.cluster) { S.map.removeLayer(S.cluster); S.cluster = null; }
    render();
  }

  init();
})();
