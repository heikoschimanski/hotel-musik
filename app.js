'use strict';

/* Hotel Musik – steuert pro Zone einen eigenen Spotify-Account (OAuth PKCE)
   und spielt über Spotify Connect auf den Lautsprechern der Zone.

   app.js         Zustand, Anmeldung, Spotify-API, Zonen-Karten, Auswahl-Dialoge
   automation.js  Zeitplan, Wächter, Lautstärke-Limit, Bildschirm-Sperre, Protokoll
   settings.js    Einstellungen, PIN, Zeitplan-Editor, Sicherung */

const SCOPES = [
  'user-read-private', 'user-read-playback-state', 'user-modify-playback-state',
  'user-read-currently-playing', 'playlist-read-private', 'playlist-read-collaborative',
].join(' ');
const STORE = 'hotel-musik-v1';
const PKCE_KEY = 'hotel-musik-pkce';
const POLL_MS = 4000;
const MAX_FAVS = 6;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mo … So (Date.getDay(): So = 0)
const REDIRECT_URI = location.origin + location.pathname;

// Voreingestellte Client-ID der Spotify-Dashboard-App (öffentlich, kein Geheimnis).
// Wird einmal pro neuer Voreinstellung übernommen; danach gilt, was in den Einstellungen steht.
const DEFAULT_CLIENT_ID = 'b30cc967486d4e02ad68042592c9ddd9';

/* ---------- kleine Helfer ---------- */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  prev: 'M6 6h2v12H6zM9.5 12l8.5 6V6z',
  shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z',
  star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

function pad(n) { return String(n).padStart(2, '0'); }
function newId(prefix) { return prefix + Math.random().toString(36).slice(2, 8); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/* ---------- Zustand ---------- */

function normalizeZone(z) {
  return {
    id: String(z.id || newId('z')),
    name: String(z.name || 'Zone').slice(0, 40),
    auth: z.auth && (z.auth.access || z.auth.refresh) ? z.auth : null,
    user: z.user || null,
    deviceId: z.deviceId || null,
    deviceName: z.deviceName || null,
    playlistUri: z.playlistUri || null,
    playlistName: z.playlistName || null,
    maxVolume: clampInt(z.maxVolume, 10, 100, 100),
    guard: !!z.guard,
    wantPlaying: !!z.wantPlaying,
    favorites: (Array.isArray(z.favorites) ? z.favorites : [])
      .filter(f => f && f.uri).slice(0, MAX_FAVS)
      .map(f => ({ uri: String(f.uri), name: String(f.name || '') })),
  };
}

function normalizeRule(r) {
  const days = Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter(d => d >= 0 && d <= 6))] : [];
  return {
    id: String(r.id || newId('t')),
    zoneId: String(r.zoneId || ''),
    enabled: r.enabled !== false,
    days: days.length ? days : [...ALL_DAYS],
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : '08:00',
    action: ['play', 'pause', 'volume'].includes(r.action) ? r.action : 'play',
    playlistUri: r.playlistUri || null,
    playlistName: r.playlistName || null,
    volume: r.volume == null ? null : clampInt(r.volume, 0, 100, null),
    lastRun: typeof r.lastRun === 'string' ? r.lastRun : null,
  };
}

function loadState() {
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem(STORE));
  } catch { /* leer oder defekt -> Standard */ }
  s = s && typeof s === 'object' ? s : {};
  const zones = Array.isArray(s.zones) ? s.zones : ['Bar', 'Essbereich', 'Flure'].map(name => ({ name }));
  const next = {
    clientId: typeof s.clientId === 'string' ? s.clientId : '',
    appliedDefaultClientId: s.appliedDefaultClientId || null,
    zones: zones.map(normalizeZone),
    schedule: (Array.isArray(s.schedule) ? s.schedule : []).map(normalizeRule),
    keepAwake: s.keepAwake !== false,
    pin: s.pin && s.pin.salt && s.pin.hash ? { salt: String(s.pin.salt), hash: String(s.pin.hash) } : null,
  };
  if (next.appliedDefaultClientId !== DEFAULT_CLIENT_ID) {
    next.clientId = DEFAULT_CLIENT_ID;
    next.appliedDefaultClientId = DEFAULT_CLIENT_ID;
  }
  // sofort sichern: sonst entstehen die Zonen nach dem Spotify-Rücksprung mit neuen IDs
  localStorage.setItem(STORE, JSON.stringify(next));
  return next;
}

