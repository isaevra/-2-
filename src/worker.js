// «Мой день» — сервер для Telegram Mini App на Cloudflare Workers.
// Хранит данные (личные и семейные), шлёт напоминания и утреннюю сводку.
import { DurableObject } from 'cloudflare:workers';
import {
  DEF_TZ, emptyState, applyOps, checkInitData, webhookSecret, validTz,
  dueReminders, buildDigest, digestDue, escHtml,
  ZEN_API, zenDiffToOps, firstOfPrevMonth, partsIn, splitShop, shopAddOps, SHOP_RE,
  parseIcs, expandIcs, shortHash, shiftYmd, dueHabitReminders,
  weeklyReport, monthlyReport, reportsDue, limitAlerts,
  FEEDS, NEWS_SECS, DEF_CITY, cityFeed, newsPrefs, parseFeed, buildNews, weatherText, weatherUrl
} from './lib.js';
const HOOK_VER = 2; // вебхук принимает нажатия кнопок

const CAL_EVERY = 20 * 60e3; // как часто обновлять календарь
const CAL_REMIND = ['', '0', '15', '30', '60', '180', '1440'];

const COMMANDS = [
  { command: 'today', description: 'Сводка на сегодня' },
  { command: 'news', description: 'Новости и погода' },
  { command: 'shop', description: 'Список покупок' },
  { command: 'week', description: 'Траты за неделю' },
  { command: 'month', description: 'Итоги месяца' },
  { command: 'invite', description: 'Пригласить в семью' },
  { command: 'help', description: 'Что умеет бот' }
];
const CMD_VER = 4;

const ZEN_EVERY = 30 * 60e3; // как часто обновлять Дзен-мани

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}

const randCode = () => [...crypto.getRandomValues(new Uint8Array(9))].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

/* ===================== Хранилище и логика ===================== */
export class Store extends DurableObject {
  async meta() {
    const m = (await this.ctx.storage.get('meta')) || {};
    return Object.assign({ owner: null, users: {}, invite: null, sent: {}, appUrl: null, bot: null }, m);
  }
  putMeta(m) { return this.ctx.storage.put('meta', m); }
  async data(key) { return (await this.ctx.storage.get('d:' + key)) || emptyState(); }
  putData(key, st) { return this.ctx.storage.put('d:' + key, st); }

