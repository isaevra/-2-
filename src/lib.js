// Чистые функции без зависимостей от Cloudflare — их удобно тестировать.

export const DEF_TZ = 'Asia/Vladivostok';
export const COLS = ['thoughts', 'habits', 'money', 'tasks', 'events'];

export const emptyState = () => ({ v: 1, name: '', currency: '₽', thoughts: [], habits: [], money: [], tasks: [], events: [] });

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
    const at = zonedToMs(t.date, t.time, tz);
    if (at <= now && now - at < windowMin * 60000) out.push({ key: `${scope}:t:${t.id}:${at}`, text: `📌 <b>Пора</b>: ${escHtml(t.title)} (${t.time})` });
  }
  return out;
}

/* ---------- Утренняя сводка ---------- */
const streak = (h, ymd) => {
  let n = 0, d = h.done && h.done[ymd] ? ymd : shiftYmd(ymd, -1);
  while (h.done && h.done[d]) { n++; d = shiftYmd(d, -1); }
  return n;
};
export function buildDigest({ name, pers, fam, tz, now, hasFamily }) {
  const { ymd, hm } = partsIn(tz, new Date(now));
  const h = Number(hm.slice(0, 2));
  const greet = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const L = [`<b>${greet}${name ? ', ' + escHtml(name) : ''}!</b>`, dayTitle(ymd)[0].toUpperCase() + dayTitle(ymd).slice(1)];
  const srcs = [['', pers]].concat(hasFamily && fam ? [['👨‍👩‍👧 ', fam]] : []);

  const ev = [];
  for (const [mark, st] of srcs) for (const e of st.events || []) if (e.date === ymd) ev.push({ mark, ...e });
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
