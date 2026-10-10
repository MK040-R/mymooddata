/**
 * Mood bot for Telegram, running inside a Google Sheet.
 *
 * Asks "How are you feeling now?" 1 to 4 times a day, logs each answer to the
 * "Mood log" tab, and sends weekly and monthly reports with a chart.
 *
 * Setup: paste this whole file into Extensions > Apps Script, save, reload the
 * spreadsheet, then click  Mood bot > Connect Telegram bot  in the menu bar.
 */

const QUESTION = 'How are you feeling now?';
const MOODS = ['happy', 'normal', 'unpleasant'];
const EMOJI = { happy: '😊', normal: '😐', unpleasant: '😣' };
const LABEL = { happy: 'Happy', normal: 'Normal', unpleasant: 'Unpleasant' };
const COLOR = { happy: '#2e9e5b', normal: '#9aa3ad', unpleasant: '#d1495b' };
const SCORE = { happy: 1, normal: 0, unpleasant: -1 };
const LOG_SHEET = 'Mood log';
const DEFAULTS = { first: '09:00', last: '21:00', perDay: 2 };
const LATE_LIMIT_MIN = 30;        // a check-in more than this late is skipped, not sent
const REPORT_LATE_LIMIT_MIN = 360;

const VERSION = 2; // bump when the menu/buttons change, so the bot re-sends them once

// The always-visible buttons where the phone keyboard normally sits.
const BTN = { week: '📊 Week', month: '📅 Month', year: '📈 Year', settings: '⚙️ Settings' };
const MAIN_KEYBOARD = {
  keyboard: [[{ text: BTN.week }, { text: BTN.month }, { text: BTN.year }], [{ text: BTN.settings }]],
  resize_keyboard: true,
  is_persistent: true,
};
const FIRST_CHOICES = ['05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00'];
const LAST_CHOICES = ['16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];
const TZ_CHOICES = [
  ['🇮🇳 India', 'Asia/Kolkata'], ['🇦🇪 UAE', 'Asia/Dubai'], ['🇸🇬 Singapore', 'Asia/Singapore'],
  ['🇬🇧 UK', 'Europe/London'], ['🇩🇪 Central Europe', 'Europe/Berlin'], ['🇺🇸 US East', 'America/New_York'],
  ['🇺🇸 US West', 'America/Los_Angeles'], ['🇦🇺 Sydney', 'Australia/Sydney'],
];

const HELP = [
  'I ask “How are you feeling now?” a few times a day. Tap an answer, that\'s it.',
  '',
  'Use the buttons below: 📊 📅 📈 for stats and a chart, ⚙️ to change the schedule.',
].join('\n');

// ---------------------------------------------------------------- menu & setup

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🙂 Mood bot')
    .addItem('Connect Telegram bot', 'connectBot')
    .addItem('Disconnect', 'disconnectBot')
    .addToUi();
}

function connectBot() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Connect Telegram bot', 'Paste the bot token from @BotFather:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const token = res.getResponseText().trim();
  const me = tg_('getMe', {}, token);
  if (!me.ok) {
    ui.alert('That token did not work (' + me.description + '). Copy it again from @BotFather and retry.');
    return;
  }
  props_().setProperty('TOKEN', token);
  logSheet_();
  tg_('deleteWebhook', {});
  setCommands_();
  removeTriggers_();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  ui.alert('Connected to @' + me.result.username + '.\n\nNow open Telegram, search for @' +
    me.result.username + ' and send /start.\n\nYou can close this tab. It keeps running on Google\'s side.');
}

function setCommands_() {
  tg_('setMyCommands', {
    commands: [
      { command: 'settings', description: 'Schedule, timezone, pause' },
      { command: 'week', description: 'Last 7 days' },
      { command: 'month', description: 'Last 30 days' },
      { command: 'year', description: 'Last 365 days' },
      { command: 'start', description: 'Start, or bring the buttons back' },
    ],
  });
}

