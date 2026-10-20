'use strict';

/* Automatik: Zeitplan, Wächter, Lautstärke-Limit, Bildschirm-Sperre, Protokoll, Uhr.
   Alles läuft im geöffneten Browser – ohne offene App (oder bei dunklem Bildschirm) passiert nichts. */

const SCHEDULE_TICK_MS = 15000;
const SCHEDULE_WINDOW_MS = 5 * 60 * 1000; // verspätete Termine (Tablet kurz im Ruhezustand) werden bis dahin nachgeholt
const GUARD_AFTER_POLLS = 2;              // so viele Abfragen (je 4 s) ohne Wiedergabe, bevor der Wächter eingreift
const GUARD_RETRY_MS = 30000;
const LIMIT_RETRY_MS = 10000;
const LOG_KEY = 'hotel-musik-log-v1';
const LOG_MAX = 100;
const DAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/* ---------- Protokoll ---------- */

function readLog() {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY));
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

function logEvent(zone, text, ok = true) {
  const log = readLog();
  log.unshift({ t: Date.now(), zone: zone ? zone.name : '', text, ok });
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, LOG_MAX)));
  } catch { /* Speicher voll -> Protokoll ist nicht kritisch */ }
}

const clearLog = () => localStorage.removeItem(LOG_KEY);

/* ---------- Zeitplan: Berechnung (reine Funktionen, bekommen "jetzt" übergeben) ---------- */

const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function atTime(day, hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const d = new Date(day);
  d.setHours(hh, mm, 0, 0);
  return d;
}

// Termine, die jetzt ausgeführt werden müssen: Zeit erreicht, nicht länger als das Zeitfenster her,
// für diesen Tag noch nicht gelaufen. Auch gestern wird geprüft (Termine kurz vor Mitternacht).
function dueRules(now, rules) {
  const due = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const back of [0, 1]) {
      const day = new Date(now);
      day.setDate(day.getDate() - back);
      if (!rule.days.includes(day.getDay())) continue;
      const at = atTime(day, rule.time);
      const age = now - at;
      const key = dayKey(day);
      if (age >= 0 && age <= SCHEDULE_WINDOW_MS && rule.lastRun !== key) due.push({ rule, key, at });
    }
  }
  return due.sort((a, b) => a.at - b.at);
}

// Neue oder geänderte Termine dürfen nie rückwirkend feuern ("Pause um 14:00", angelegt um 14:02).
function armRule(rule, now = new Date()) {
  rule.lastRun = null;
  const due = dueRules(now, [rule]);
  if (due.length) rule.lastRun = due[due.length - 1].key;
  return rule;
}

function nextOccurrence(rule, now) {
  for (let k = 0; k < 8; k++) {
    const day = new Date(now);
    day.setDate(day.getDate() + k);
    if (!rule.days.includes(day.getDay())) continue;
    const at = atTime(day, rule.time);
    if (at > now) return at;
  }
  return null;
}

function formatDays(days) {
  const set = new Set(days);
  if (set.size === 7) return 'täglich';
  const ordered = ALL_DAYS.filter(d => set.has(d));
  const key = ordered.join('');
  if (key === '12345') return 'Mo–Fr';
  if (key === '60') return 'Sa, So';
  return ordered.map(d => DAY_NAMES[d]).join(', ');
}

function describeAction(rule) {
  const vol = rule.volume != null ? `${rule.volume} %` : '';
  switch (rule.action) {
    case 'pause': return 'Pause';
    case 'volume': return `Lautstärke ${vol}`;
    default: return `Start ${rule.playlistName ? `„${rule.playlistName}“` : '(aktuelle Playlist)'}${vol ? ` · ${vol}` : ''}`;
  }
}

function formatWhen(at, now) {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86400000);
  if (days === 0) return `heute ${time}`;
  if (days === 1) return `morgen ${time}`;
  return `${DAY_NAMES[at.getDay()]} ${time}`;
}

function nextEventText(z, now = new Date()) {
  let best = null;
  for (const rule of state.schedule) {
    if (rule.zoneId !== z.id || !rule.enabled) continue;
    const at = nextOccurrence(rule, now);
    if (at && (!best || at < best.at)) best = { at, rule };
  }
  return best ? `Nächster Termin: ${formatWhen(best.at, now)} · ${describeAction(best.rule)}` : '';
}

/* ---------- Zeitplan: Ausführung ---------- */

async function playRule(z, rule) {
  if (rule.playlistUri) { z.playlistUri = rule.playlistUri; z.playlistName = rule.playlistName; }
  const vol = rule.volume;
  if (vol != null) await setVolumeNow(z, vol, { quiet: true }); // vorab leiser stellen, damit nicht laut gestartet wird
  const p = R(z).player;
  let ok = true;
  if (isPlayingHere(z) && p.context?.uri === z.playlistUri) { z.wantPlaying = true; } // läuft schon: nicht unterbrechen
  else ok = await startPlaylist(z);
  save();
  if (vol != null) setTimeout(() => setVolumeNow(z, vol, { quiet: true }), 2500); // falls der Lautsprecher vorab noch schlief
  return ok;
}

