// Чистые функции без зависимостей от Cloudflare — их удобно тестировать.

export const DEF_TZ = 'Asia/Vladivostok';
export const COLS = ['thoughts', 'habits', 'money', 'tasks', 'events', 'shop'];

export const emptyState = () => ({ v: 1, name: '', currency: '₽', thoughts: [], habits: [], money: [], tasks: [], events: [], shop: [] });

/* ---------- Проверка подписи Telegram Mini App (initData) ---------- */
const enc = new TextEncoder();
async function hmac(keyBytes, msg) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof msg === 'string' ? enc.encode(msg) : msg));
}
export const hex = (b) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

export async function signInitData(fields, token) { // для тестов
  const p = new URLSearchParams(fields);
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), token);
  p.set('hash', hex(await hmac(secret, dcs)));
  return p.toString();
}

export async function checkInitData(initData, token, maxAgeSec = 7 * 86400) {
  if (!initData || !token) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), token);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > maxAgeSec) return null;
  try { const u = JSON.parse(p.get('user')); return u && u.id ? u : null; } catch (e) { return null; }
}

export async function webhookSecret(token) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('wh:' + token)))).slice(0, 48);
}

/* ---------- Время и часовые пояса ---------- */
const fmtCache = new Map();
export function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return DEF_TZ; }
}
export function partsIn(tz, date = new Date()) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const x of f.formatToParts(date)) o[x.type] = x.value;
  const hour = o.hour === '24' ? '00' : o.hour;
  return { ymd: `${o.year}-${o.month}-${o.day}`, hm: `${hour}:${o.minute}` };
}
// Местные «дата + время» в поясе tz → момент времени (мс)
export function zonedToMs(ymd, hm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [H, M] = (hm || '00:00').split(':').map(Number);
  const want = Date.UTC(y, m - 1, d, H, M);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(tz, new Date(guess));
    const [py, pm, pd] = p.ymd.split('-').map(Number);
    const [pH, pM] = p.hm.split(':').map(Number);
    const diff = want - Date.UTC(py, pm - 1, pd, pH, pM);
    if (!diff) break;
    guess += diff;
  }
  return guess;
}
export const shiftYmd = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};
const toMin = (hm) => { const [h, m] = (hm || '0:0').split(':').map(Number); return h * 60 + m; };

/* ---------- Изменения данных ---------- */
export function applyOps(st, ops) {
  st = st || emptyState();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!Array.isArray(op)) continue;
    const [kind, col, x] = op;
    if (kind === 'replace' && col && typeof col === 'object') { st = Object.assign(emptyState(), col); continue; }
    if (kind === 'meta' && col && typeof col === 'object') {
      if (typeof col.name === 'string') st.name = col.name.slice(0, 40);
      if (typeof col.currency === 'string') st.currency = col.currency.slice(0, 3);
      continue;
    }
    if (!COLS.includes(col)) continue;
    const arr = Array.isArray(st[col]) ? st[col] : (st[col] = []);
    if (kind === 'put' && x && typeof x === 'object' && x.id) {
      const i = arr.findIndex(a => a.id === x.id);
      if (i >= 0) arr[i] = x; else arr.push(x);
    } else if (kind === 'del' && typeof x === 'string') {
      const i = arr.findIndex(a => a.id === x);
      if (i >= 0) arr.splice(i, 1);
    }
  }
  return st;
}
export const isEmptyState = (st) => !st || COLS.every(c => !st[c] || !st[c].length);