let state = loadState();
const save = () => localStorage.setItem(STORE, JSON.stringify(state));
const zoneById = id => state.zones.find(z => z.id === id);
const newZone = name => normalizeZone({ name });

// Laufzeitdaten pro Zone (werden nicht gespeichert)
const runtime = {};
const R = z => (runtime[z.id] ||= {
  player: null, error: null, errorAt: 0, lastError: '', refs: null, volTouched: 0,
  refreshing: null, polling: false, pollOk: false, pollAt: 0, prog: null,
  guardMiss: 0, guardLast: 0, guardFails: 0, guardActive: false, limitLast: 0,
});

/* ---------- Spotify-Anmeldung (PKCE) ---------- */

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), b => chars[b % chars.length]).join('');
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login(zoneId) {
  if (!state.clientId) return openSettings();
  const verifier = randomString(96);
  const oauthState = randomString(16);
  localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state: oauthState, zoneId }));
  const q = new URLSearchParams({
    client_id: state.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await sha256Base64Url(verifier),
    state: oauthState,
    show_dialog: 'true', // erlaubt "Nicht du?" -> anderen Account wählen
  });
  location.href = 'https://accounts.spotify.com/authorize?' + q;
}

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: state.clientId, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || res.status), { code: data.error });
  return { access: data.access_token, refresh: data.refresh_token, exp: Date.now() + data.expires_in * 1000 };
}

async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', location.pathname);
  const pending = JSON.parse(localStorage.getItem(PKCE_KEY) || 'null');
  localStorage.removeItem(PKCE_KEY);
  if (!pending) {
    return toast('Anmeldung ungültig: Dieser Browser hat die Anmeldung nicht selbst gestartet. Bitte im selben Browser-Fenster starten und beenden (nicht zwischen App und Chrome wechseln).');
  }
  const z = zoneById(pending.zoneId);
  if (!z) return toast('Anmeldung ungültig: Die Zone existiert nicht mehr.');
  if (p.get('state') !== pending.state) {
    return toast('Anmeldung ungültig: Es lief eine neuere Anmeldung. Bitte nur einmal auf „Mit Spotify anmelden“ tippen und den Vorgang beenden.');
  }
  if (p.has('error')) return toast('Anmeldung abgebrochen: ' + p.get('error'));
  try {
    z.auth = await tokenRequest({
      grant_type: 'authorization_code', code: p.get('code'),
      redirect_uri: REDIRECT_URI, code_verifier: pending.verifier,
    });
    const me = await api(z, 'GET', '/me');
    z.user = { name: me.display_name || me.id, product: me.product };
    save();
    logEvent(z, `Angemeldet als ${z.user.name}`);
    toast(me.product === 'premium'
      ? `${z.name}: angemeldet als ${z.user.name}`
      : `${z.name}: ${z.user.name} hat kein Premium – Steuerung wird nicht funktionieren.`);
  } catch (e) {
    z.auth = null;
    toast('Anmeldung fehlgeschlagen: ' + errorText(e));
  }
}

function logout(z) {
  z.auth = null; z.user = null; z.wantPlaying = false;
  R(z).player = null; R(z).error = null;
  save(); render();
  logEvent(z, 'Abgemeldet');
}

function accessToken(z) {
  if (!z.auth) return Promise.reject(new Error('Nicht angemeldet'));
  if (Date.now() < z.auth.exp - 60000) return Promise.resolve(z.auth.access);
  const r = R(z);
  // ein einziger Refresh gleichzeitig (Refresh-Tokens können rotieren)
  r.refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: z.auth.refresh })
    .then(a => { z.auth = { ...a, refresh: a.refresh || z.auth.refresh }; save(); return z.auth.access; })
    .catch(e => { if (e.code === 'invalid_grant') { z.auth = null; save(); render(); } throw e; })
    .finally(() => { r.refreshing = null; });
  return r.refreshing;
}

