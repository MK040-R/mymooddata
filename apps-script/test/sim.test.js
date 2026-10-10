// Runs Code.js against fake Google Apps Script services. `node apps-script/test/sim.test.js`
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function formatDate(date, tz, fmt) {
  // Like Google (Java), an unknown timezone silently becomes GMT.
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (e) { tz = 'UTC'; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', weekday: 'short', timeZoneName: 'longOffset',
  }).formatToParts(date).map(p => [p.type, p.value]));
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'long' }).format(date);
  const off = parts.timeZoneName === 'GMT' ? '+0000' : parts.timeZoneName.replace('GMT', '').replace(':', '');
  return fmt.replace(/yyyy|MMMM|MMM|MM|dd|d|HH|EEE|Z/g, t => ({
    yyyy: parts.year, MMMM: month, MMM: month.slice(0, 3), MM: parts.month, dd: parts.day,
    d: String(Number(parts.day)), HH: parts.hour, EEE: parts.weekday, Z: off,
  })[t]);
}

function makeEnv(tz) {
  const props = {};
  const rows = [];
  const sent = [];
  let updates = [];
  let chartsWork = true;
  const sheet = {
    appendRow: r => rows.push(r.slice()),
    getLastRow: () => rows.length,
    setFrozenRows() {}, getRange(a, c, h, w) {
      if (typeof a === 'string') return { setFontWeight() {}, setNumberFormat() {} };
      return {
        getValue: () => (rows[a - 1] || [])[c - 1] ?? '',
        getValues: () => rows.slice(a - 1, a - 1 + h).map(r => r.slice(c - 1, c - 1 + w)),
        setValues: v => v.forEach((vr, i) => vr.forEach((x, j) => { rows[a - 1 + i][c - 1 + j] = x; })),
      };
    },
  };
  const ss = { getSheetByName: () => (rows.length ? sheet : null), insertSheet: () => sheet, getSpreadsheetTimeZone: () => tz, setSpreadsheetTimeZone: z => { tz = z; } };
  const chain = new Proxy({}, { get: (t, k) => (k === 'getAs' ? () => ({ setName: () => 'PNG' }) : () => chain) });
  const ctx = {
    console,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      setProperties: o => Object.assign(props, o), deleteProperty: k => delete props[k],
    }) },
    SpreadsheetApp: { getActive: () => ss },
    Utilities: { formatDate },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Charts: new Proxy({ ColumnType: {}, Position: {} }, { get: (t, k) => {
      if (k in t) return t[k];
      if (!chartsWork) throw new Error('no charts');
      return () => chain;
    } }),
    UrlFetchApp: { fetch(url, opts) {
      const method = url.split('/').pop();
      const body = opts.contentType ? JSON.parse(opts.payload) : opts.payload;
      let result = true;
      if (method === 'getUpdates') { result = updates.filter(u => u.update_id >= body.offset); updates = []; }
      else sent.push({ method, body });
      return { getContentText: () => JSON.stringify({ ok: true, result }), getResponseCode: () => 200 };
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../Code.js', 'utf8'), ctx);
  props.TOKEN = 'x';
  let uid = 1;
  return {
    ctx, props, rows, sent,
    msg: text => updates.push({ update_id: uid++, message: { chat: { id: 42 }, text } }),
    tap: (data, chat = 42) => updates.push({ update_id: uid++, callback_query: { id: 'q', data, message: { chat: { id: chat }, message_id: 7 } } }),
    tick: now => { const s = sent.length; ctx.processUpdates_(); ctx.runSchedule_(new (vm.runInContext('Date', ctx))(+now)); return sent.slice(s); },
    noCharts: () => { chartsWork = false; },
  };
}

const tz = 'Asia/Kolkata';
const at = (iso) => new Date(iso + '+05:30');
let ok = 0;
const test = (name, fn) => { fn(); ok++; console.log('ok -', name); };

test('slots', () => {
  const c = makeEnv(tz).ctx;
  assert.deepStrictEqual(Array.from(c.slotMinutes_('09:00', '21:00', 1)), [540]);
  assert.deepStrictEqual(Array.from(c.slotMinutes_('09:00', '21:00', 3)), [540, 900, 1260]);
  assert.deepStrictEqual(Array.from(c.slotMinutes_('09:00', '21:00', 4)), [540, 780, 1020, 1260]);
  assert.deepStrictEqual(Array.from(c.slotMinutes_('22:00', '02:00', 3)), [1320, 1440, 1560]);
  assert.strictEqual(c.localToDate_('2026-10-10', 540, tz).toISOString(), '2026-10-10T03:30:00.000Z');
  assert.strictEqual(c.localToDate_('2026-03-29', 120 + 60, 'Europe/Berlin').toISOString(), '2026-03-29T01:00:00.000Z');
});

test('only owner, ignores chit-chat', () => {
  const e = makeEnv(tz);
  e.msg('hello');
  assert.strictEqual(e.tick(at('2026-10-10T08:00')).length, 0);
  e.msg('/start');
  const out = e.tick(at('2026-10-10T08:00'));
  assert.match(out[0].body.text, /2× a day at 09:00, 21:00 \(Asia\/Kolkata\)/);
  assert.strictEqual(e.props.CHAT_ID, '42');
  e.ctx.handleMessage_({ chat: { id: 99 }, text: '/week' });
  assert.strictEqual(e.sent.at(-1).body.text, 'This bot is private.');
});

test('asks on time, once, skips when too late, answers once', () => {
  const e = makeEnv(tz);
  e.msg('/start'); e.tick(at('2026-10-10T08:00'));
  assert.strictEqual(e.tick(at('2026-10-10T08:59')).length, 0);
  let out = e.tick(at('2026-10-10T09:00'));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].body.text, 'How are you feeling now?');
  assert.strictEqual(out[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'm:1:happy');
  assert.strictEqual(e.tick(at('2026-10-10T09:01')).length, 0); // not twice
  e.tap('m:1:happy');
  out = e.tick(at('2026-10-10T09:02'));
  assert.deepStrictEqual(out.map(o => o.method), ['answerCallbackQuery', 'editMessageText']);
  assert.strictEqual(out[1].body.text, 'How are you feeling now?\n😊 Happy. Noted.');
  assert.strictEqual(e.rows[1][2], 'Happy');
  e.tap('m:1:unpleasant'); e.tap('m:1:happy', 99); e.tap('m:999:happy');
  e.tick(at('2026-10-10T09:03'));
  assert.strictEqual(e.rows[1][2], 'Happy');
  // 21:00 check-in missed entirely (script down until 21:45): skipped, not sent late
  assert.strictEqual(e.tick(at('2026-10-10T21:45')).filter(o => o.method === 'sendMessage').length, 0);
});