// Ergebnis true = erledigt (auch bei dauerhaften Fehlern wie "nicht angemeldet"), false = später erneut versuchen
async function executeRule(rule) {
  const z = zoneById(rule.zoneId);
  if (!z) { logEvent(null, 'Termin übersprungen: Zone existiert nicht mehr', false); return true; }
  const what = describeAction(rule);
  if (!z.auth) { logEvent(z, `${what}: nicht angemeldet`, false); return true; }
  if (!z.deviceId) { logEvent(z, `${what}: kein Lautsprecher gewählt`, false); return true; }
  if (rule.action === 'play' && !rule.playlistUri && !z.playlistUri) { logEvent(z, `${what}: keine Playlist`, false); return true; }

  const r = R(z);
  r.volTouched = 0;
  let ok;
  if (rule.action === 'pause') ok = await pauseZone(z);
  else if (rule.action === 'volume') ok = await setVolumeNow(z, rule.volume);
  else ok = await playRule(z, rule);
  logEvent(z, ok ? `${what} ausgeführt` : `${what} fehlgeschlagen: ${r.lastError || 'unbekannter Fehler'}`, ok);
  return ok;
}

const scheduleRunning = new Set();
const scheduleAttempts = {};

async function runSchedule(now = new Date()) {
  for (const { rule, key } of dueRules(now, state.schedule)) {
    const id = `${rule.id}@${key}`;
    if (scheduleRunning.has(id)) continue;
    scheduleRunning.add(id);
    try {
      const ok = await executeRule(rule);
      scheduleAttempts[id] = (scheduleAttempts[id] || 0) + 1;
      if (ok || scheduleAttempts[id] >= 3) { rule.lastRun = key; save(); } // höchstens 3 Versuche je Termin
    } catch (e) {
      scheduleAttempts[id] = (scheduleAttempts[id] || 0) + 1;
      logEvent(zoneById(rule.zoneId), `Termin fehlgeschlagen: ${e.message}`, false);
      if (scheduleAttempts[id] >= 3) { rule.lastRun = key; save(); }
    } finally {
      scheduleRunning.delete(id);
    }
  }
}

/* ---------- Wächter und Lautstärke-Limit (laufen nach jeder Statusabfrage) ---------- */

function onPolled(z) {
  guardCheck(z);
  limitCheck(z);
}

// Soll die Zone spielen (zuletzt per App gestartet, nicht pausiert) und tut es nicht: neu starten.
function guardCheck(z) {
  const r = R(z);
  if (!z.guard || !z.wantPlaying || !z.deviceId || !z.auth) { r.guardMiss = 0; return; }
  if (!r.pollOk) return; // Spotify gerade nicht erreichbar: Zustand unbekannt, nichts unternehmen
  if (isPlayingHere(z)) {
    if (r.guardActive) logEvent(z, 'Wächter: Wiedergabe wiederhergestellt');
    r.guardMiss = 0; r.guardFails = 0; r.guardActive = false;
    return;
  }
  r.guardMiss += 1;
  if (r.guardMiss < GUARD_AFTER_POLLS || Date.now() - r.guardLast < GUARD_RETRY_MS) return;
  r.guardLast = Date.now();
  r.guardActive = true;
  recover(z);
}

async function recover(z) {
  const r = R(z);
  const pausedHere = isActive(z) && r.player.item;
  const ok = pausedHere ? await resumeZone(z) : z.playlistUri ? await startPlaylist(z) : false;
  if (ok) return;
  r.guardFails += 1;
  if (r.guardFails === 1 || r.guardFails % 10 === 0) {
    logEvent(z, `Wächter: Neustart fehlgeschlagen (${r.lastError || 'keine Playlist gewählt'})`, false);
  }
}

// Lautstärke über dem Limit (z. B. am Lautsprecher verstellt) wird zurückgesetzt.
function limitCheck(z) {
  const r = R(z);
  if (z.maxVolume >= 100 || !isActive(z)) return;
  const v = r.player.device.volume_percent;
  if (v == null || v <= z.maxVolume || Date.now() - r.limitLast < LIMIT_RETRY_MS) return;
  r.limitLast = Date.now();
  setVolumeNow(z, z.maxVolume, { quiet: true });
}

/* ---------- Bildschirm anlassen ---------- */

let wakeLock = null;

async function applyWakeLock() {
  try {
    if (state.keepAwake && 'wakeLock' in navigator && !document.hidden) {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } else if (!state.keepAwake && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null; // vom Browser abgelehnt (z. B. Energiesparmodus)
  }
}

const wakeLockActive = () => !!wakeLock;

/* ---------- Uhr und Start ---------- */

function tickClock() {
  const now = new Date();
  const el = $('#clock');
  if (el) el.textContent = `${DAY_NAMES[now.getDay()]} ${pad(now.getDate())}.${pad(now.getMonth() + 1)}. · ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function startAutomation() {
  tickClock();
  setInterval(tickClock, 10000);
  setInterval(() => runSchedule(), SCHEDULE_TICK_MS);
  setTimeout(() => runSchedule(), 5000); // nach der ersten Statusabfrage (Neustart des Tablets: verpasste Termine nachholen)
  applyWakeLock();
  document.addEventListener('visibilitychange', () => {
    applyWakeLock();
    if (!document.hidden) runSchedule();
  });
  // Manche Browser erlauben die Sperre erst nach einer Berührung
  document.addEventListener('pointerdown', applyWakeLock, { passive: true });
}