/* ---------- Spotify Web API ---------- */

let rateLimitedUntil = 0;

async function api(z, method, path, body) {
  const token = await accessToken(z);
  const res = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined,
  });
  if (res.status === 429) rateLimitedUntil = Date.now() + (Number(res.headers.get('Retry-After')) || 10) * 1000;
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: { message: text } }; } // Spotify antwortet manchmal im Klartext
  }
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || res.statusText), { status: res.status });
  return data;
}

function errorText(e) {
  if (/premium subscription required for the owner/i.test(e.message)) {
    return 'Der Besitzer der Spotify-Developer-App (Dashboard-Account) braucht Premium.';
  }
  if (e.name === 'TimeoutError' || e.name === 'AbortError' || (e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message))) {
    return 'Keine Verbindung zu Spotify (Internet/WLAN prüfen).';
  }
  switch (e.status) {
    case 401: return 'Sitzung abgelaufen – bitte neu anmelden.';
    case 404: return 'Lautsprecher nicht erreichbar (in der Spotify-App einmal auswählen?).';
    case 429: return 'Spotify drosselt Anfragen – kurz warten.';
    case 403: return 'Spotify lehnt ab: ' + e.message + ' (Premium? Account im Dashboard freigegeben?)';
  }
  return e.message || 'Unbekannter Fehler';
}

// Steuerbefehl senden, Fehler an der Zone anzeigen, danach Status neu laden.
// quiet: Fehler nicht anzeigen. okIf: Fehler, die trotzdem als Erfolg zählen. Ergebnis: true/false.
async function command(z, method, path, body, { quiet = false, okIf } = {}) {
  const r = R(z);
  let ok = true;
  try {
    await api(z, method, path, body);
    r.error = null;
  } catch (e) {
    if (okIf && okIf(e)) {
      r.error = null;
    } else {
      ok = false;
      r.lastError = errorText(e);
      if (!quiet) { r.error = r.lastError; r.errorAt = Date.now(); }
    }
  }
  paint(z);
  setTimeout(() => poll(z), 600);
  return ok;
}

async function poll(z) {
  const r = R(z);
  if (!z.auth || r.polling || Date.now() < rateLimitedUntil) return;
  r.polling = true;
  try {
    r.player = await api(z, 'GET', '/me/player');
    r.pollOk = true;
    r.pollAt = Date.now();
    if (!r.error || Date.now() - r.errorAt > 8000) r.error = null; // Fehlermeldungen eines Befehls bleiben kurz stehen
  } catch (e) {
    r.pollOk = false;
    r.error = errorText(e);
    r.errorAt = Date.now();
  } finally {
    r.polling = false;
  }
  paint(z);
  onPolled(z);
}

/* ---------- Aktionen ---------- */

const isActive = z => { const p = R(z).player; return !!p && !!z.deviceId && p.device?.id === z.deviceId; };
const isPlayingHere = z => isActive(z) && !!R(z).player.is_playing;
const devQ = z => 'device_id=' + encodeURIComponent(z.deviceId);
const clampVolume = (z, pct) => Math.min(z.maxVolume, Math.max(0, Math.round(pct)));

// Playlists enden sonst irgendwann: auf "Wiederholen" stellen (Gerät ist direkt nach dem Start evtl. noch nicht bereit)
async function keepRepeating(z) {
  for (const wait of [800, 3000]) {
    await sleep(wait);
    try {
      await api(z, 'PUT', `/me/player/repeat?state=context&${devQ(z)}`);
      return;
    } catch { /* noch nicht bereit -> nächster Versuch */ }
  }
}

async function startPlaylist(z) {
  z.wantPlaying = true; save();
  const ok = await command(z, 'PUT', `/me/player/play?${devQ(z)}`, { context_uri: z.playlistUri });
  if (ok) keepRepeating(z);
  return ok;
}

function resumeZone(z) {
  z.wantPlaying = true; save();
  return command(z, 'PUT', `/me/player/play?${devQ(z)}`);
}