test('settings commands', () => {
  const e = makeEnv(tz);
  e.msg('/start'); e.msg('/frequency 4'); e.msg('/settime 7:00 22:00'); e.msg('/frequency 5'); e.msg('/timezone Mars/Olympus'); e.msg('/timezone Europe/Berlin');
  const out = e.tick(at('2026-10-10T06:00')).map(o => o.body.text);
  assert.match(out[1], /4× a day at 09:00, 13:00, 17:00, 21:00/);
  assert.match(out[2], /4× a day at 07:00, 12:00, 17:00, 22:00/);
  assert.match(out[3], /must be 1, 2, 3 or 4/);
  assert.match(out[4], /Give a timezone/);
  assert.match(out[5], /Europe\/Berlin/);
  e.msg('/stop'); e.tick(at('2026-10-10T06:00'));
  assert.strictEqual(e.tick(at('2026-10-11T07:00')).length, 0);
});

function simulateDays(e, startIso, days) {
  let d = at(startIso + 'T00:00');
  const moods = ['happy', 'happy', 'normal', 'unpleasant', 'happy'];
  let k = 0;
  for (let i = 0; i < days * 24 * 4; i++) { // every 15 minutes
    const out = e.tick(d);
    for (const o of out) {
      const kb = o.body.reply_markup;
      if (kb && k++ % 7 !== 6) e.tap(kb.inline_keyboard[0][0].callback_data.replace('happy', moods[k % 5]));
    }
    d = new Date(+d + 15 * 60000);
  }
}

test('weekly + monthly reports fire once, with stats', () => {
  const e = makeEnv(tz);
  e.msg('/start'); e.tick(at('2026-08-31T00:00')); e.props.SINCE = at('2026-08-31T00:00').toISOString();
  simulateDays(e, '2026-08-31', 42); // Mon 31 Aug .. Sun 11 Oct
  const photos = e.sent.filter(o => o.method === 'sendPhoto');
  const reports = e.sent.filter(o => o.body.parse_mode === 'HTML').map(o => o.body.text);
  assert.strictEqual(reports.filter(t => t.includes('Your week')).length, 6);
  assert.strictEqual(reports.filter(t => t.includes('September 2026')).length, 1);
  assert.strictEqual(reports.filter(t => t.includes('August 2026')).length, 1);
  assert.strictEqual(photos.length, 8);
  const last = reports.filter(t => t.includes('Your week')).at(-1);
  assert.match(last, /Your week \(5 Oct – 11 Oct 2026\)/);
  assert.match(last, /Answered \d+ of 14 check-ins/);
  assert.match(last, /By time of day/);
  console.log(last.replace(/<\/?pre>/g, ''));
  e.msg('/year'); e.tick(at('2026-10-12T10:00'));
  const year = e.sent.at(-1).body.text;
  assert.match(year, /Best day/);
  console.log(year.replace(/<\/?pre>/g, ''));
});

test('chart failure falls back to text, empty period', () => {
  const e = makeEnv(tz);
  e.noCharts();
  e.msg('/start'); e.msg('/week');
  const out = e.tick(at('2026-10-10T08:00'));
  assert.match(out.at(-1).body.text, /No check-ins answered/);
  assert.strictEqual(out.filter(o => o.method === 'sendPhoto').length, 0);
});

console.log(`\n${ok} passed`);