function disconnectBot() {
  removeTriggers_();
  props_().deleteProperty('TOKEN');
  SpreadsheetApp.getUi().alert('Disconnected. Your mood log stays in this sheet.');
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'tick')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ---------------------------------------------------------------- main loop (every minute)

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    if (!props_().getProperty('TOKEN')) return;
    upgrade_();
    processUpdates_();
    runSchedule_(new Date());
  } finally {
    lock.releaseLock();
  }
}

/** After new code is pasted in: refresh the menu and send the new buttons once. */
function upgrade_() {
  const p = props_();
  if (Number(p.getProperty('VERSION') || 0) >= VERSION) return;
  p.setProperty('VERSION', String(VERSION));
  setCommands_();
  const chatId = p.getProperty('CHAT_ID');
  if (chatId) tg_('sendMessage', { chat_id: chatId, text: 'Updated: buttons are below. Tap ⚙️ Settings to change the schedule.', reply_markup: MAIN_KEYBOARD });
}

function processUpdates_() {
  const p = props_();
  const offset = Number(p.getProperty('OFFSET') || 0);
  const res = tg_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  if (!res.ok) return;
  res.result.forEach(u => {
    // Advance first, so one bad update can't block the queue forever.
    p.setProperty('OFFSET', String(u.update_id + 1));
    try {
      if (u.message) handleMessage_(u.message);
      else if (u.callback_query && String(u.callback_query.data).indexOf('s:') === 0) handleSettings_(u.callback_query);
      else if (u.callback_query) handleAnswer_(u.callback_query);
    } catch (e) {
      console.error(e);
    }
  });
}

function runSchedule_(now) {
  const s = settings_();
  if (!s.chatId || !s.active) return;
  const p = props_();
  const done = JSON.parse(p.getProperty('DONE') || '[]');
  const due = (key, at, limit) => {
    const late = (now - at) / 60000;
    if (late < 0 || late >= limit || done.indexOf(key) >= 0) return false;
    done.push(key);
    return true;
  };

  // Reports only for periods after setup; no "your week" for a week that predates the bot.
  const since = new Date(p.getProperty('SINCE') || 0);
  const today = localYmd_(now, s.tz);
  const slots = slotMinutes_(s.first, s.last, s.perDay);
  // Yesterday too, for schedules that run past midnight.
  [addDays_(today, -1), today].forEach(day => {
    slots.forEach((m, i) => {
      if (due('ask:' + day + ':' + i, localToDate_(day, m, s.tz), LATE_LIMIT_MIN)) ask_(s.chatId, now);
    });
    // Weekly report: Sunday, 30 minutes after the last check-in.
    const weekAt = localToDate_(day, slots[slots.length - 1] + 30, s.tz);
    if (weekday_(day) === 0 && weekAt > since &&
        due('week:' + day, weekAt, REPORT_LATE_LIMIT_MIN)) {
      sendReport_(s, addDays_(day, -6), addDays_(day, 1), 'Your week');
    }
  });
  // Monthly report: the 1st, at the first check-in, covering last month.
  const monthAt = localToDate_(today, slots[0], s.tz);
  if (today.slice(8) === '01' && monthAt > since && due('month:' + today, monthAt, REPORT_LATE_LIMIT_MIN)) {
    const prevStart = addDays_(today, -1).slice(0, 8) + '01';
    sendReport_(s, prevStart, today, formatYmd_(prevStart, s.tz, 'MMMM yyyy'));
  }
  p.setProperty('DONE', JSON.stringify(done.slice(-60)));
}

// ---------------------------------------------------------------- telegram handlers