// Nichts zu pausieren (schon pausiert / Gerät schläft) zählt als Erfolg
const nothingToPause = e => e.status === 404 || (e.status === 403 && /restriction/i.test(e.message));

function pauseZone(z) {
  z.wantPlaying = false; save();
  if (!z.deviceId) return Promise.resolve(true);
  return command(z, 'PUT', `/me/player/pause?${devQ(z)}`, undefined, { okIf: nothingToPause });
}

function playZone(z) {
  if (!z.deviceId) return pickDevice(z);
  if (isActive(z) && R(z).player.item) return resumeZone(z);
  if (!z.playlistUri) return pickPlaylist(z);
  return startPlaylist(z);
}

const togglePlay = z => (isPlayingHere(z) ? pauseZone(z) : playZone(z));
const pauseAll = () => state.zones.filter(z => z.auth).forEach(pauseZone);

function resumeAll() {
  state.zones
    .filter(z => z.auth && z.deviceId && !isPlayingHere(z) && (z.playlistUri || (isActive(z) && R(z).player.item)))
    .forEach(playZone);
}

const skip = (z, dir) => z.deviceId && command(z, 'POST', `/me/player/${dir}?${devQ(z)}`);
const setShuffle = (z, on) => z.deviceId && command(z, 'PUT', `/me/player/shuffle?state=${on}&${devQ(z)}`);

function setVolumeNow(z, pct, opts) {
  return command(z, 'PUT', `/me/player/volume?volume_percent=${clampVolume(z, pct)}&${devQ(z)}`, undefined, opts);
}

const volumeTimers = {};
function setVolume(z, pct, slider) {
  const r = R(z);
  r.volTouched = Date.now();
  if (pct > z.maxVolume) { pct = z.maxVolume; slider.value = pct; }
  if (r.refs) r.refs.volLabel.textContent = pct + ' %';
  clearTimeout(volumeTimers[z.id]);
  volumeTimers[z.id] = setTimeout(() => z.deviceId && setVolumeNow(z, pct), 250);
}

function toggleFavorite(z, p) {
  const i = z.favorites.findIndex(f => f.uri === p.uri);
  if (i >= 0) z.favorites.splice(i, 1);
  else if (z.favorites.length >= MAX_FAVS) toast(`Maximal ${MAX_FAVS} Schnellwahl-Playlists je Zone.`);
  else z.favorites.push({ uri: p.uri, name: p.name });
  save(); paint(z);
}

function selectPlaylist(z, { uri, name }) {
  z.playlistUri = uri; z.playlistName = name;
  save(); paint(z);
  if (z.deviceId) startPlaylist(z);
  else pickDevice(z);
}

/* ---------- Zonen-Karten ---------- */

function render() {
  $('#zones').replaceChildren(...state.zones.map(buildZone));
  state.zones.forEach(paint);
}

