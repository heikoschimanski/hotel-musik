'use strict';

/* Hotel Musik – steuert pro Zone einen eigenen Spotify-Account (OAuth PKCE)
   und spielt über Spotify Connect auf den Denon/HEOS-Lautsprechern der Zone. */

const SCOPES = [
  'user-read-private', 'user-read-playback-state', 'user-modify-playback-state',
  'user-read-currently-playing', 'playlist-read-private', 'playlist-read-collaborative',
].join(' ');
const STORE = 'hotel-musik-v1';
const PKCE_KEY = 'hotel-musik-pkce';
const POLL_MS = 4000;
const REDIRECT_URI = location.origin + location.pathname;

/* ---------- kleine DOM-Helfer ---------- */

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

/* ---------- Zustand ---------- */

function newZone(name) {
  return {
    id: 'z' + Math.random().toString(36).slice(2, 8),
    name, auth: null, user: null,
    deviceId: null, deviceName: null, playlistUri: null, playlistName: null,
  };
}

// Voreingestellte Client-ID der Spotify-Dashboard-App (öffentlich, kein Geheimnis).
// Wird einmal pro neuer Voreinstellung übernommen; danach gilt, was in den Einstellungen steht.
const DEFAULT_CLIENT_ID = 'b30cc967486d4e02ad68042592c9ddd9';

function loadState() {
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem(STORE));
  } catch { /* leer oder defekt -> Standard */ }
  if (!s || !Array.isArray(s.zones)) {
    s = { clientId: '', zones: ['Bar', 'Essbereich', 'Flure'].map(newZone) };
  }
  if (s.appliedDefaultClientId !== DEFAULT_CLIENT_ID) {
    s.clientId = DEFAULT_CLIENT_ID;
    s.appliedDefaultClientId = DEFAULT_CLIENT_ID;
  }
  // sofort sichern: sonst entstehen die Zonen nach dem Spotify-Rücksprung mit neuen IDs
  localStorage.setItem(STORE, JSON.stringify(s));
  return s;
}

let state = loadState();
const save = () => localStorage.setItem(STORE, JSON.stringify(state));
const zoneById = id => state.zones.find(z => z.id === id);

// Laufzeitdaten pro Zone (werden nicht gespeichert)
const runtime = {};
const R = z => (runtime[z.id] ||= { player: null, error: null, refs: null, volTouched: 0, refreshing: null });

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
    toast(me.product === 'premium'
      ? `${z.name}: angemeldet als ${z.user.name}`
      : `${z.name}: ${z.user.name} hat kein Premium – Steuerung wird nicht funktionieren.`);
  } catch (e) {
    z.auth = null;
    toast('Anmeldung fehlgeschlagen: ' + errorText(e));
  }
}