function handleMessage_(msg) {
  let text = (msg.text || '').trim();
  Object.keys(BTN).forEach(k => { if (text === BTN[k]) text = '/' + k; });
  if (text.charAt(0) !== '/') return; // not a chat bot: plain text is ignored
  const parts = text.split(/\s+/);
  const cmd = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1);
  const chatId = String(msg.chat.id);
  const p = props_();
  const owner = p.getProperty('CHAT_ID');

  if (!owner) {
    if (cmd !== '/start') return;
    p.setProperties({
      CHAT_ID: chatId,
      SINCE: new Date().toISOString(),
      TZ: SpreadsheetApp.getActive().getSpreadsheetTimeZone(),
      FIRST: DEFAULTS.first, LAST: DEFAULTS.last, PER_DAY: String(DEFAULTS.perDay),
    });
  } else if (owner !== chatId) {
    send_(chatId, 'This bot is private.');
    return;
  }

  const s = settings_();
  switch (cmd) {
    case '/start':
      p.setProperty('ACTIVE', 'true');
      tg_('sendMessage', { chat_id: chatId, text: 'Mood tracker is on.\n' + describe_(settings_()) + '\n\n' + HELP, reply_markup: MAIN_KEYBOARD });
      return;
    case '/stop':
      p.setProperty('ACTIVE', 'false');
      send_(chatId, 'Paused. Your data is kept. ⚙️ Settings → Resume to restart.');
      return;
    case '/settings':
    case '/frequency':
      if (cmd === '/frequency' && args.length) setPerDay_(chatId, args[0]);
      else showPanel_(chatId, null, 'main');
      return;
    case '/settime':
      if (!args.length) { showPanel_(chatId, null, 'main'); return; }
      if (args.length !== 2 || !isHhmm_(args[0]) || !isHhmm_(args[1])) {
        send_(chatId, 'Give two times, e.g. /settime 09:00 21:00, or use ⚙️ Settings.');
        return;
      }
      p.setProperties({ FIRST: pad_(args[0]), LAST: pad_(args[1]) });
      send_(chatId, 'Updated.\n' + describe_(settings_()));
      return;
    case '/timezone':
      if (!args.length) { showPanel_(chatId, null, 'tz'); return; }
      if (!isTimezone_(args[0])) {
        send_(chatId, 'Unknown timezone. Use a name like Asia/Kolkata or Europe/Berlin, or pick one in ⚙️ Settings.');
        return;
      }
      setTimezone_(args[0]);
      send_(chatId, 'Updated.\n' + describe_(settings_()));
      return;
    case '/week':
    case '/month':
    case '/year': {
      const days = { '/week': 7, '/month': 30, '/year': 365 }[cmd];
      const end = addDays_(localYmd_(new Date(), s.tz), 1);
      sendReport_(s, addDays_(end, -days), end, 'Last ' + days + ' days');
      return;
    }
    default:
      tg_('sendMessage', { chat_id: chatId, text: HELP, reply_markup: MAIN_KEYBOARD });
  }
}

function setPerDay_(chatId, value) {
  const n = Number(value);
  if (!(n >= 1 && n <= 4 && Math.floor(n) === n)) {
    send_(chatId, 'Check-ins per day must be 1, 2, 3 or 4.');
    return;
  }
  props_().setProperty('PER_DAY', String(n));
  send_(chatId, 'Updated.\n' + describe_(settings_()));
}

function setTimezone_(tz) {
  props_().setProperty('TZ', tz);
  SpreadsheetApp.getActive().setSpreadsheetTimeZone(tz); // so the log's timestamps match
}

// ---------------------------------------------------------------- settings panel (inline buttons)
// Callback data: s:<view> to switch view, s:n:<1-4>, s:f:<idx>, s:l:<idx>, s:z:<idx>, s:pause, s:resume