function buildZone(z) {
  const r = R(z);
  const head = h('div', { class: 'zone-head' }, h('h2', null, z.name));
  const card = h('section', { class: 'zone' }, head);

  if (!state.clientId) {
    card.append(h('div', { class: 'login' },
      h('p', null, 'Zuerst die Spotify-Client-ID in den Einstellungen eintragen.'),
      h('button', { class: 'primary', onclick: openSettings }, 'Einstellungen öffnen')));
    r.refs = null;
    return card;
  }
  if (!z.auth) {
    card.append(h('div', { class: 'login' },
      h('p', null, 'Dieser Zone ist noch kein Spotify-Account zugeordnet.'),
      h('button', { class: 'primary', onclick: () => login(z.id) }, 'Mit Spotify anmelden'),
      h('p', { class: 'hint' }, 'Ist im Browser bereits ein anderer Account angemeldet, auf der Spotify-Seite „Nicht du?“ wählen.')));
    r.refs = null;
    return card;
  }

  head.append(h('span', { class: 'chip' }, z.user ? z.user.name : 'Spotify'));
  const refs = r.refs = {
    cover: h('div', { class: 'cover' }),
    title: h('div', { class: 'title' }),
    artist: h('div', { class: 'artist' }),
    progress: h('div', { class: 'progress', hidden: true }, h('span')),
    status: h('div', { class: 'status' }),
    shuffle: h('button', { class: 'ctl small', 'aria-label': 'Zufall', onclick: () => setShuffle(z, !(R(z).player?.shuffle_state)) }, icon('shuffle')),
    prev: h('button', { class: 'ctl', 'aria-label': 'Zurück', onclick: () => skip(z, 'previous') }, icon('prev')),
    play: h('button', { class: 'ctl main', 'aria-label': 'Wiedergabe', onclick: () => togglePlay(z) }),
    next: h('button', { class: 'ctl', 'aria-label': 'Weiter', onclick: () => skip(z, 'next') }, icon('next')),
    vol: h('input', {
      type: 'range', min: 0, max: 100, step: 1, value: 50, 'aria-label': 'Lautstärke',
      oninput: e => setVolume(z, +e.target.value, e.target),
    }),
    volLabel: h('span', { class: 'vol-label' }),
    favs: h('div', { class: 'favs', hidden: true }),
    playlist: h('button', { class: 'pick', onclick: () => pickPlaylist(z) }),
    device: h('button', { class: 'pick', onclick: () => pickDevice(z) }),
    badges: h('div', { class: 'badges' }),
    upcoming: h('div', { class: 'upcoming' }),
    error: h('div', { class: 'err' }),
  };
  card.append(
    h('div', { class: 'now' }, refs.cover, h('div', { class: 'meta' }, refs.title, refs.artist, refs.progress, refs.status)),
    h('div', { class: 'controls' }, refs.shuffle, refs.prev, refs.play, refs.next),
    h('div', { class: 'vol' }, icon('volume'), refs.vol, refs.volLabel),
    refs.favs, refs.playlist, refs.device, refs.badges, refs.upcoming, refs.error,
  );
  return card;
}

function paint(z) {
  const r = R(z), refs = r.refs;
  if (!refs) return;
  const p = r.player, active = isActive(z), playing = active && !!p.is_playing;
  const item = active ? p.item : null;

  refs.title.textContent = item ? item.name : (z.playlistName || 'Nichts ausgewählt');
  refs.artist.textContent = item ? (item.artists?.map(a => a.name).join(', ') || item.show?.name || '') : '';
  const imgs = item ? (item.album?.images || item.images || []) : [];
  const img = imgs[1] || imgs[0];
  refs.cover.style.backgroundImage = img ? `url("${img.url}")` : '';

  let status, warn = false;
  if (z.guard && z.wantPlaying && z.deviceId && !playing && r.guardMiss >= GUARD_AFTER_POLLS) { status = 'Wiederherstellung läuft …'; warn = true; }
  else if (!z.deviceId) status = 'Kein Lautsprecher gewählt';
  else if (active) status = p.is_playing ? 'Spielt' : 'Pausiert';
  else if (p) status = 'Zone ist frei (Account spielt auf „' + p.device.name + '“)';
  else status = 'Bereit';
  refs.status.textContent = status;
  refs.status.classList.toggle('on', playing);
  refs.status.classList.toggle('warn', warn);

  r.prog = item && item.duration_ms ? { base: p.progress_ms || 0, at: r.pollAt || Date.now(), dur: item.duration_ms, playing } : null;
  refs.progress.hidden = !r.prog;
  tickProgress();

  refs.play.replaceChildren(icon(playing ? 'pause' : 'play'));
  refs.shuffle.classList.toggle('on', active && !!p.shuffle_state);

  const volOk = active && p.device.volume_percent != null && p.device.supports_volume !== false;
  refs.vol.disabled = !volOk;
  const dragging = document.activeElement === refs.vol || Date.now() - r.volTouched < 2500;
  if (!dragging) {
    if (volOk) refs.vol.value = p.device.volume_percent;
    refs.volLabel.textContent = volOk ? p.device.volume_percent + ' %' : '–';
  }

  // Schnellwahl nur neu aufbauen, wenn sich etwas geändert hat (sonst gehen Fingertipps verloren)
  const favsKey = JSON.stringify([z.favorites, z.playlistUri]);
  if (refs.favsKey !== favsKey) {
    refs.favsKey = favsKey;
    refs.favs.hidden = !z.favorites.length;
    refs.favs.replaceChildren(...z.favorites.map(f =>
      h('button', { class: 'fav' + (f.uri === z.playlistUri ? ' on' : ''), onclick: () => selectPlaylist(z, f) }, f.name)));
  }

  const badges = [z.guard && 'Wächter an', z.maxVolume < 100 && `Limit ${z.maxVolume} %`].filter(Boolean);
  const badgesKey = badges.join('|');
  if (refs.badgesKey !== badgesKey) {
    refs.badgesKey = badgesKey;
    refs.badges.replaceChildren(...badges.map(b => h('span', { class: 'badge' }, b)));
  }

  refs.upcoming.textContent = nextEventText(z);
  refs.playlist.replaceChildren(h('span', { class: 'lbl' }, 'Playlist'), h('span', { class: 'val' }, z.playlistName || 'wählen …'));
  refs.device.replaceChildren(h('span', { class: 'lbl' }, 'Lautsprecher'), h('span', { class: 'val' }, z.deviceName || 'wählen …'));
  refs.error.textContent = r.error || '';
}

