'use strict';

/* Einstellungen: PIN-Schutz, Reiter (Allgemein, Zonen, Zeitplan, Protokoll), Zeitplan-Editor, Sicherung. */

const PIN_UNLOCK_MS = 5 * 60 * 1000;
let pinUnlockedUntil = 0, pinFails = 0, pinLockedUntil = 0;

const paintAll = () => state.zones.forEach(paint);

/* ---------- PIN ---------- */

async function pinHash(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// Ergebnis: null = richtig, sonst die Fehlermeldung
async function verifyPin(pin) {
  if (Date.now() < pinLockedUntil) return `Zu viele Versuche – bitte ${Math.ceil((pinLockedUntil - Date.now()) / 1000)} s warten.`;
  if (await pinHash(pin, state.pin.salt) === state.pin.hash) { pinFails = 0; return null; }
  if (++pinFails >= 5) { pinFails = 0; pinLockedUntil = Date.now() + 30000; return 'Zu viele Versuche – 30 s gesperrt.'; }
  return 'Falsche PIN.';
}

// Ziffernblock mit 4 Stellen. validate(pin) liefert null (ok) oder eine Fehlermeldung; Ergebnis: PIN oder null (abgebrochen)
function pinPad({ title, hint = '', validate }) {
  return new Promise(resolve => {
    let entered = '', finished = false, busy = false;
    const dots = h('div', { class: 'pin-dots' }, [0, 1, 2, 3].map(() => h('span')));
    const msg = h('div', { class: 'err pin-msg' });
    const update = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < entered.length));
    const onKey = e => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
    };
    const finish = pin => {
      finished = true;
      document.removeEventListener('keydown', onKey);
      closeModal();
      resolve(pin);
    };
    const back = () => { if (!busy) { entered = entered.slice(0, -1); update(); } };
    async function press(digit) {
      if (busy || entered.length >= 4) return;
      entered += digit; update(); msg.textContent = '';
      if (entered.length < 4) return;
      busy = true;
      const pin = entered;
      const problem = validate ? await validate(pin) : null;
      busy = false;
      if (problem) { msg.textContent = problem; entered = ''; update(); return; }
      finish(pin);
    }
    const body = openModal(title, {
      small: true,
      onClose: () => { document.removeEventListener('keydown', onKey); if (!finished) resolve(null); },
    });
    if (hint) body.append(h('p', { class: 'hint center' }, hint));
    body.append(
      dots, msg,
      h('div', { class: 'pin-pad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(k =>
        k === '' ? h('span') : h('button', { onclick: () => (k === '⌫' ? back() : press(k)) }, k))));
    document.addEventListener('keydown', onKey);
  });
}

async function withPin(fn) {
  if (!state.pin || Date.now() < pinUnlockedUntil) return fn();
  const pin = await pinPad({ title: 'PIN eingeben', validate: verifyPin });
  if (pin) { pinUnlockedUntil = Date.now() + PIN_UNLOCK_MS; fn(); }
}

async function setPin(refresh) {
  const first = await pinPad({ title: 'Neue PIN', hint: '4 Ziffern eingeben' });
  if (!first) return;
  const again = await pinPad({ title: 'PIN wiederholen', validate: async p => (p === first ? null : 'Die PINs stimmen nicht überein.') });
  if (!again) return;
  const salt = randomString(16);
  state.pin = { salt, hash: await pinHash(first, salt) };
  save();
  pinUnlockedUntil = Date.now() + PIN_UNLOCK_MS;
  toast('PIN gespeichert.');
  refresh();
}

/* ---------- Sicherung ---------- */