/** Sends (messageId null) or redraws the settings panel. view: main | first | last | tz */
function showPanel_(chatId, messageId, view) {
  const s = settings_();
  const btn = (text, data) => ({ text: text, callback_data: data });
  const grid = (items, perRow) => {
    const rows = [];
    for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
    return rows;
  };
  const back = [btn('« Back', 's:main')];
  let text, rows;
  if (view === 'first') {
    text = 'First check-in of the day:';
    rows = grid(FIRST_CHOICES.map((t, i) => btn((t === s.first ? '✓ ' : '') + t, 's:f:' + i)), 4).concat([back]);
  } else if (view === 'last') {
    text = 'Last check-in of the day:';
    rows = grid(LAST_CHOICES.map((t, i) => btn((t === s.last ? '✓ ' : '') + t, 's:l:' + i)), 4).concat([back]);
  } else if (view === 'tz') {
    text = 'Your timezone (now ' + s.tz + '):\nNot listed? Type /timezone Area/City, e.g. /timezone Asia/Tokyo';
    rows = grid(TZ_CHOICES.map((z, i) => btn((z[1] === s.tz ? '✓ ' : '') + z[0], 's:z:' + i)), 2).concat([back]);
  } else {
    text = '⚙️ ' + describe_(s) + '\n\nCheck-ins per day:';
    rows = [
      [1, 2, 3, 4].map(n => btn((n === s.perDay ? '✓ ' : '') + n, 's:n:' + n)),
      [btn('🌅 First: ' + s.first, 's:first'), btn('🌙 Last: ' + s.last, 's:last')],
      [btn('🌍 Timezone', 's:tz'), s.active ? btn('⏸ Pause', 's:pause') : btn('▶️ Resume', 's:resume')],
    ];
  }
  const params = { chat_id: chatId, text: text, reply_markup: { inline_keyboard: rows } };
  if (messageId) {
    params.message_id = messageId;
    tg_('editMessageText', params);
  } else {
    tg_('sendMessage', params);
  }
}

function handleSettings_(q) {
  const chatId = String(q.message.chat.id);
  if (chatId !== props_().getProperty('CHAT_ID')) return;
  const p = props_();
  const parts = String(q.data).split(':');
  const action = parts[1], idx = Number(parts[2]);
  let view = 'main', toast = 'Saved';
  if (action === 'n' && idx >= 1 && idx <= 4) p.setProperty('PER_DAY', String(idx));
  else if (action === 'f' && FIRST_CHOICES[idx]) p.setProperty('FIRST', FIRST_CHOICES[idx]);
  else if (action === 'l' && LAST_CHOICES[idx]) p.setProperty('LAST', LAST_CHOICES[idx]);
  else if (action === 'z' && TZ_CHOICES[idx]) setTimezone_(TZ_CHOICES[idx][1]);
  else if (action === 'pause') { p.setProperty('ACTIVE', 'false'); toast = 'Paused'; }
  else if (action === 'resume') { p.setProperty('ACTIVE', 'true'); toast = 'Resumed'; }
  else { view = action; toast = ''; } // just switching view
  tg_('answerCallbackQuery', { callback_query_id: q.id, text: toast });
  showPanel_(chatId, q.message.message_id, view);
}