function tickProgress() {
  for (const z of state.zones) {
    const r = R(z);
    if (!r.refs || !r.prog) continue;
    const { base, at, dur, playing } = r.prog;
    const pos = base + (playing ? Date.now() - at : 0);
    r.refs.progress.firstChild.style.width = Math.min(100, (pos / dur) * 100) + '%';
  }
}

/* ---------- Dialoge ---------- */

// Dialoge liegen übereinander: Schließen entfernt immer nur den obersten.
function openModal(title, { wide = false, small = false, onClose } = {}) {
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') + (small ? ' small' : ''), role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'ghost', onclick: closeModal }, 'Schließen')),
    h('div', { class: 'modal-body' }));
  const backdrop = h('div', { class: 'backdrop', onclick: e => { if (e.target === backdrop) closeModal(); } }, box);
  backdrop.onClose = onClose;
  $('#modal-root').append(backdrop);
  return $('.modal-body', box);
}

function closeModal() {
  const top = $('#modal-root').lastElementChild;
  if (!top) return;
  top.remove();
  top.onClose?.();
}

const choosePlaylist = (z, p) => { closeModal(); selectPlaylist(z, p); };

function playlistRow(z, p, onChoose) {
  const isFav = () => z.favorites.some(f => f.uri === p.uri);
  const star = h('button', {
    class: 'star' + (isFav() ? ' on' : ''), 'aria-label': 'Als Schnellwahl merken',
    onclick: () => { toggleFavorite(z, p); star.classList.toggle('on', isFav()); },
  }, icon('star'));
  const thumb = p.images?.length ? `background-image:url("${p.images[p.images.length - 1].url}")` : '';
  return h('div', { class: 'row-wrap' },
    h('button', { class: 'row', onclick: () => onChoose(p) },
      h('span', { class: 'thumb', style: thumb }),
      h('span', { class: 'txt' }, h('b', null, p.name), h('small', null, p.owner?.display_name || ''))),
    star);
}