function exportConfig() {
  const data = {
    app: 'hotel-musik', version: 2, exported: new Date().toISOString(),
    clientId: state.clientId, keepAwake: state.keepAwake,
    // ohne Anmeldedaten und ohne PIN
    zones: state.zones.map(({ id, name, deviceId, deviceName, playlistUri, playlistName, maxVolume, guard, favorites }) =>
      ({ id, name, deviceId, deviceName, playlistUri, playlistName, maxVolume, guard, favorites })),
    schedule: state.schedule.map(({ lastRun, ...rule }) => rule),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `hotel-musik-${dayKey(new Date())}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function importConfig(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('Die Datei ist keine gültige Sicherung.');
  }
  if (data?.app !== 'hotel-musik' || !Array.isArray(data.zones)) return toast('Die Datei ist keine Sicherung von Hotel Musik.');
  if (!confirm('Einstellungen aus der Datei übernehmen?\n\nZonen, Schnellwahl, Limits und Zeitplan werden ersetzt. Spotify-Anmeldungen bleiben für Zonen erhalten, die in der Datei vorkommen.')) return;

  const old = new Map(state.zones.map(z => [z.id, z]));
  state.zones = data.zones.map(normalizeZone).map(z => {
    const prev = old.get(z.id);
    return prev ? { ...z, auth: prev.auth, user: prev.user, wantPlaying: prev.wantPlaying } : z;
  });
  state.schedule = (Array.isArray(data.schedule) ? data.schedule : []).map(normalizeRule)
    .filter(r => state.zones.some(z => z.id === r.zoneId)).map(r => armRule(r));
  if (typeof data.clientId === 'string' && data.clientId.trim()) state.clientId = data.clientId.trim();
  state.keepAwake = data.keepAwake !== false;
  save(); render(); applyWakeLock();
  toast('Einstellungen übernommen.');
}

/* ---------- Bausteine ---------- */

function switchRow(label, checked, onchange, hint) {
  return h('label', { class: 'switch-row' },
    h('span', { class: 'sw-text' }, h('b', null, label), hint ? h('small', null, hint) : null),
    h('input', { type: 'checkbox', checked, onchange: e => onchange(e.target.checked) }),
    h('span', { class: 'sw' }));
}

/* ---------- Reiter ---------- */

function tabGeneral(refresh) {
  const clientInput = h('input', {
    type: 'text', value: state.clientId, placeholder: 'Client-ID aus dem Spotify Developer Dashboard',
    autocomplete: 'off', spellcheck: 'false',
    onchange: e => { state.clientId = e.target.value.trim(); save(); render(); },
  });
  const copyBtn = h('button', {
    class: 'ghost',
    onclick: () => navigator.clipboard?.writeText(REDIRECT_URI).then(() => toast('Redirect-URI kopiert')),
  }, 'Kopieren');
  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: e => { const f = e.target.files[0]; e.target.value = ''; if (f) importConfig(f).then(refresh); },
  });

  return [
    h('h3', null, 'Spotify-App'),
    h('label', null, 'Client-ID', clientInput),
    h('label', null, 'Redirect-URI (genau so im Dashboard eintragen)',
      h('div', { class: 'inline' }, h('code', null, REDIRECT_URI), copyBtn)),

    h('h3', null, 'Tablet'),
    switchRow('Bildschirm anlassen', state.keepAwake,
      v => { state.keepAwake = v; save(); applyWakeLock().then(refresh); },
      'Nötig, damit Zeitplan und Wächter laufen. ' + (wakeLockActive() ? 'Aktuell aktiv.' : 'Aktuell nicht aktiv (vom Browser nicht erlaubt oder nicht unterstützt).')),

    h('h3', null, 'PIN-Schutz'),
    h('p', { class: 'hint' }, 'Die PIN schützt die Einstellungen vor versehentlicher Bedienung. Sie ist kein Schutz gegen technisch versierte Personen. Vergessen? Dann in Chrome die Website-Daten der Seite löschen (Zonen und Anmeldungen müssen danach neu eingerichtet werden).'),
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: () => setPin(refresh) }, state.pin ? 'PIN ändern' : 'PIN festlegen'),
      state.pin ? h('button', { class: 'ghost danger', onclick: () => { if (confirm('PIN-Schutz entfernen?')) { state.pin = null; save(); refresh(); } } }, 'PIN entfernen') : null),

    h('h3', null, 'Sicherung'),
    h('p', { class: 'hint' }, 'Exportiert Zonen, Schnellwahl, Limits und Zeitplan (ohne Spotify-Anmeldungen und PIN) – praktisch für ein zweites Tablet oder nach einem Zurücksetzen.'),
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: exportConfig }, 'Exportieren'),
      h('button', { class: 'ghost', onclick: () => fileInput.click() }, 'Importieren …'),
      fileInput),
  ];
}

function zoneBlock(z, refresh) {
  const maxLabel = h('span', { class: 'val' }, `${z.maxVolume} %`);
  return h('div', { class: 'zone-set' },
    h('div', { class: 'zone-row' },
      h('input', {
        type: 'text', value: z.name, 'aria-label': 'Zonenname',
        onchange: e => { z.name = e.target.value.trim() || z.name; save(); render(); refresh(); },
      }),
      z.auth
        ? h('button', { class: 'ghost', onclick: () => { logout(z); refresh(); } }, 'Abmelden')
        : h('button', { class: 'ghost', onclick: () => login(z.id) }, 'Anmelden')),
    h('p', { class: 'hint' }, z.auth ? `Angemeldet als ${z.user?.name || 'Spotify'}${z.deviceName ? ' · ' + z.deviceName : ''}` : 'Nicht angemeldet'),
    h('label', { class: 'slider-row' }, h('span', null, 'Maximale Lautstärke'),
      h('input', {
        type: 'range', min: 10, max: 100, step: 5, value: z.maxVolume,
        oninput: e => { maxLabel.textContent = e.target.value + ' %'; },
        onchange: e => { z.maxVolume = +e.target.value; save(); paint(z); limitCheck(z); },
      }), maxLabel),
    switchRow('Wächter', z.guard,
      v => { z.guard = v; R(z).guardMiss = 0; save(); paint(z); },
      'Startet die Wiedergabe neu, wenn sie unerwartet stoppt (Lautsprecher kurz offline, Playlist zu Ende). Nach „Pause“ in dieser App bleibt es still. Nur für Accounts einschalten, die ausschließlich dieser Zone dienen.'),
    z.favorites.length
      ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Schnellwahl'),
        h('div', { class: 'fav-chips' }, z.favorites.map(f =>
          h('span', { class: 'fav-chip' }, f.name,
            h('button', {
              'aria-label': `${f.name} entfernen`,
              onclick: () => { z.favorites = z.favorites.filter(x => x.uri !== f.uri); save(); paint(z); refresh(); },
            }, '×')))))
      : null,
    h('div', { class: 'actions' }, h('button', { class: 'ghost danger', onclick: () => removeZone(z, refresh) }, 'Zone entfernen')));
}

function removeZone(z, refresh) {
  if (!confirm(`Zone „${z.name}“ mit allen Terminen entfernen?`)) return;
  state.zones = state.zones.filter(x => x !== z);
  state.schedule = state.schedule.filter(r => r.zoneId !== z.id);
  delete runtime[z.id];
  save(); render(); refresh();
}

function tabZones(refresh) {
  return [
    ...state.zones.map(z => zoneBlock(z, refresh)),
    h('button', { class: 'ghost', onclick: () => { state.zones.push(newZone('Neue Zone')); save(); render(); refresh(); } }, '+ Zone hinzufügen'),
  ];
}

function ruleRow(rule, refresh) {
  return h('div', { class: 'rule-row' + (rule.enabled ? '' : ' off') },
    h('label', { class: 'mini-switch', 'aria-label': 'Termin aktiv' },
      h('input', {
        type: 'checkbox', checked: rule.enabled,
        onchange: e => { rule.enabled = e.target.checked; if (rule.enabled) armRule(rule); save(); paintAll(); refresh(); },
      }),
      h('span', { class: 'sw' })),
    h('button', { class: 'rule-main', onclick: () => openRuleEditor(rule, refresh) },
      h('b', null, `${rule.time} · ${formatDays(rule.days)}`),
      h('small', null, describeAction(rule))));
}

function tabSchedule(refresh) {
  const nodes = [h('p', { class: 'hint' }, 'Termine laufen nur, solange diese App geöffnet ist und der Bildschirm an bleibt („Bildschirm anlassen“ unter Allgemein). Verpasste Termine werden bis 5 Minuten danach nachgeholt.')];
  for (const z of state.zones) {
    const rules = state.schedule.filter(r => r.zoneId === z.id).sort((a, b) => a.time.localeCompare(b.time));
    nodes.push(h('h3', null, z.name));
    if (rules.length) rules.forEach(r => nodes.push(ruleRow(r, refresh)));
    else nodes.push(h('p', { class: 'hint' }, 'Keine Termine.'));
  }
  nodes.push(h('button', { class: 'primary', onclick: () => openRuleEditor(null, refresh) }, '+ Termin hinzufügen'));
  return nodes;
}

function tabLog(refresh) {
  const log = readLog();
  const when = t => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  return [
    h('p', { class: 'hint' }, 'Die letzten Ereignisse: Termine, Eingriffe des Wächters, Anmeldungen.'),
    log.length
      ? h('div', { class: 'log' }, log.map(e => h('div', { class: 'log-row' + (e.ok ? '' : ' bad') },
        h('time', null, when(e.t)), h('span', { class: 'txt' }, (e.zone ? e.zone + ': ' : '') + e.text))))
      : h('p', { class: 'hint' }, 'Noch keine Einträge.'),
    log.length ? h('button', { class: 'ghost', onclick: () => { clearLog(); refresh(); } }, 'Protokoll löschen') : null,
  ];
}

/* ---------- Zeitplan-Editor ---------- */

function validateRule(d) {
  const z = zoneById(d.zoneId);
  if (!z) return 'Bitte eine Zone wählen.';
  if (!d.days.length) return 'Bitte mindestens einen Wochentag wählen.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) return 'Bitte eine Uhrzeit wählen.';
  if (d.action === 'play' && !d.playlistUri && !z.playlistUri) return 'Für „Start“ bitte eine Playlist wählen (die Zone hat noch keine).';
  if (d.action === 'volume' && d.volume == null) return 'Bitte eine Lautstärke wählen.';
  return null;
}

function openRuleEditor(existing, onDone) {
  if (!state.zones.length) return toast('Zuerst eine Zone anlegen.');
  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : { id: newId('t'), zoneId: state.zones[0].id, enabled: true, days: [...ALL_DAYS], time: '08:00', action: 'play', playlistUri: null, playlistName: null, volume: null, lastRun: null };
  const body = openModal(existing ? 'Termin bearbeiten' : 'Neuer Termin');
  const msg = h('div', { class: 'err' });

  const preset = (label, days) => h('button', { class: 'ghost mini', onclick: () => { draft.days = [...days]; draw(); } }, label);

  const volumeRow = () => {
    const label = h('span', { class: 'val' }, `${draft.volume} %`);
    return h('label', { class: 'slider-row' }, h('span', null, 'Lautstärke'),
      h('input', {
        type: 'range', min: 0, max: 100, step: 5, value: draft.volume,
        oninput: e => { draft.volume = +e.target.value; label.textContent = `${draft.volume} %`; },
      }), label);
  };

  const choosePlaylistForRule = zone => {
    if (!zone.auth) return toast('Diese Zone ist noch nicht bei Spotify angemeldet.');
    pickPlaylist(zone, p => { draft.playlistUri = p.uri; draft.playlistName = p.name; closeModal(); draw(); });
  };

  const save_ = () => {
    const problem = validateRule(draft);
    if (problem) { msg.textContent = problem; return; }
    armRule(draft);
    if (existing) Object.assign(existing, draft);
    else state.schedule.push(draft);
    save(); closeModal(); paintAll(); onDone?.();
  };

  const runNow = () => {
    const problem = validateRule(draft);
    if (problem) { msg.textContent = problem; return; }
    msg.textContent = '';
    toast('Termin wird ausgeführt …');
    executeRule(draft).then(ok => toast(ok ? 'Ausgeführt.' : 'Fehlgeschlagen – Details im Protokoll.'));
  };

  const remove = () => {
    if (!confirm('Diesen Termin löschen?')) return;
    state.schedule = state.schedule.filter(r => r !== existing);
    save(); closeModal(); paintAll(); onDone?.();
  };

  function draw() {
    const zone = zoneById(draft.zoneId);
    const parts = [
      h('label', null, 'Zone',
        h('select', {
          onchange: e => { draft.zoneId = e.target.value; draft.playlistUri = null; draft.playlistName = null; draw(); },
        }, state.zones.map(z => h('option', { value: z.id, selected: z.id === draft.zoneId }, z.name)))),

      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Aktion'),
        h('div', { class: 'seg' }, [['play', 'Start'], ['pause', 'Pause'], ['volume', 'Lautstärke']].map(([id, label]) =>
          h('button', {
            class: 'seg-btn' + (draft.action === id ? ' on' : ''),
            onclick: () => { draft.action = id; if (id === 'volume' && draft.volume == null) draft.volume = 30; draw(); },
          }, label)))),

      h('label', null, 'Uhrzeit',
        h('input', { type: 'time', value: draft.time, onchange: e => { if (/^\d\d:\d\d$/.test(e.target.value)) draft.time = e.target.value; } })),

      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Wochentage'),
        h('div', { class: 'days' }, ALL_DAYS.map(d =>
          h('button', {
            class: 'day' + (draft.days.includes(d) ? ' on' : ''), 'aria-pressed': String(draft.days.includes(d)),
            onclick: () => { draft.days = draft.days.includes(d) ? draft.days.filter(x => x !== d) : [...draft.days, d]; draw(); },
          }, DAY_NAMES[d]))),
        h('div', { class: 'day-presets' }, preset('Täglich', ALL_DAYS), preset('Mo–Fr', [1, 2, 3, 4, 5]), preset('Wochenende', [6, 0]))),

      draft.action === 'play'
        ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Playlist'),
          h('div', { class: 'inline' },
            h('button', { class: 'pick', onclick: () => choosePlaylistForRule(zone) }, h('span', { class: 'val' }, draft.playlistName || 'Aktuelle Playlist der Zone')),
            draft.playlistUri ? h('button', { class: 'ghost', onclick: () => { draft.playlistUri = null; draft.playlistName = null; draw(); } }, 'Zurücksetzen') : null))
        : null,

      draft.action === 'play'
        ? switchRow('Lautstärke setzen', draft.volume != null, v => { draft.volume = v ? (draft.volume ?? 30) : null; draw(); })
        : null,
      draft.action !== 'pause' && draft.volume != null ? volumeRow() : null,

      msg,
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: save_ }, 'Speichern'),
        h('button', { class: 'ghost', onclick: runNow }, 'Jetzt ausführen'),
        existing ? h('button', { class: 'ghost danger', onclick: remove }, 'Löschen') : null)];
    body.replaceChildren(...parts.filter(Boolean)); // weggefallene Teile sind null und dürfen nicht als Text erscheinen
  }
  draw();
}

/* ---------- Einstellungen öffnen ---------- */

function openSettingsModal(startTab = 'general') {
  const body = openModal('Einstellungen', { wide: true });
  const tabs = [['general', 'Allgemein', tabGeneral], ['zones', 'Zonen', tabZones], ['schedule', 'Zeitplan', tabSchedule], ['log', 'Protokoll', tabLog]];
  let current = startTab;
  const content = h('div', { class: 'tab-content' });
  const nav = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) =>
    h('button', { class: 'tab', role: 'tab', 'data-tab': id, onclick: () => show(id) }, label)));

  function show(id) {
    current = id;
    nav.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
    const build = tabs.find(t => t[0] === id)[2];
    content.replaceChildren(...build(() => show(current)).filter(Boolean));
  }

  body.append(nav, content);
  show(current);
}

function openSettings() {
  return withPin(() => openSettingsModal());
}