function handleAnswer_(q) {
  const parts = String(q.data || '').split(':');
  const id = Number(parts[1]);
  const mood = parts[2];
  const chatId = String(q.message.chat.id);
  if (parts[0] !== 'm' || MOODS.indexOf(mood) < 0 || chatId !== props_().getProperty('CHAT_ID')) return;

  const sheet = logSheet_();
  const row = id + 1; // row 1 is the header
  let recorded = false;
  if (row >= 2 && row <= sheet.getLastRow() && Number(sheet.getRange(row, 1).getValue()) === id &&
      sheet.getRange(row, 3).getValue() === '') {
    sheet.getRange(row, 3, 1, 2).setValues([[LABEL[mood], new Date()]]);
    recorded = true;
  }
  tg_('answerCallbackQuery', { callback_query_id: q.id, text: recorded ? 'Noted' : 'Already recorded' });
  if (recorded) {
    tg_('editMessageText', {
      chat_id: chatId, message_id: q.message.message_id,
      text: QUESTION + '\n' + EMOJI[mood] + ' ' + LABEL[mood] + '. Noted.',
    });
  } else {
    tg_('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id });
  }
}

function ask_(chatId, now) {
  const sheet = logSheet_();
  const id = sheet.getLastRow(); // header is row 1, so the first check-in gets id 1
  sheet.appendRow([id, now, '', '']);
  tg_('sendMessage', {
    chat_id: chatId,
    text: QUESTION,
    reply_markup: {
      inline_keyboard: [MOODS.map(m => ({ text: EMOJI[m] + ' ' + LABEL[m], callback_data: 'm:' + id + ':' + m }))],
    },
  });
}

function describe_(s) {
  const times = slotMinutes_(s.first, s.last, s.perDay).map(minToHhmm_).join(', ');
  return 'Check-ins: ' + s.perDay + '× a day at ' + times + ' (' + s.tz + '), ' +
    (s.active ? 'active' : 'paused') + '.\nWeekly report on Sunday evening, monthly report on the 1st.';
}

// ---------------------------------------------------------------- reports

/** Sends stats and a chart for local days [startYmd, endYmd). */
function sendReport_(s, startYmd, endYmd, title) {
  const span = daysBetween_(startYmd, endYmd);
  const rows = readLog_();
  const inRange = (a, b) => {
    const from = localToDate_(a, 0, s.tz), to = localToDate_(b, 0, s.tz);
    return rows.filter(r => r.asked >= from && r.asked < to);
  };
  const current = inRange(startYmd, endYmd);
  const previous = inRange(addDays_(startYmd, -span), startYmd);
  const sameYear = startYmd.slice(0, 4) === addDays_(endYmd, -1).slice(0, 4);
  const heading = title + ' (' + formatYmd_(startYmd, s.tz, sameYear ? 'd MMM' : 'd MMM yyyy') + ' – ' +
    formatYmd_(addDays_(endYmd, -1), s.tz, 'd MMM yyyy') + ')';

  const chart = buildChart_(current, s.tz, startYmd, endYmd, heading);
  if (chart) {
    const token = props_().getProperty('TOKEN');
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendPhoto', {
      method: 'post', payload: { chat_id: s.chatId, photo: chart }, muteHttpExceptions: true,
    });
  }
  tg_('sendMessage', { chat_id: s.chatId, text: '<pre>' + escapeHtml_(summarize_(current, previous, s.tz, heading)) + '</pre>', parse_mode: 'HTML' });
}