function logout(z) {
  z.auth = null; z.user = null;
  R(z).player = null; R(z).error = null;
  save(); render();
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

async function api(z, method, path, body) {
  const token = await accessToken(z);
  const res = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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
  switch (e.status) {
    case 401: return 'Sitzung abgelaufen – bitte neu anmelden.';
    case 404: return 'Lautsprecher nicht erreichbar (in der Spotify-App einmal auswählen?).';
    case 429: return 'Spotify drosselt Anfragen – kurz warten.';
    case 403: return 'Spotify lehnt ab: ' + e.message + ' (Premium? Account im Dashboard freigegeben?)';
  }
  return e.message || 'Unbekannter Fehler';
}

// Steuerbefehl senden, Fehler an der Zone anzeigen, danach Status neu laden
async function command(z, method, path, body) {
  const r = R(z);
  try {
    await api(z, method, path, body);
    r.error = null;
  } catch (e) {
    r.error = errorText(e);
  }
  paint(z);
  setTimeout(() => poll(z), 600);
}

async function poll(z) {
  if (!z.auth) return;
  const r = R(z);
  try {
    r.player = await api(z, 'GET', '/me/player');
    r.error = null;
  } catch (e) {
    r.error = errorText(e);
  }
  paint(z);
}

/* ---------- Aktionen ---------- */

const isActive = z => { const p = R(z).player; return !!p && !!z.deviceId && p.device?.id === z.deviceId; };
const devQ = z => 'device_id=' + encodeURIComponent(z.deviceId);

function startPlaylist(z) {
  return command(z, 'PUT', `/me/player/play?${devQ(z)}`, { context_uri: z.playlistUri });
}

function togglePlay(z) {
  if (!z.deviceId) return pickDevice(z);
  const p = R(z).player;
  if (isActive(z) && p.is_playing) return command(z, 'PUT', `/me/player/pause?${devQ(z)}`);
  if (isActive(z) && p.item) return command(z, 'PUT', `/me/player/play?${devQ(z)}`);
  if (!z.playlistUri) return pickPlaylist(z);
  return startPlaylist(z);
}

function pauseAll() {
  for (const z of state.zones) {
    if (z.auth && z.deviceId && isActive(z) && R(z).player.is_playing) command(z, 'PUT', `/me/player/pause?${devQ(z)}`);
  }
}

const skip = (z, dir) => z.deviceId && command(z, 'POST', `/me/player/${dir}?${devQ(z)}`);
const setShuffle = (z, on) => z.deviceId && command(z, 'PUT', `/me/player/shuffle?state=${on}&${devQ(z)}`);

const volumeTimers = {};
function setVolume(z, pct) {
  R(z).volTouched = Date.now();
  clearTimeout(volumeTimers[z.id]);
  volumeTimers[z.id] = setTimeout(() => z.deviceId && command(z, 'PUT', `/me/player/volume?volume_percent=${pct}&${devQ(z)}`), 250);
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
    status: h('div', { class: 'status' }),
    shuffle: h('button', { class: 'ctl small', 'aria-label': 'Zufall', onclick: () => setShuffle(z, !(R(z).player?.shuffle_state)) }, icon('shuffle')),
    prev: h('button', { class: 'ctl', 'aria-label': 'Zurück', onclick: () => skip(z, 'previous') }, icon('prev')),
    play: h('button', { class: 'ctl main', 'aria-label': 'Wiedergabe', onclick: () => togglePlay(z) }),
    next: h('button', { class: 'ctl', 'aria-label': 'Weiter', onclick: () => skip(z, 'next') }, icon('next')),
    vol: h('input', {
      type: 'range', min: 0, max: 100, step: 1, value: 50, 'aria-label': 'Lautstärke',
      oninput: e => setVolume(z, +e.target.value),
    }),
    playlist: h('button', { class: 'pick', onclick: () => pickPlaylist(z) }),
    device: h('button', { class: 'pick', onclick: () => pickDevice(z) }),
    error: h('div', { class: 'err' }),
  };
  card.append(
    h('div', { class: 'now' }, refs.cover, h('div', { class: 'meta' }, refs.title, refs.artist, refs.status)),
    h('div', { class: 'controls' }, refs.shuffle, refs.prev, refs.play, refs.next),
    h('div', { class: 'vol' }, icon('volume'), refs.vol),
    refs.playlist, refs.device, refs.error,
  );
  return card;
}

function paint(z) {
  const refs = R(z).refs;
  if (!refs) return;
  const r = R(z), p = r.player, active = isActive(z);
  const item = active ? p.item : null;

  refs.title.textContent = item ? item.name : (z.playlistName || 'Nichts ausgewählt');
  refs.artist.textContent = item ? (item.artists?.map(a => a.name).join(', ') || item.show?.name || '') : '';
  const imgs = item ? (item.album?.images || item.images || []) : [];
  const img = imgs[1] || imgs[0];
  refs.cover.style.backgroundImage = img ? `url("${img.url}")` : '';

  if (!z.deviceId) refs.status.textContent = 'Kein Lautsprecher gewählt';
  else if (active) refs.status.textContent = p.is_playing ? 'Spielt' : 'Pausiert';
  else if (p) refs.status.textContent = 'Zone ist frei (Account spielt auf „' + p.device.name + '“)';
  else refs.status.textContent = 'Bereit';
  refs.status.classList.toggle('on', active && p.is_playing);

  refs.play.replaceChildren(icon(active && p.is_playing ? 'pause' : 'play'));
  refs.shuffle.classList.toggle('on', active && !!p.shuffle_state);

  const volOk = active && p.device.volume_percent != null && p.device.supports_volume !== false;
  refs.vol.disabled = !volOk;
  const dragging = document.activeElement === refs.vol || Date.now() - r.volTouched < 2500;
  if (volOk && !dragging) refs.vol.value = p.device.volume_percent;

  refs.playlist.replaceChildren(h('span', { class: 'lbl' }, 'Playlist'), h('span', { class: 'val' }, z.playlistName || 'wählen …'));
  refs.device.replaceChildren(h('span', { class: 'lbl' }, 'Lautsprecher'), h('span', { class: 'val' }, z.deviceName || 'wählen …'));
  refs.error.textContent = r.error || '';
}

/* ---------- Dialoge ---------- */