  openBtn(meta, text = 'Открыть «Мой день»') {
    return meta.appUrl ? { inline_keyboard: [[{ text, web_app: { url: meta.appUrl } }]] } : undefined;
  }
  send(chatId, text, extra = {}) {
    return tg(this.env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
  addUser(meta, u) {
    const prev = meta.users[u.id] || {};
    meta.users[u.id] = Object.assign({ digest: '08:00', digestOn: true, tz: DEF_TZ, lastDigest: '' }, prev, {
      id: u.id, name: prev.name || u.first_name || 'Без имени'
    });
    if (!meta.owner) meta.owner = u.id;
    return meta.users[u.id];
  }

  /* ---------- API для мини-аппа ---------- */
  async api(action, user, body) {
    const meta = await this.meta();
    if (!meta.users[user.id]) {
      if (meta.owner) return { status: 403, error: 'not_member' };
      this.addUser(meta, user);
    }
    const me = meta.users[user.id];
    const members = () => Object.values(meta.users).map(u => ({ id: u.id, name: u.name, started: !!u.started }));
    const myNotes = () => (meta.notes || []).filter(n => n.from === me.id).map(n => ({ id: n.id, to: n.to, text: n.text, at: n.at }));
    const pub = () => ({ id: me.id, name: me.name, theme: me.theme || '', repWeek: me.repWeek !== false, repMonth: me.repMonth !== false, isOwner: meta.owner === me.id, news: newsPrefs(me, meta.owner === me.id), city: (me.city || DEF_CITY).name, digest: me.digest, digestOn: me.digestOn !== false, tz: me.tz, started: !!me.started });

    if (action === 'load') {
      if (body.tz) me.tz = validTz(String(body.tz));
      await this.putMeta(meta);
      return { ok: true, me: pub(), members: members(), bot: meta.bot, notes: myNotes(), zen: await this.zenStatus(me.id), cal: await this.calStatus(me.id), personal: await this.data('u:' + me.id), family: await this.data('family') };
    }
    if (action === 'ops') {
      const key = body.scope === 'family' ? 'family' : 'u:' + me.id;
      const st = applyOps(await this.data(key), body.ops);
      await this.putData(key, st);
      return { ok: true };
    }
    if (action === 'profile') {
      if (typeof body.digest === 'string' && /^\d{2}:\d{2}$/.test(body.digest)) {
        if (body.digest !== me.digest) me.lastDigest = '';
        me.digest = body.digest;
      }
      if (typeof body.digestOn === 'boolean') me.digestOn = body.digestOn;
      if (['violet', 'man', 'woman'].includes(body.theme)) me.theme = body.theme;
      if (typeof body.repWeek === 'boolean') me.repWeek = body.repWeek;
      if (typeof body.repMonth === 'boolean') me.repMonth = body.repMonth;
      if (typeof body.name === 'string' && body.name.trim()) me.name = body.name.trim().slice(0, 40);
      if (body.news && typeof body.news === 'object') me.news = Object.fromEntries(NEWS_SECS.map(([k]) => [k, !!body.news[k]]));
      if (typeof body.city === 'string' && body.city.trim() && body.city.trim().toLowerCase() !== (me.city || DEF_CITY).name.toLowerCase()) {
        const c = await this.geocode(body.city.trim().slice(0, 60));
        if (!c) { await this.putMeta(meta); return { ok: false, error: 'city_not_found', me: pub() }; }
        me.city = c;
      }
      await this.putMeta(meta);
      return { ok: true, me: pub() };
    }
    // Разовое уведомление члену семьи: сейчас или в назначенное время
    if (action === 'notify') {
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return { ok: false, error: 'empty' };
      const others = Object.values(meta.users).filter(u => u.id !== me.id);
      const to = body.to === 'all' ? 'all' : Number(body.to);
      if (to !== 'all' && !meta.users[to]) return { ok: false, error: 'no_member' };
      const at = Number(body.at) || 0;
      if (at > Date.now() + 60000) {
        meta.notes = (meta.notes || []).filter(n => n.at > Date.now() - 86400000);
        if (meta.notes.filter(n => n.from === me.id).length >= 30) return { ok: false, error: 'too_many' };
        meta.notes.push({ id: Math.random().toString(36).slice(2, 10), from: me.id, to, text, at: Math.min(at, Date.now() + 366 * 86400000) });
        await this.putMeta(meta);
        return { ok: true, scheduled: true, notes: myNotes() };
      }
      const list = to === 'all' ? others : [meta.users[to]];
      let sent = 0; const missed = [];
      for (const u of list) { const r = u.started ? await this.sendNote(me, u, text) : null; if (r && r.ok) sent++; else missed.push(u.name); }
      return { ok: sent > 0, sent, missed, notes: myNotes() };
    }
    if (action === 'noteDel') {
      meta.notes = (meta.notes || []).filter(n => !(n.id === body.id && n.from === me.id));
      await this.putMeta(meta);
      return { ok: true, notes: myNotes() };
    }
    if (action === 'digest') {
      if (!me.started) return { ok: false, error: 'not_started' };
      const r = await this.sendDigest(meta, me, Date.now());
      return { ok: !!(r && r.ok), error: r && r.ok ? undefined : 'send_failed' };
    }
    if (action === 'news') {
      if (!me.started) return { ok: false, error: 'not_started' };
      const r = await this.sendNews(meta, me, Date.now(), true);
      return { ok: !!(r && r.ok), error: r ? undefined : 'empty' };
    }
    if (action === 'newsStatus') {
      const list = [...FEEDS, cityFeed(me.city || DEF_CITY)];
      const recs = await this.feedRecs(list.map(f => f.id));
      return { ok: true, feeds: list.map(f => { const r = recs[f.id] || {}; return { name: f.name || 'Новости: ' + (me.city || DEF_CITY).name, sec: f.sec, ok: !!r.ok, n: r.n || 0, at: r.at || 0, err: r.err || '' }; }) };
    }
    if (action === 'report') {
      if (!me.started) return { ok: false, error: 'not_started' };
      const r = await this.sendReport(me, body.kind === 'month' ? 'month' : 'week', Date.now());
      return { ok: !!(r && r.ok) };
    }
    if (action === 'invite') {
      if (meta.owner !== me.id) return { status: 403, error: 'owner_only' };
      if (!meta.bot) { const r = await tg(this.env, 'getMe'); if (r.ok) meta.bot = r.result.username; }
      if (!meta.bot) return { ok: false, error: 'no_bot' };
      meta.invite = { code: randCode(), until: Date.now() + 7 * 86400e3 };
      await this.putMeta(meta);
      return { ok: true, link: `https://t.me/${meta.bot}?start=join_${meta.invite.code}` };
    }
    if (action === 'zenConnect') {
      const token = String(body.token || '').trim().replace(/^Bearer\s+/i, '');
      if (token.length < 10 || token.length > 400) return { ok: false, error: 'bad_token' };
      await this.ctx.storage.put('zen:' + me.id, { token, ts: 0, tags: {}, accounts: {}, instr: {}, lastSync: 0, error: '' });
      const r = await this.zenSync(me, true);
      if (!r.ok) await this.ctx.storage.delete('zen:' + me.id);
      return { ...r, zen: await this.zenStatus(me.id), personal: await this.data('u:' + me.id) };
    }
    if (action === 'zenSync') {
      const r = await this.zenSync(me, !!body.full);
      return { ...r, zen: await this.zenStatus(me.id), personal: await this.data('u:' + me.id) };
    }
    if (action === 'zenOff') {
      await this.ctx.storage.delete('zen:' + me.id);
      if (body.removeData) {
        const st = await this.data('u:' + me.id);
        st.money = (st.money || []).filter(o => o.src !== 'zen');
        await this.putData('u:' + me.id, st);
      }
      return { ok: true, zen: await this.zenStatus(me.id), personal: await this.data('u:' + me.id) };
    }
    if (action === 'calAdd' || action === 'calConnect') {
      const url = String(body.url || '').trim().replace(/^webcal:\/\//i, 'https://');
      if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 1000) return { ok: false, error: 'bad_url' };
      const c = await this.calGet(me.id);
      if (c.sources.some(x => x.url === url)) return { ok: false, error: 'dup', ...(await this.calPayload(me.id)) };
      if (c.sources.length >= 15) return { ok: false, error: 'too_many' };
      const src = { id: randCode().slice(0, 8), url, name: '', remind: '30', share: false, error: '', count: 0 };
      const test = await this.calFetch(src, me);
      if (!test.ok) return { ok: false, error: test.error };
      c.sources.push(src);
      await this.ctx.storage.put('cal:' + me.id, c);
      const r = await this.calSync(me);
      return { ...r, added: src.name, addedCount: src.count, ...(await this.calPayload(me.id)) };
    }
    if (action === 'calSync') return { ...(await this.calSync(me)), ...(await this.calPayload(me.id)) };
    if (action === 'calSettings') {
      const c = await this.calGet(me.id), src = c.sources.find(x => x.id === body.id);
      if (!src) return { ok: false, error: 'not_found' };
      if (CAL_REMIND.includes(String(body.remind))) src.remind = String(body.remind);
      if (typeof body.share === 'boolean') src.share = body.share;
      if (typeof body.name === 'string' && body.name.trim()) src.name = body.name.trim().slice(0, 40);
      await this.ctx.storage.put('cal:' + me.id, c);
      return { ...(await this.calSync(me)), ...(await this.calPayload(me.id)) };
    }
    if (action === 'calRemove' || action === 'calOff') {
      const c = await this.calGet(me.id);
      c.sources = action === 'calOff' ? [] : c.sources.filter(x => x.id !== body.id);
      await this.ctx.storage.put('cal:' + me.id, c);
      await this.calSync(me);
      return { ok: true, ...(await this.calPayload(me.id)) };
    }
    return { status: 404, error: 'unknown_action' };
  }

  /* ---------- Календари по ссылкам ---------- */
  async calGet(uid) {
    const c = (await this.ctx.storage.get('cal:' + uid)) || { sources: [] };
    if (!c.sources) { // старый формат: одна ссылка
      c.sources = c.url ? [{ id: 'main', url: c.url, name: '', remind: c.remind ?? '30', share: c.share !== false, error: c.error || '', count: c.count || 0 }] : [];
      delete c.url; delete c.remind; delete c.share; delete c.count; delete c.error;
    }
    return c;
  }
  async calStatus(uid) {
    const c = await this.calGet(uid);
    const sources = c.sources.map(x => ({ id: x.id, name: x.name || 'Календарь', count: x.count || 0, error: x.error || '', remind: x.remind ?? '30', share: x.share !== false }));
    return { connected: sources.length > 0, lastSync: c.lastSync || 0, count: sources.reduce((a, x) => a + x.count, 0), error: sources.some(x => x.error) ? 'some' : '', sources };
  }
  async calPayload(uid) {
    return { cal: await this.calStatus(uid), personal: await this.data('u:' + uid), family: await this.data('family') };
  }
  // Скачать и разобрать один календарь
  async calFetch(src, user) {
    let res;
    try { res = await fetch(src.url, { headers: { 'user-agent': 'MyDayBot/1.0', accept: 'text/calendar,*/*' } }); } catch (e) { return { ok: false, error: 'network' }; }
    if (!res.ok) return { ok: false, error: 'http_' + res.status };
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) return { ok: false, error: 'not_ics' };
    const evs = parseIcs(text);
    if (!src.name && evs.calName) src.name = evs.calName.slice(0, 40);
    const tz = user.tz || DEF_TZ, today = partsIn(tz).ymd;
    const occ = expandIcs(evs, { from: shiftYmd(today, -3), to: shiftYmd(today, 60), tz });
    src.count = occ.length;
    return { ok: true, occ };
  }
  async calSync(user) {
    const key = 'cal:' + user.id;
    const c = await this.calGet(user.id);
    c.lastSync = Date.now();
    const results = [];
    for (const src of c.sources) {
      const r = await this.calFetch(src, user);
      src.error = r.ok ? '' : r.error;
      results.push({ src, ...r });
    }
    await this.calApply(user, results, new Set(c.sources.map(x => x.id)));
    await this.ctx.storage.put(key, c);
    const bad = results.filter(r => !r.ok);
    return { ok: !bad.length, error: bad.length ? bad[0].error : undefined, count: results.reduce((a, r) => a + (r.occ ? r.occ.length : 0), 0) };
  }
  // Заменяет события календарей человека в его разделе и в «Семье».
  // Если календарь временно не скачался, его прежние события остаются.
  async calApply(user, results, alive) {
    const keep = new Set(results.filter(r => !r.ok).map(r => r.src.id));
    const own = (e) => e.src === 'cal' && (!e.calSrc ? true : !keep.has(e.calSrc) || !alive.has(e.calSrc));
    const id = (k) => 'cal_' + shortHash(user.id + '|' + k);
    const fresh = [], famFresh = [];
    for (const r of results) {
      if (!r.ok) continue;
      const s = r.src, nm = s.name || 'Календарь';
      for (const o of r.occ) {
        const base = { title: o.title, date: o.date, time: o.time, end: o.end, note: o.location, src: 'cal', calSrc: s.id, calName: nm };
        fresh.push({ ...base, id: id(s.id + '|' + o.key), remind: o.time ? (s.remind ?? '30') : (s.remind === '1440' ? '1440' : '') });
        if (s.share !== false) famFresh.push({ ...base, id: 'f' + id(s.id + '|' + o.key), remind: '', calOwner: user.id, by: user.name });
      }
    }
    const pers = await this.data('u:' + user.id);
    pers.events = (pers.events || []).filter(e => !own(e)).concat(fresh);
    await this.putData('u:' + user.id, pers);
    const fam = await this.data('family');
    fam.events = (fam.events || []).filter(e => !(e.calOwner === user.id && own(e))).concat(famFresh);
    await this.putData('family', fam);
  }

  /* ---------- Дзен-мани ---------- */
  async zenStatus(uid) {
    const z = await this.ctx.storage.get('zen:' + uid);
    return z ? { connected: true, lastSync: z.lastSync || 0, error: z.error || '', count: z.count || 0, accounts: Object.keys(z.accounts || {}).length, diag: z.diag || null } : { connected: false };
  }
  async zenSync(user, full = false) {
    const key = 'zen:' + user.id;
    const z = await this.ctx.storage.get(key);
    if (!z || !z.token) return { ok: false, error: 'not_connected' };
    z.lastSync = Date.now();
    let res, d;
    try {
      res = await fetch(ZEN_API, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + z.token, 'content-type': 'application/json' },
        body: JSON.stringify({ currentClientTimestamp: Math.floor(Date.now() / 1000), serverTimestamp: full ? 0 : (z.ts || 0) })
      });
    } catch (e) { z.error = 'network'; await this.ctx.storage.put(key, z); return { ok: false, error: 'network' }; }
    if (res.status === 401 || res.status === 403) {
      const first = z.error !== 'token';
      z.error = 'token'; await this.ctx.storage.put(key, z);
      if (first && !full && user.started) await this.send(user.id, '⚠️ Дзен-мани перестал пускать бота: токен устарел. Открой «Финансы» и подключи Дзен-мани заново.');
      return { ok: false, error: 'token' };
    }
    const raw = await res.text();
    if (!res.ok) { z.error = 'http_' + res.status; z.diag = { status: res.status, body: raw.slice(0, 300) }; await this.ctx.storage.put(key, z); return { ok: false, error: z.error }; }
    try { d = JSON.parse(raw); } catch (e) { z.error = 'bad_json'; z.diag = { status: res.status, body: raw.slice(0, 300) }; await this.ctx.storage.put(key, z); return { ok: false, error: 'bad_json' }; }
    if (!d || typeof d !== 'object' || d.error) { z.error = 'api'; z.diag = { status: res.status, body: raw.slice(0, 300) }; await this.ctx.storage.put(key, z); return { ok: false, error: 'api' }; }
    const since = firstOfPrevMonth(partsIn(user.tz || DEF_TZ).ymd);
    const r = zenDiffToOps(d, z, since);
    const st = applyOps(await this.data('u:' + user.id), r.ops);
    await this.putData('u:' + user.id, st);
    Object.assign(z, { ts: r.ts, tags: r.tags, accounts: r.accounts, instr: r.instr, error: '', count: st.money.filter(o => o.src === 'zen').length, diag: { status: res.status, full, at: Date.now(), ...r.diag } });
    await this.ctx.storage.put(key, z);
    return { ok: true, changed: r.ops.length };
  }

  /* ---------- Сообщения боту ---------- */
  async webhook(update) {
    if (update && update.callback_query) return this.onButton(update.callback_query);
    const msg = update && update.message;
    if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') return;
    const meta = await this.meta();
    const from = msg.from, text = (msg.text || '').trim();
    let me = meta.users[from.id];

    if (text.startsWith('/start')) {
      const payload = text.split(/\s+/)[1] || '';
      if (!me && payload.startsWith('join_') && meta.invite && meta.invite.code === payload.slice(5) && meta.invite.until > Date.now()) {
        me = this.addUser(meta, from);
        meta.invite = null;
        if (meta.owner && meta.owner !== from.id) await this.send(meta.owner, `👨‍👩‍👧 ${escHtml(me.name)} теперь в семье. У вас общий раздел «Семья».`);
      } else if (!me && !meta.owner) {
        me = this.addUser(meta, from);
      }
      if (!me) {
        await this.putMeta(meta);
        return this.send(from.id, 'Это личный бот семьи. Чтобы пользоваться, попроси владельца прислать тебе ссылку-приглашение.');
      }
      me.started = true;
      await this.putMeta(meta);
      return this.send(from.id,
        `Привет, ${escHtml(me.name)}! Я бот «Мой день».\n\n` +
        `• Каждое утро в ${me.digest} пришлю сводку: события, дела, привычки и деньги.\n` +
        `• Напомню о событиях и делах, у которых стоит время.\n` +
        `• Напиши «купить молоко, хлеб», и я добавлю это в общий список покупок.\n` +
        `• Любой другой текст я сохраню в «Мысли».\n\n` +
        `Команды: /today — сводка сейчас, /shop — список покупок${meta.owner === me.id ? ', /invite — пригласить в семью' : ''}.`,
        { reply_markup: this.openBtn(meta) });
    }

    if (!me) return this.send(from.id, 'Это личный бот семьи. Попроси владельца прислать ссылку-приглашение.');
    if (!me.started) { me.started = true; await this.putMeta(meta); }

    if (text === '/news' || /^новости$/i.test(text)) {
      const r = await this.sendNews(meta, me, Date.now(), true);
      return r || this.send(from.id, 'Все разделы новостей выключены. Включить их можно в мини-аппе: ⚙️ → Утренняя сводка.');
    }
    if (text === '/today') {
      const r = await this.sendDigest(meta, me, Date.now(), true);
      return r;
    }
    if (text === '/invite') {
      if (meta.owner !== me.id) return this.send(from.id, 'Приглашать может только владелец.');
      const r = await this.api('invite', from, {});
      if (!r.ok) return this.send(from.id, 'Не получилось создать приглашение, попробуй ещё раз.');
      return this.send(from.id, `Перешли эту ссылку тому, кого хочешь добавить в семью. Она одноразовая и действует 7 дней:\n${r.link}`);
    }
    if (text === '/week' || text === '/month') return this.sendReport(me, text === '/month' ? 'month' : 'week', Date.now());
    if (text === '/shop' || /^список( покупок)?$/i.test(text)) {
      const list = ((await this.data('family')).shop || []).filter(x => !x.done);
      return this.send(from.id, list.length ? `🛒 <b>Купить</b> (${list.length}):\n` + list.map(x => '• ' + escHtml(x.text)).join('\n') : '🛒 Список покупок пуст. Напиши «купить молоко, хлеб», и я добавлю.', { reply_markup: this.openBtn(meta, 'Открыть список') });
    }
    const sm = text.match(SHOP_RE);
    if (sm && !text.startsWith('/')) {
      const fam = await this.data('family');
      const r = shopAddOps(fam.shop, splitShop(sm[2]), me.name, randCode);
      if (!r.added.length) return this.send(from.id, 'Это уже есть в списке покупок 👍');
      await this.putData('family', applyOps(fam, r.ops));
      return this.send(from.id, `🛒 Добавил в покупки: ${r.added.map(escHtml).join(', ')}`);
    }
    if (text === '/help') return this.send(from.id, '«купить молоко, хлеб» — добавлю в список покупок.\nЛюбой другой текст — сохраню в «Мысли».\n/today — сводка на сегодня, /shop — список покупок.', { reply_markup: this.openBtn(meta) });
    if (text.startsWith('/')) return this.send(from.id, 'Не знаю такой команды. Есть /today, /shop и /help.');

    if (text) {
      const key = 'u:' + me.id;
      const st = applyOps(await this.data(key), [['put', 'thoughts', { id: randCode(), text: text.slice(0, 4000), pin: false, ts: Date.now() }]]);
      await this.putData(key, st);
      return this.send(from.id, '💡 Сохранил в «Мысли»');
    }
    return this.send(from.id, 'Пока понимаю только текст. Фото и голосовые научусь сохранять позже.');
  }

  sendNote(from, to, text) {
    return this.send(to.id, `💌 <b>${escHtml(from.name || 'Семья')}</b> передаёт:\n\n${escHtml(text)}`, { reply_markup: { inline_keyboard: [[{ text: '❤️', callback_data: 'nr:' + from.id }]] } });
  }

  // Нажатие «✅ Готово» под напоминанием о привычке / ❤️ под сообщением
  async onButton(cq) {
    const meta = await this.meta();
    const answer = (text) => tg(this.env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
    const me = meta.users[cq.from && cq.from.id];
    const nr = String(cq.data || '').match(/^nr:(\d+)$/);
    if (me && nr) {
      const from = meta.users[nr[1]];
      if (from && from.started) await this.send(from.id, `❤️ ${escHtml(me.name || 'Семья')} — в ответ на твоё сообщение`);
      await answer('Отправлено ❤️');
      if (cq.message) await tg(this.env, 'editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: '❤️ отправлено', callback_data: 'nx' }]] } });
      return;
    }
    if (cq.data === 'nx') return answer('Уже отправлено');
    const m = String(cq.data || '').match(/^hd:([pf]):([^:]+):(\d{8})$/);
    if (!me || !m) return answer('Не получилось');
    const key = m[1] === 'f' ? 'family' : 'u:' + me.id;
    const ymd = `${m[3].slice(0, 4)}-${m[3].slice(4, 6)}-${m[3].slice(6, 8)}`;
    const st = await this.data(key);
    const h = (st.habits || []).find(x => x.id === m[2]);
    if (!h) return answer('Эта привычка уже удалена');
    h.done = h.done || {};
    const already = !!h.done[ymd];
    h.done[ymd] = true;
    await this.putData(key, st);
    await answer(already ? 'Уже отмечено' : 'Отмечено ✅');
    if (cq.message) {
      const t = partsIn(me.tz || DEF_TZ).hm;
      await tg(this.env, 'editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: escHtml(cq.message.text || '') + `\n\n✅ Отмечено в ${t}`, parse_mode: 'HTML' });
    }
  }

  async sendReport(me, kind, now) {
    const pers = await this.data('u:' + me.id), fam = await this.data('family');
    const tz = me.tz || DEF_TZ, ymd = partsIn(tz, new Date(now)).ymd;
    const make = (st) => kind === 'month' ? monthlyReport(st, ymd.slice(0, 7), pers.currency || '₽') : weeklyReport(st, ymd, pers.currency || '₽');
    let text = make(pers);
    const famHas = (fam.money || []).some(o => o.date && o.date >= shiftYmd(ymd, kind === 'month' ? -31 : -7));
    if (famHas) text += '\n\n👨‍👩‍👧 <b>Семейный бюджет</b>\n' + make(fam).split('\n').slice(1).join('\n').replace(/^\n/, '');
    return this.send(me.id, text, { reply_markup: this.openBtn(await this.meta(), 'Открыть финансы') });
  }

  async sendDigest(meta, me, now, manual = false) {
    const pers = await this.data('u:' + me.id);
    const fam = await this.data('family');
    const pr = newsPrefs(me, meta.owner === me.id), city = me.city || DEF_CITY;
    const weather = pr.weather ? weatherText(await this.weather(city), city) : '';
    const text = buildDigest({ name: pers.name || me.name, pers, fam, tz: me.tz || DEF_TZ, now, hasFamily: Object.keys(meta.users).length > 1, uid: me.id, weather });
    const r = await this.send(me.id, text, { reply_markup: this.openBtn(meta), disable_notification: false });
    await this.sendNews(meta, me, now, false, manual ? 12 : 4);
    return r;
  }

  /* ---------- Новости и погода ---------- */
  async sendNews(meta, me, now, manual, max) {
    const pr = newsPrefs(me, meta.owner === me.id), city = me.city || DEF_CITY;
    const secs = ['svo', 'sport', 'esport', 'auto', 'city'].filter(k => pr[k]);
    if (!secs.length && !(manual && pr.weather)) return null;
    const need = [...FEEDS.filter(f => secs.includes(f.sec)), ...(pr.city ? [cityFeed(city)] : [])];
    await this.refreshFeeds(need, now, max || (manual ? 12 : 4));
    const recs = await this.feedRecs(need.map(f => f.id));
    let text = buildNews(pr, recs, now, city);
    if (manual && pr.weather) { const w = weatherText(await this.weather(city), city); if (w) text = w + (text ? '\n\n' + text : ''); }
    if (!text) return manual ? this.send(me.id, 'Свежих новостей по выбранным разделам пока нет — источники не ответили. Попробуй позже.') : null;
    return this.send(me.id, text, { disable_notification: true });
  }
  async feedRecs(ids) {
    const out = {};
    for (const id of ids) out[id] = await this.ctx.storage.get('feed:' + id) || null;
    return out;
  }
  // Обновляет устаревшие (старше 55 мин) ленты, не больше max за раз
  async refreshFeeds(list, now, max) {
    const recs = await this.feedRecs(list.map(f => f.id));
    const stale = list.filter(f => !recs[f.id] || now - recs[f.id].at > 55 * 60000).sort((a, b) => ((recs[a.id] || {}).at || 0) - ((recs[b.id] || {}).at || 0)).slice(0, max);
    await Promise.all(stale.map(async f => {
      const rec = { at: now, ok: false, n: 0, err: '', items: (recs[f.id] || {}).items || [] };
      try {
        const r = await fetch(f.url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; MyDayBot/1.0)', accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(9000), cf: { cacheTtl: 600 } });
        if (!r.ok) rec.err = 'HTTP ' + r.status;
        else { const items = parseFeed(await r.text()); rec.n = items.length; if (items.length) { rec.ok = true; rec.items = items.slice(0, 40); } else rec.err = 'пустая лента'; }
      } catch (e) { rec.err = String(e && e.name === 'TimeoutError' ? 'нет ответа' : e).slice(0, 80); }
      await this.ctx.storage.put('feed:' + f.id, rec);
    }));
  }
  async weather(city) {
    const key = `wx:${city.lat.toFixed(2)},${city.lon.toFixed(2)}`, c = await this.ctx.storage.get(key);
    if (c && Date.now() - c.at < 30 * 60000) return c.w;
    try {
      const r = await fetch(weatherUrl(city), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return c && c.w;
      const w = await r.json(); await this.ctx.storage.put(key, { at: Date.now(), w }); return w;
    } catch (e) { return c && c.w; }
  }
  async geocode(name) {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ru&format=json`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json(), g = j && j.results && j.results[0];
      return g ? { name: g.name, lat: +g.latitude, lon: +g.longitude } : null;
    } catch (e) { return null; }
  }

  /* ---------- Каждую минуту ---------- */
  async tick(now = Date.now()) {
    if (!this.env.BOT_TOKEN) return { skipped: 'no_token' };
    const meta = await this.meta();
    if (meta.hookv !== HOOK_VER && meta.appUrl) {
      const wh = await tg(this.env, 'setWebhook', { url: new URL('/tg', meta.appUrl).href, secret_token: await webhookSecret(this.env.BOT_TOKEN), allowed_updates: ['message', 'callback_query'] });
      if (wh.ok) meta.hookv = HOOK_VER;
    }
    if (meta.cmdv !== CMD_VER && meta.appUrl) { const cm = await tg(this.env, 'setMyCommands', { commands: COMMANDS }); if (cm.ok) meta.cmdv = CMD_VER; }
    if ((meta.notes || []).some(n => n.at <= now)) {
      const due = meta.notes.filter(n => n.at <= now);
      meta.notes = meta.notes.filter(n => n.at > now);
      await this.putMeta(meta);
      for (const n of due) {
        const from = meta.users[n.from]; if (!from) continue;
        const list = n.to === 'all' ? Object.values(meta.users).filter(u => u.id !== n.from) : [meta.users[n.to]].filter(Boolean);
        for (const u of list) if (u.started) await this.sendNote(from, u, n.text);
      }
    }
    const users = Object.values(meta.users).filter(u => u.started);
    if (!users.length) return { users: 0 };
    {
      const need = new Map();
      for (const u of users) {
        const pr = newsPrefs(u, meta.owner === u.id);
        if (u.digestOn === false) continue;
        for (const f of FEEDS) if (pr[f.sec]) need.set(f.id, f);
        if (pr.city) { const cf = cityFeed(u.city || DEF_CITY); need.set(cf.id, cf); }
      }
      if (need.size) await this.refreshFeeds([...need.values()], now, 3);
    }
    const fam = await this.data('family');
    const hasFamily = Object.keys(meta.users).length > 1;
    let sent = 0, zenDone = false, calDone = false; // за один тик — не больше одной синхронизации
    for (const u of users) {
      const tz = u.tz || DEF_TZ;
      const pers = await this.data('u:' + u.id);
      const due = dueReminders(pers, tz, now, 'p').concat(hasFamily ? dueReminders(fam, tz, now, 'f').map(r => ({ ...r, text: '👨‍👩‍👧 ' + r.text })) : []);
      const hdue = dueHabitReminders(pers, tz, now, 'p', u.id).concat(dueHabitReminders(fam, tz, now, 'f', u.id));
      for (const r of due.concat(hdue)) {
        const key = u.id + ':' + r.key;
        if (meta.sent[key]) continue;
        meta.sent[key] = now;
        const res = await this.send(u.id, r.text, r.cb ? { reply_markup: { inline_keyboard: [[{ text: '✅ Готово', callback_data: r.cb }]] } } : {});
        if (res && res.ok) sent++;
      }
      if (!calDone) {
        const c = await this.ctx.storage.get('cal:' + u.id);
        if (c && (c.url || (c.sources && c.sources.length)) && now - (c.lastSync || 0) > CAL_EVERY) { calDone = true; await this.calSync(u); }
      }
      if (!zenDone) {
        const z = await this.ctx.storage.get('zen:' + u.id);
        if (z && z.token && z.error !== 'token' && now - (z.lastSync || 0) > ZEN_EVERY) { zenDone = true; await this.zenSync(u); }
      }
      for (const r of reportsDue(u, tz, now)) {
        if (r.kind === 'week') u.lastWeek = r.ymd; else u.lastMonth = r.ymd.slice(0, 7);
        const res = await this.sendReport(u, r.kind, now); if (res && res.ok) sent++;
      }
      {
        const mk = partsIn(tz, new Date(now)).ymd.slice(0, 7);
        if (!u.lim || u.lim.mk !== mk) u.lim = { mk, sent: {} };
        for (const al of limitAlerts(pers, mk, u.lim.sent, pers.currency || '₽')) {
          u.lim.sent[al.id] = al.th;
          const res = await this.send(u.id, al.text, { reply_markup: this.openBtn(meta, 'Открыть финансы') }); if (res && res.ok) sent++;
        }
      }
      const day = digestDue(u, tz, now);
      if (day) {
        u.lastDigest = day;
        const res = await this.sendDigest(meta, u, now);
        if (res && res.ok) sent++;
      }
    }
    for (const [k, t] of Object.entries(meta.sent)) if (now - t > 3 * 86400e3) delete meta.sent[k];
    await this.putMeta(meta);
    return { users: users.length, sent };
  }

  /* ---------- Первичная настройка ---------- */
  async setup(origin) {
    const meta = await this.meta();
    meta.appUrl = origin + '/';
    const steps = [];
    const me = await tg(this.env, 'getMe');
    steps.push(['Бот найден', me.ok ? '@' + me.result.username : me.description]);
    if (me.ok) meta.bot = me.result.username;
    const wh = await tg(this.env, 'setWebhook', { url: origin + '/tg', secret_token: await webhookSecret(this.env.BOT_TOKEN), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
    if (wh.ok) meta.hookv = HOOK_VER;
    steps.push(['Вебхук', wh.ok ? 'подключён' : wh.description]);
    const mb = await tg(this.env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Мой день', web_app: { url: meta.appUrl } } });
    steps.push(['Кнопка меню', mb.ok ? 'открывает ' + meta.appUrl : mb.description]);
    const cm = await tg(this.env, 'setMyCommands', { commands: COMMANDS });
    if (cm.ok) meta.cmdv = CMD_VER;
    steps.push(['Команды', cm.ok ? 'добавлены' : cm.description]);
    await this.putMeta(meta);
    return { ok: me.ok && wh.ok && mb.ok, steps, bot: meta.bot };
  }
}

/* ===================== Точка входа ===================== */
const page = (title, body) => new Response(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0d1320;color:#e9eef8;max-width:560px;margin:0 auto;padding:28px 18px}h1{font-size:22px}li{margin:6px 0}.ok{color:#3dd68c}.bad{color:#ff6b6b}a{color:#4d8dff}code{background:#1c2638;padding:2px 6px;border-radius:6px}</style></head><body>${body}</body></html>`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const store = env.STORE.get(env.STORE.idFromName('main'));

    if (url.pathname === '/tg' && req.method === 'POST') {
      if (!env.BOT_TOKEN || req.headers.get('x-telegram-bot-api-secret-token') !== await webhookSecret(env.BOT_TOKEN)) return new Response('forbidden', { status: 403 });
      const upd = await req.json().catch(() => null);
      if (upd) { try { await store.webhook(upd); } catch (e) { console.error('webhook', e); } }
      return new Response('ok');
    }

    if (url.pathname.startsWith('/api/') && req.method === 'POST') {
      if (!env.BOT_TOKEN) return json({ error: 'no_token' }, 503);
      const len = Number(req.headers.get('content-length') || 0);
      if (len > 1_500_000) return json({ error: 'too_large' }, 413);
      const body = await req.json().catch(() => null);
      if (!body) return json({ error: 'bad_request' }, 400);
      const user = await checkInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ error: 'auth' }, 401);
      const res = await store.api(url.pathname.slice(5), user, body);
      return json(res, res.status || 200);
    }

    if (url.pathname === '/setup') {
      if (!env.BOT_TOKEN) return page('Настройка', `<h1>Почти готово</h1><p class="bad">Не найден токен бота.</p><p>Открой в Cloudflare свой воркер → <b>Settings</b> → <b>Variables and Secrets</b> → <b>Add</b>, тип <b>Secret</b>, имя <code>BOT_TOKEN</code>, значение — токен от BotFather. Сохрани и открой эту страницу снова.</p>`);
      const r = await store.setup(url.origin);
      return page('Настройка', `<h1>${r.ok ? '✅ Бот подключён' : '⚠️ Есть проблемы'}</h1><ul>${r.steps.map(([a, b]) => `<li>${a}: <b>${escHtml(b)}</b></li>`).join('')}</ul>
        ${r.ok ? `<p>Теперь открой бота <a href="https://t.me/${r.bot}">@${r.bot}</a> и нажми <b>Start</b>. Кто первым нажмёт Start, тот станет владельцем.</p>` : '<p>Проверь токен в настройках и открой страницу ещё раз.</p>'}`);
    }

    if (url.pathname === '/health') return json({ ok: true, token: !!env.BOT_TOKEN });
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const store = env.STORE.get(env.STORE.idFromName('main'));
    ctx.waitUntil(store.tick(event.scheduledTime || Date.now()));
  }
};