/* ---------- Тексты ---------- */
export const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const MON_G = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MON = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return (m10 === 1 && m100 !== 11) ? a : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) ? b : c; };
const money = (n, cur) => Math.round(n).toLocaleString('ru-RU').replace(/[  ]/g, ' ') + ' ' + (cur || '₽');
const wdOf = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
export const dayTitle = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${WD[wdOf(ymd)]}, ${d} ${MON_G[m - 1]}`; };

export function beforeLabel(min) {
  min = Number(min);
  if (min <= 0) return 'Сейчас';
  if (min < 60) return `Через ${min} ${plural(min, 'минуту', 'минуты', 'минут')}`;
  if (min % 1440 === 0) { const d = min / 1440; return d === 1 ? 'Завтра' : `Через ${d} ${plural(d, 'день', 'дня', 'дней')}`; }
  const h = Math.round(min / 60);
  return `Через ${h} ${plural(h, 'час', 'часа', 'часов')}`;
}

/* ---------- Напоминания ---------- */
// Возвращает список напоминаний, которые пора отправить в момент now (мс)
export function dueReminders(st, tz, now, scope, windowMin = 15) {
  const out = [];
  const today = partsIn(tz, new Date(now)).ymd;
  const lo = shiftYmd(today, -1), hi = shiftYmd(today, 2);
  for (const e of st.events || []) {
    if (!e || !e.date || e.remind === '' || e.remind == null || e.date < lo || e.date > hi) continue;
    const start = zonedToMs(e.date, e.time || '09:00', tz);
    const at = start - Number(e.remind) * 60000;
    if (at <= now && now - at < windowMin * 60000) {
      const when = e.time ? `${e.date === today ? 'сегодня' : e.date === shiftYmd(today, 1) ? 'завтра' : dayTitle(e.date)} в ${e.time}` : (e.date === today ? 'сегодня' : 'завтра');
      out.push({ key: `${scope}:e:${e.id}:${at}`, text: `⏰ <b>${beforeLabel(e.remind)}</b>: ${escHtml(e.title)}\n${when}${e.note ? '\n' + escHtml(e.note) : ''}` });
    }
  }
  for (const t of st.tasks || []) {
    if (!t || t.done || !t.date || !t.time || t.date < lo || t.date > hi) continue;
    const rem = t.remind == null ? '0' : t.remind;
    if (rem === '') continue;
    const at = zonedToMs(t.date, t.time, tz) - Number(rem) * 60000;
    if (at <= now && now - at < windowMin * 60000) {
      const when = t.date === today ? `сегодня в ${t.time}` : t.date === shiftYmd(today, 1) ? `завтра в ${t.time}` : `${dayTitle(t.date)} в ${t.time}`;
      out.push({ key: `${scope}:t:${t.id}:${at}`, text: Number(rem) > 0 ? `📌 <b>${beforeLabel(rem)}</b>: ${escHtml(t.title)}\n${when}` : `📌 <b>Пора</b>: ${escHtml(t.title)} (${t.time})` });
    }
  }
  return out;
}

/* ---------- Утренняя сводка ---------- */
const streak = (h, ymd) => {
  let n = 0, d = h.done && h.done[ymd] ? ymd : shiftYmd(ymd, -1);
  while (h.done && h.done[d]) { n++; d = shiftYmd(d, -1); }
  return n;
};
export function buildDigest({ name, pers, fam, tz, now, hasFamily, uid }) {
  const { ymd, hm } = partsIn(tz, new Date(now));
  const h = Number(hm.slice(0, 2));
  const greet = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const L = [`<b>${greet}${name ? ', ' + escHtml(name) : ''}!</b>`, dayTitle(ymd)[0].toUpperCase() + dayTitle(ymd).slice(1)];
  const srcs = [['', pers]].concat(hasFamily && fam ? [['👨‍👩‍👧 ', fam]] : []);

  const ev = [];
  for (const [mark, st] of srcs) for (const e of st.events || []) if (e.date === ymd && !(mark && e.src === 'cal' && e.calOwner === uid)) ev.push({ mark: mark && e.by ? `${mark}${escHtml(e.by)}: ` : mark, ...e });
  ev.sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  if (ev.length) { L.push('', '📅 <b>События</b>'); ev.forEach(e => L.push(`${e.mark}${e.time || 'весь день'} — ${escHtml(e.title)}`)); }

  const tk = [], od = [];
  for (const [mark, st] of srcs) for (const t of st.tasks || []) {
    if (t.done) continue;
    if (t.date === ymd) tk.push({ mark, ...t }); else if (t.date && t.date < ymd) od.push({ mark, ...t });
  }
  tk.sort((a, b) => (b.prio || 0) - (a.prio || 0) || (a.time || '99').localeCompare(b.time || '99'));
  if (tk.length) {
    L.push('', `✅ <b>Дела на сегодня</b> (${tk.length})`);
    tk.slice(0, 12).forEach(t => L.push(`• ${t.mark}${t.time ? t.time + ' ' : ''}${escHtml(t.title)}${t.prio === 2 ? ' ‼️' : t.prio === 1 ? ' ❗' : ''}`));
    if (tk.length > 12) L.push(`…и ещё ${tk.length - 12}`);
  }
  if (od.length) L.push('', `⚠️ <b>Просрочено</b>: ${od.slice(0, 5).map(t => t.mark + escHtml(t.title)).join(', ')}${od.length > 5 ? ` и ещё ${od.length - 5}` : ''}`);
  if (!ev.length && !tk.length && !od.length) L.push('', 'На сегодня ничего не запланировано.');

  const habits = pers.habits || [];
  if (habits.length) {
    const y = shiftYmd(ymd, -1);
    const done = habits.filter(x => x.done && x.done[y]).length;
    L.push('', `🔥 <b>Привычки</b>: вчера ${done} из ${habits.length}`);
    const st = habits.map(x => [x, streak(x, y)]).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (st.length) L.push(st.map(([x, n]) => `${x.emoji || ''} ${escHtml(x.title)} — ${n} ${plural(n, 'день', 'дня', 'дней')}`).join('\n'));
  }

  const mk = ymd.slice(0, 7);
  let inc = 0, out = 0;
  for (const o of pers.money || []) if (o.date && o.date.startsWith(mk)) { if (o.type === 'in') inc += +o.amount || 0; else out += +o.amount || 0; }
  if (inc || out) {
    const cur = pers.currency || '₽';
    L.push('', `💰 <b>${MON[Number(mk.slice(5)) - 1]}</b>: доходы +${money(inc, cur)}, расходы −${money(out, cur)}`, `Остаток: ${inc - out < 0 ? '−' : ''}${money(Math.abs(inc - out), cur)}`);
  }

  const shop = ((fam && fam.shop) || []).filter(x => !x.done);
  if (shop.length) L.push('', `🛒 <b>Купить</b>: ${shop.slice(0, 8).map(x => escHtml(x.text)).join(', ')}${shop.length > 8 ? ` и ещё ${shop.length - 8}` : ''}`);

  const pinned = (pers.thoughts || []).filter(t => t.pin);
  if (pinned.length) {
    const t = pinned[Number(ymd.replace(/-/g, '')) % pinned.length];
    L.push('', `💡 <i>${escHtml(t.text.length > 200 ? t.text.slice(0, 200) + '…' : t.text)}</i>`);
  }
  return L.join('\n');
}

export function digestDue(user, tz, now) {
  if (user.digestOn === false) return null;
  const { ymd, hm } = partsIn(tz, new Date(now));
  const at = toMin(user.digest || '08:00'), cur = toMin(hm);
  if (user.lastDigest === ymd || cur < at || cur - at > 180) return null;
  return ymd;
}

/* ---------- Дзен-мани ---------- */
export const ZEN_API = 'https://api.zenmoney.ru/v8/diff/';
export const firstOfPrevMonth = (ymd) => {
  const [y, m] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 10);
};
// Ответ /v8/diff/ → операции для раздела «Финансы».
// Переводы между своими счетами пропускаем, удалённые — убираем.
export function zenDiffToOps(d, z, since) {
  const tags = Object.assign({}, z.tags), accounts = Object.assign({}, z.accounts), instr = Object.assign({}, z.instr);
  for (const t of d.tag || []) if (t && t.id) tags[t.id] = t.title;
  for (const a of d.account || []) if (a && a.id) accounts[a.id] = a.title;
  for (const i of d.instrument || []) if (i && i.id != null) instr[i.id] = i.shortTitle;
  const ops = [];
  const diag = { keys: Object.keys(d || {}).slice(0, 20), tx: (d.transaction || []).length, tags: (d.tag || []).length, acc: (d.account || []).length, del: (d.deletion || []).length,
    old: 0, transfer: 0, zero: 0, removed: 0, added: 0, minDate: '', maxDate: '', since };
  for (const t of d.transaction || []) if (t && t.date) { if (!diag.minDate || t.date < diag.minDate) diag.minDate = t.date; if (t.date > diag.maxDate) diag.maxDate = t.date; }
  for (const del of d.deletion || []) if (del && del.object === 'transaction') ops.push(['del', 'money', 'zm_' + del.id]);
  for (const t of d.transaction || []) {
    if (!t || !t.id) continue;
    const id = 'zm_' + t.id;
    if (t.deleted) { ops.push(['del', 'money', id]); diag.removed++; continue; }
    if (!t.date || t.date < since) { diag.old++; continue; }
    const inc = Number(t.income) || 0, out = Number(t.outcome) || 0;
    if (inc > 0 && out > 0) { ops.push(['del', 'money', id]); diag.transfer++; continue; } // перевод между счетами
    if (!inc && !out) { diag.zero++; continue; }
    diag.added++;
    const type = inc > 0 ? 'in' : 'out';
    const tagId = Array.isArray(t.tag) && t.tag.length ? t.tag[0] : null;
    const cat = (tagId && tags[tagId]) || (type === 'in' ? 'Доход' : 'Без категории');
    const cur = instr[type === 'in' ? t.incomeInstrument : t.outcomeInstrument];
    const note = [t.payee, t.comment, cur && cur !== 'RUB' ? cur : ''].filter(Boolean).join(' · ').slice(0, 120);
    ops.push(['put', 'money', {
      id, type, amount: Math.round((type === 'in' ? inc : out) * 100) / 100, cat, note, date: t.date, src: 'zen',
      acc: accounts[type === 'in' ? t.incomeAccount : t.outcomeAccount] || ''
    }]);
  }
  return { ops, tags, accounts, instr, diag, ts: Number(d.serverTimestamp) || z.ts || 0 };
}

/* ---------- Список покупок ---------- */
const capFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);
export const splitShop = (text) => String(text || '').split(/[,;\n]+/).map(x => x.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '')).filter(Boolean).map(x => capFirst(x.slice(0, 80))).slice(0, 30);
// Добавить товары: уже купленный такой же — снова «купить», дубликаты пропускаем
export function shopAddOps(list, texts, by, mkId, now = Date.now()) {
  const ops = [], added = [], seen = new Set();
  for (const text of texts) {
    const k = text.toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    const ex = (list || []).find(x => x.text.toLowerCase() === k);
    if (ex && !ex.done) continue;
    const item = ex ? { ...ex, done: false, doneBy: '', hidden: false, ts: now, by } : { id: mkId(), text, done: false, by, ts: now };
    ops.push(['put', 'shop', item]); added.push(text);
  }
  return { ops, added };
}
export const SHOP_RE = /^(купить|куплю|купи|покупки|\+)\s*[:\-–—]?\s*([\s\S]+)$/i;

/* ---------- Календарь (ICS по ссылке) ---------- */
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const p2 = (n) => String(n).padStart(2, '0');
const tzOr = (tz, fb) => { if (!tz) return fb; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return fb; } };
const icsText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
function icsLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
  const parts = line.slice(0, i).split(';'), params = {};
  for (const p of parts.slice(1)) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); }
  return { name: parts[0].toUpperCase(), params, value: line.slice(i + 1) };
}
function icsDate(v, params) {
  const m = String(v || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] || params.VALUE === 'DATE') return { allDay: true, ymd };
  return { allDay: false, ymd, hm: `${m[4]}:${m[5]}`, utc: !!m[7], tz: params.TZID || null };
}
export function parseIcs(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const evs = []; let cur = null, alarm = 0;
  for (const raw of lines) {
    const line = raw.trimEnd(); if (!line) continue;
    if (!cur && /^X-WR-CALNAME[:;]/i.test(line)) { evs.calName = icsText(icsLine(line).value); continue; }
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur && cur.start) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { alarm++; continue; }
    if (line.startsWith('END:')) { alarm = Math.max(0, alarm - 1); continue; }
    if (alarm) continue;
    const { name, params, value } = icsLine(line);
    if (name === 'UID') cur.uid = value.trim();
    else if (name === 'SUMMARY') cur.title = icsText(value);
    else if (name === 'LOCATION') cur.location = icsText(value);
    else if (name === 'DTSTART') cur.start = icsDate(value, params);
    else if (name === 'DTEND') cur.end = icsDate(value, params);
    else if (name === 'DURATION') cur.duration = value.trim();
    else if (name === 'RRULE') cur.rrule = Object.fromEntries(value.split(';').map(kv => kv.split('=')).filter(a => a.length === 2).map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]));
    else if (name === 'EXDATE') for (const v of value.split(',')) { const d = icsDate(v, params); if (d) cur.exdates.push(d); }
    else if (name === 'RECURRENCE-ID') cur.recurId = icsDate(value, params);
    else if (name === 'STATUS') cur.status = value.trim().toUpperCase();
  }
  return evs;
}
const msOf = (dt, fb) => dt.utc ? Date.UTC(+dt.ymd.slice(0, 4), +dt.ymd.slice(5, 7) - 1, +dt.ymd.slice(8, 10), +dt.hm.slice(0, 2), +dt.hm.slice(3, 5)) : zonedToMs(dt.ymd, dt.hm, tzOr(dt.tz, fb));
const daysBetween = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5);
function durMin(e, fb) {
  if (e.start.allDay) return 0;
  if (e.end && !e.end.allDay) return Math.max(0, Math.round((msOf(e.end, fb) - msOf(e.start, fb)) / 60000));
  const m = String(e.duration || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  return m ? (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
}
function monthDays(y, m, r, sd) {
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (r.BYMONTHDAY) return r.BYMONTHDAY.split(',').map(Number).map(x => (x < 0 ? dim + 1 + x : x)).filter(x => x >= 1 && x <= dim).sort((a, b) => a - b);
  if (r.BYDAY) {
    const out = [];
    for (const tok of r.BYDAY.split(',')) {
      const mm = tok.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/); if (!mm) continue;
      const all = []; for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === DAYS[mm[2]]) all.push(d);
      if (!mm[1]) out.push(...all); else { const k = parseInt(mm[1], 10); const v = k > 0 ? all[k - 1] : all[all.length + k]; if (v) out.push(v); }
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }
  return sd <= dim ? [sd] : [];
}
// Даты повторений (в часовом поясе события) от start до to; from — нижняя граница выдачи
export function rruleDates(start, r, to, from) {
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const until = r.UNTIL ? `${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}` : null;
  const end = until && until < to ? until : to;
  const res = []; let n = 0, guard = 0;
  const emit = (d) => { if (d < start) return true; if (d > end) return false; n++; if (n > count) return false; if (d >= from) res.push(d); return true; };
  const [sy, sm, sd] = start.split('-').map(Number);
  if (r.FREQ === 'DAILY') {
    let d = start;
    if (count === Infinity && from > start) d = shiftYmd(start, Math.floor(daysBetween(start, from) / interval) * interval);
    for (; guard++ < 3000; d = shiftYmd(d, interval)) if (!emit(d)) break;
  } else if (r.FREQ === 'WEEKLY') {
    const by = (r.BYDAY ? r.BYDAY.split(',').map(x => DAYS[x.slice(-2)]).filter(x => x != null) : [new Date(Date.UTC(sy, sm - 1, sd)).getUTCDay()]).map(x => (x + 6) % 7).sort((a, b) => a - b);
    let wk = shiftYmd(start, -((new Date(Date.UTC(sy, sm - 1, sd)).getUTCDay() + 6) % 7));
    if (count === Infinity && from > start) wk = shiftYmd(wk, Math.max(0, Math.floor(daysBetween(wk, from) / (7 * interval)) - 1) * 7 * interval);
    outer: for (; guard++ < 2000; wk = shiftYmd(wk, 7 * interval)) for (const k of by) { const d = shiftYmd(wk, k); if (d < start) continue; if (!emit(d)) break outer; }
  } else if (r.FREQ === 'MONTHLY') {
    outer2: for (let i = 0; guard++ < 1200; i += interval) {
      const y = sy + Math.floor((sm - 1 + i) / 12), m = ((sm - 1 + i) % 12) + 1;
      if (`${y}-${p2(m)}-01` > end) break;
      for (const day of monthDays(y, m, r, sd)) if (!emit(`${y}-${p2(m)}-${p2(day)}`)) break outer2;
    }
  } else if (r.FREQ === 'YEARLY') {
    for (let y = sy; guard++ < 300; y += interval) {
      if (`${y}-01-01` > end) break;
      const dim = new Date(Date.UTC(y, sm, 0)).getUTCDate();
      if (sd > dim) continue;
      if (!emit(`${y}-${p2(sm)}-${p2(sd)}`)) break;
    }
  } else emit(start);
  return res;
}
// Разворачивает события в отдельные даты в поясе пользователя
export function expandIcs(evs, { from, to, tz, max = 800 }) {
  const out = [], over = new Set();
  for (const e of evs) if (e.recurId && e.uid) over.add(e.uid + '|' + e.recurId.ymd);
  const push = (e, dt, dur, key) => {
    if (out.length >= max) return;
    let date, time = '', end = '';
    if (dt.allDay) date = dt.ymd;
    else { const ms = msOf(dt, tz); const p = partsIn(tz, new Date(ms)); date = p.ymd; time = p.hm; if (dur > 0 && dur < 1440) end = partsIn(tz, new Date(ms + dur * 60000)).hm; }
    if (date < from || date > to) return;
    out.push({ key, title: e.title || 'Без названия', date, time, end, location: e.location || '' });
  };
  for (const e of evs) {
    if (e.status === 'CANCELLED' || !e.start) continue;
    const dur = durMin(e, tz), uid = e.uid || (e.title + e.start.ymd);
    if (e.recurId) { push(e, e.start, dur, uid + '|' + e.recurId.ymd); continue; }
    if (!e.rrule) { push(e, e.start, dur, uid + '|' + e.start.ymd); continue; }
    const ex = new Set(e.exdates.map(d => d.ymd));
    for (const ymd of rruleDates(e.start.ymd, e.rrule, shiftYmd(to, 1), shiftYmd(from, -1))) {
      if (ex.has(ymd) || over.has(uid + '|' + ymd)) continue;
      push(e, { ...e.start, ymd }, dur, uid + '|' + ymd);
    }
  }
  return out.sort((a, b) => (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00')));
}
export function shortHash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/* ---------- Привычки по расписанию (приём добавок и т. п.) ---------- */
// scope 'p' — личные привычки человека (напоминать, если remindTo задан),
// scope 'f' — семейные (напоминать тому, чей id в remindTo, или всем при 'all')
export function dueHabitReminders(st, tz, now, scope, uid, windowMin = 15) {
  const out = [];
  const { ymd: today } = partsIn(tz, new Date(now));
  for (const h of st.habits || []) {
    if (!h || !h.time || !/^\d{2}:\d{2}$/.test(h.time)) continue;
    const to = h.remindTo == null ? '' : String(h.remindTo);
    if (scope === 'p' ? !to : !(to === 'all' || to === String(uid))) continue;
    if (h.done && h.done[today]) continue;
    const at = zonedToMs(today, h.time, tz);
    const cb = `hd:${scope}:${h.id}:${today.replace(/-/g, '')}`;
    const body = `${h.emoji || '⏰'} <b>${escHtml(h.title)}</b> — ${h.time}${h.note ? '\n' + escHtml(h.note) : ''}`;
    for (const [shift, pre, k] of [[0, '', 1], [60, 'Напоминаю ещё раз. ', 2]]) {
      const t = at + shift * 60000;
      if (t <= now && now - t < windowMin * 60000) out.push({ key: `${scope}:h:${h.id}:${today}:${k}`, text: pre + body, cb });
    }
  }
  return out;
}