function openModal(title, ...content) {
  closeModal();
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'ghost', onclick: closeModal }, 'Schließen')),
    h('div', { class: 'modal-body' }, content));
  const backdrop = h('div', { class: 'backdrop', onclick: e => { if (e.target === backdrop) closeModal(); } }, box);
  $('#modal-root').append(backdrop);
  return $('.modal-body', box);
}

const closeModal = () => $('#modal-root').replaceChildren();

async function pickPlaylist(z) {
  const body = openModal(`Playlist für ${z.name}`);
  body.append(h('p', { class: 'hint' }, 'Lade Playlists …'));
  let items = [];
  try {
    let path = '/me/playlists?limit=50';
    for (let page = 0; path && page < 8; page++) {
      const d = await api(z, 'GET', path);
      items.push(...d.items.filter(Boolean));
      path = d.next ? d.next.replace('https://api.spotify.com/v1', '') : null;
    }
  } catch (e) {
    return body.replaceChildren(h('p', { class: 'err' }, errorText(e)));
  }
  const list = h('div', { class: 'list' });
  const search = h('input', {
    type: 'search', placeholder: 'Playlist suchen …',
    oninput: () => fill(search.value.trim().toLowerCase()),
  });
  function fill(q) {
    const shown = items.filter(p => p.name.toLowerCase().includes(q));
    list.replaceChildren(...(shown.length ? shown : [h('p', { class: 'hint' }, 'Keine Playlists gefunden.')]).map(p => p.uri
      ? h('button', { class: 'row', onclick: () => choosePlaylist(z, p) },
          h('span', { class: 'thumb', style: p.images?.length ? `background-image:url("${p.images[p.images.length - 1].url}")` : '' }),
          h('span', { class: 'txt' }, h('b', null, p.name), h('small', null, p.owner?.display_name || '')))
      : p));
  }
  fill('');
  body.replaceChildren(search, list);
}

function choosePlaylist(z, p) {
  z.playlistUri = p.uri; z.playlistName = p.name;
  save(); closeModal(); paint(z);
  if (z.deviceId) startPlaylist(z);
  else pickDevice(z);
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
  body.append(h('button', { class: 'ghost', onclick: load }, 'Aktualisieren'), list);
  load();
}

function chooseDevice(z, d) {
  z.deviceId = d.id; z.deviceName = d.name;
  save(); closeModal(); paint(z); poll(z);
  if (z.playlistUri && !isActive(z)) startPlaylist(z);
}

function openSettings() {
  const body = openModal('Einstellungen');
  const draw = () => {
    const clientInput = h('input', {
      type: 'text', value: state.clientId, placeholder: 'Client-ID aus dem Spotify Developer Dashboard',
      autocomplete: 'off', spellcheck: 'false',
      onchange: e => { state.clientId = e.target.value.trim(); save(); render(); },
    });
    const copyBtn = h('button', {
      class: 'ghost',
      onclick: () => navigator.clipboard?.writeText(REDIRECT_URI).then(() => toast('Redirect-URI kopiert')),
    }, 'Kopieren');

    body.replaceChildren(
      h('h3', null, 'Spotify-App'),
      h('label', null, 'Client-ID', clientInput),
      h('label', null, 'Redirect-URI (genau so im Dashboard eintragen)',
        h('div', { class: 'inline' }, h('code', null, REDIRECT_URI), copyBtn)),
      h('h3', null, 'Zonen'),
      ...state.zones.map(z => h('div', { class: 'zone-row' },
        h('input', { type: 'text', value: z.name, 'aria-label': 'Zonenname',
          onchange: e => { z.name = e.target.value.trim() || z.name; save(); render(); } }),
        z.auth ? h('button', { class: 'ghost', onclick: () => { logout(z); draw(); } }, 'Abmelden') : h('span', { class: 'hint' }, 'nicht angemeldet'),
        h('button', { class: 'ghost danger', onclick: () => {
          if (!confirm(`Zone „${z.name}“ entfernen?`)) return;
          state.zones = state.zones.filter(x => x !== z); save(); render(); draw();
        } }, 'Entfernen'))),
      h('button', { class: 'ghost', onclick: () => { state.zones.push(newZone('Neue Zone')); save(); render(); draw(); } }, '+ Zone hinzufügen'));
  };
  draw();
}

/* ---------- Start ---------- */

async function init() {
  $('#open-settings').append(icon('gear'));
  $('#open-settings').addEventListener('click', openSettings);
  $('#pause-all').addEventListener('click', pauseAll);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  await handleRedirect();
  render();
  state.zones.forEach(poll);
  setInterval(() => { if (!document.hidden) state.zones.forEach(poll); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) state.zones.forEach(poll); });
}

init();