// onChoose: was mit der gewählten Playlist passiert (Standard: auf der Zone abspielen)
async function pickPlaylist(z, onChoose = p => choosePlaylist(z, p)) {
  const body = openModal(`Playlist für ${z.name}`);
  let mode = 'mine', mine = null, mineError = null, searchSeq = 0, searchTimer;
  const list = h('div', { class: 'list' });
  const input = h('input', { type: 'search', placeholder: 'Playlist filtern …', oninput: refresh });
  const seg = h('div', { class: 'seg' }, [['mine', 'Meine Playlists'], ['search', 'In Spotify suchen']].map(([id, label]) =>
    h('button', { class: 'seg-btn' + (id === mode ? ' on' : ''), 'data-mode': id, onclick: () => {
      mode = id; input.value = '';
      seg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
      refresh();
    } }, label)));

  const note = text => list.replaceChildren(h('p', { class: 'hint' }, text));
  const show = (items, empty) => items.length ? list.replaceChildren(...items.map(p => playlistRow(z, p, onChoose))) : note(empty);
  const usable = items => (items || []).filter(p => p && p.uri && p.name);

  function refresh() {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (mode === 'mine') {
      input.placeholder = 'Playlist filtern …';
      if (mineError) return list.replaceChildren(h('p', { class: 'err' }, mineError));
      if (!mine) return note('Lade Playlists …');
      return show(mine.filter(p => p.name.toLowerCase().includes(q.toLowerCase())), 'Keine Playlists gefunden.');
    }
    input.placeholder = 'Name einer Playlist in Spotify …';
    if (q.length < 2) return note('Mindestens 2 Zeichen eingeben. Spotify liefert die ersten 10 Treffer.');
    note('Suche …');
    searchTimer = setTimeout(() => runSearch(q), 450);
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    try {
      const d = await api(z, 'GET', `/search?q=${encodeURIComponent(q)}&type=playlist&limit=10`);
      if (seq === searchSeq && mode === 'search') show(usable(d.playlists?.items), 'Keine Treffer.');
    } catch (e) {
      if (seq === searchSeq) list.replaceChildren(h('p', { class: 'err' }, errorText(e)));
    }
  }

  body.append(seg, input, list);
  refresh();
  try {
    const all = [];
    let path = '/me/playlists?limit=50';
    for (let page = 0; path && page < 8; page++) {
      const d = await api(z, 'GET', path);
      all.push(...usable(d.items));
      path = d.next ? d.next.replace('https://api.spotify.com/v1', '') : null;
    }
    mine = all;
  } catch (e) {
    mineError = errorText(e);
  }
  refresh();
}

async function pickDevice(z) {
  const body = openModal(`Lautsprecher für ${z.name}`);
  const list = h('div', { class: 'list' });
  async function load() {
    list.replaceChildren(h('p', { class: 'hint' }, 'Suche Lautsprecher …'));
    try {
      const { devices } = await api(z, 'GET', '/me/player/devices');
      list.replaceChildren(...(devices.length ? devices.map(d =>
        h('button', { class: 'row' + (d.id === z.deviceId ? ' sel' : ''), onclick: () => chooseDevice(z, d) },
          h('span', { class: 'txt' }, h('b', null, d.name), h('small', null, d.type + (d.is_active ? ' · aktiv' : ''))))) : [
        h('p', { class: 'hint' }, 'Keine Geräte gefunden. Den Lautsprecher einmal in der Spotify-App dieses Accounts auswählen (Spotify Connect) – danach „Aktualisieren“.')]));
    } catch (e) {
      list.replaceChildren(h('p', { class: 'err' }, errorText(e)));
    }
  }
  body.append(
    h('button', { class: 'ghost', onclick: load }, 'Aktualisieren'), list,
    h('p', { class: 'hint' }, 'Mehrere Lautsprecher in einer Zone: in der HEOS- bzw. 4Stream-App eine Gruppe anlegen und hier die Gruppe wählen.'));
  load();
}

function chooseDevice(z, d) {
  z.deviceId = d.id; z.deviceName = d.name;
  save(); closeModal(); paint(z); poll(z);
  if (z.playlistUri && !isActive(z)) startPlaylist(z);
}

/* ---------- Start ---------- */

async function init() {
  $('#open-settings').append(icon('gear'));
  $('#open-settings').addEventListener('click', openSettings);
  $('#pause-all').addEventListener('click', pauseAll);
  $('#resume-all').addEventListener('click', resumeAll);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  await handleRedirect();
  render();
  state.zones.forEach(poll);
  setInterval(() => { if (!document.hidden) state.zones.forEach(poll); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) state.zones.forEach(poll); });
  setInterval(tickProgress, 1000);
  try {
    startAutomation();
  } catch (e) {
    console.error('Automatik konnte nicht gestartet werden', e); // die Bedienung bleibt trotzdem nutzbar
  }
}

document.addEventListener('DOMContentLoaded', init);