function summarize_(rows, previous, tz, title) {
  const answered = rows.filter(r => r.mood);
  if (!answered.length) return '📊 ' + title + '\n\nNo check-ins answered in this period. Hard to graph a mystery.';
  const n = answered.length;
  const count = m => answered.filter(r => r.mood === m).length;
  const pct = (a, b) => (b ? (100 * a) / b : 0);
  const score = list => list.reduce((t, r) => t + SCORE[r.mood], 0) / list.length;
  const sign = x => (x >= 0 ? '+' : '') + x.toFixed(2);

  const lines = ['📊 ' + title, ''];
  MOODS.forEach(m => {
    lines.push(EMOJI[m] + ' ' + (LABEL[m] + '          ').slice(0, 10) + ' ' +
      ('     ' + pct(count(m), n).toFixed(1)).slice(-5) + '%  (' + count(m) + ')');
  });
  const sc = score(answered);
  lines.push('', 'Mood score: ' + sign(sc) + '  (scale −1 to +1)');
  lines.push('Answered ' + n + ' of ' + rows.length + ' check-ins (' + Math.round(pct(n, rows.length)) + '%)');

  const prev = previous.filter(r => r.mood);
  if (prev.length) {
    const dHappy = pct(count('happy'), n) - pct(prev.filter(r => r.mood === 'happy').length, prev.length);
    lines.push('vs previous period: Happy ' + (dHappy >= 0 ? '+' : '') + Math.round(dHappy) + ' pts, score ' + sign(sc - score(prev)));
  }

  const groupBy = fmt => {
    const g = {};
    answered.forEach(r => { const k = Utilities.formatDate(r.asked, tz, fmt); (g[k] = g[k] || []).push(r); });
    return g;
  };
  const byHour = groupBy('HH');
  const hours = Object.keys(byHour).sort();
  if (hours.length > 1) {
    lines.push('', 'By time of day:');
    hours.forEach(h => {
      const g = byHour[h];
      lines.push('  ~' + h + ':00  ' + ('  ' + Math.round(pct(g.filter(r => r.mood === 'happy').length, g.length))).slice(-3) +
        '% happy, score ' + sign(score(g)) + '  (n=' + g.length + ')');
    });
  }

  const first = answered[0].asked, last = answered[answered.length - 1].asked;
  if ((last - first) / 86400000 >= 13) {
    const byDay = groupBy('EEE');
    const ranked = Object.keys(byDay).sort((a, b) => score(byDay[a]) - score(byDay[b]));
    const best = ranked[ranked.length - 1], worst = ranked[0];
    lines.push('', 'Best day: ' + best + ' (' + sign(score(byDay[best])) + '), toughest: ' + worst + ' (' + sign(score(byDay[worst])) + ')');
  }
  return lines.join('\n');
}

/** Stacked column chart of answers per day (up to 31 days) or per week. Returns a PNG blob or null. */
function buildChart_(rows, tz, startYmd, endYmd, title) {
  const answered = rows.filter(r => r.mood);
  if (!answered.length) return null;
  const weekly = daysBetween_(startYmd, endYmd) > 31;
  const bucketOf = ymd => (weekly ? addDays_(ymd, -((weekday_(ymd) + 6) % 7)) : ymd);

  const buckets = [];
  for (let d = startYmd; d < endYmd; d = addDays_(d, 1)) {
    const b = bucketOf(d);
    if (buckets[buckets.length - 1] !== b) buckets.push(b);
  }
  const counts = {};
  buckets.forEach(b => { counts[b] = { happy: 0, normal: 0, unpleasant: 0 }; });
  answered.forEach(r => {
    const b = bucketOf(localYmd_(r.asked, tz));
    if (counts[b]) counts[b][r.mood]++;
  });

  try {
    const dt = Charts.newDataTable().addColumn(Charts.ColumnType.STRING, weekly ? 'Week of' : 'Day');
    MOODS.forEach(m => dt.addColumn(Charts.ColumnType.NUMBER, LABEL[m]));
    const fmt = weekly ? 'd MMM' : buckets.length <= 7 ? 'EEE d' : 'd';
    buckets.forEach(b => dt.addRow([formatYmd_(b, tz, fmt)].concat(MOODS.map(m => counts[b][m]))));
    return Charts.newColumnChart()
      .setDataTable(dt.build())
      .setStacked()
      .setColors(MOODS.map(m => COLOR[m]))
      .setTitle(title)
      .setYAxisTitle(weekly ? 'check-ins per week' : 'check-ins per day')
      .setLegendPosition(Charts.Position.RIGHT)
      .setDimensions(1000, 450)
      .build()
      .getAs('image/png')
      .setName('mood.png');
  } catch (e) {
    console.error('Chart failed, sending text only: ' + e);
    return null;
  }
}

// ---------------------------------------------------------------- storage

function props_() {
  return PropertiesService.getScriptProperties();
}

function settings_() {
  const p = props_();
  return {
    chatId: p.getProperty('CHAT_ID'),
    tz: p.getProperty('TZ') || SpreadsheetApp.getActive().getSpreadsheetTimeZone(),
    first: p.getProperty('FIRST') || DEFAULTS.first,
    last: p.getProperty('LAST') || DEFAULTS.last,
    perDay: Number(p.getProperty('PER_DAY') || DEFAULTS.perDay),
    active: p.getProperty('ACTIVE') !== 'false',
  };
}

function logSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET, 0);
    sheet.appendRow(['#', 'Asked at', 'Mood', 'Answered at']);
    sheet.setFrozenRows(1);
    sheet.getRange('A1:D1').setFontWeight('bold');
    sheet.getRange('B:B').setNumberFormat('ddd d mmm yyyy, hh:mm');
    sheet.getRange('D:D').setNumberFormat('ddd d mmm yyyy, hh:mm');
  }
  return sheet;
}

function readLog_() {
  const sheet = logSheet_();
  if (sheet.getLastRow() < 2) return [];
  const byLabel = {};
  MOODS.forEach(m => { byLabel[LABEL[m]] = m; });
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues()
    .filter(r => r[1] instanceof Date)
    .map(r => ({ asked: r[1], mood: byLabel[r[2]] || null }));
}

// ---------------------------------------------------------------- telegram api

function tg_(method, params, token) {
  token = token || props_().getProperty('TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(params), muteHttpExceptions: true,
  });
  try {
    return JSON.parse(res.getContentText());
  } catch (e) {
    return { ok: false, description: 'HTTP ' + res.getResponseCode() };
  }
}

function send_(chatId, text) {
  return tg_('sendMessage', { chat_id: chatId, text: text });
}

// ---------------------------------------------------------------- time helpers
// Dates as 'yyyy-MM-dd' strings in the user's timezone; times as minutes after midnight.

function slotMinutes_(first, last, perDay) {
  const s = hhmmToMin_(first);
  if (perDay === 1) return [s];
  let e = hhmmToMin_(last);
  if (e <= s) e += 1440; // window crosses midnight
  const step = (e - s) / (perDay - 1);
  const out = [];
  for (let i = 0; i < perDay; i++) out.push(Math.round(s + step * i));
  return out;
}

function isHhmm_(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

function isTimezone_(tz) {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)+$/.test(tz)) return false;
  // Unknown zones silently fall back to GMT, so reject anything that formats like GMT but isn't.
  return Utilities.formatDate(new Date(), tz, 'Z') !== '+0000' || /^(Etc\/|Europe\/(London|Dublin|Lisbon)|Africa\/|Atlantic\/|UTC|GMT)/.test(tz);
}

function pad_(hhmm) {
  return minToHhmm_(hhmmToMin_(hhmm));
}

function hhmmToMin_(s) {
  const p = s.split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}

function minToHhmm_(m) {
  m = ((m % 1440) + 1440) % 1440;
  return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
}

function localYmd_(date, tz) {
  return Utilities.formatDate(date, tz, 'yyyy-MM-dd');
}

/** The instant when it is `minutes` past midnight of local day `ymd` in `tz` (minutes may exceed 1440). */
function localToDate_(ymd, minutes, tz) {
  const p = ymd.split('-').map(Number);
  const guess = Date.UTC(p[0], p[1] - 1, p[2], 0, minutes);
  let t = guess - offsetMin_(new Date(guess), tz) * 60000;
  t = guess - offsetMin_(new Date(t), tz) * 60000; // settle around DST changes
  return new Date(t);
}

function offsetMin_(date, tz) {
  const z = Utilities.formatDate(date, tz, 'Z'); // e.g. +0530
  const sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (Number(z.substr(1, 2)) * 60 + Number(z.substr(3, 2)));
}

function addDays_(ymd, n) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}

function daysBetween_(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** 0 = Sunday … 6 = Saturday */
function weekday_(ymd) {
  return new Date(ymd + 'T12:00:00Z').getUTCDay();
}

function formatYmd_(ymd, tz, fmt) {
  return Utilities.formatDate(localToDate_(ymd, 720, tz), tz, fmt);
}

function escapeHtml_(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
