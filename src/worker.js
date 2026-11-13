// «Мой день» — сервер для Telegram Mini App на Cloudflare Workers.
// Хранит данные (личные и семейные), шлёт напоминания и утреннюю сводку.
import { DurableObject } from 'cloudflare:workers';
import {
  DEF_TZ, emptyState, applyOps, checkInitData, webhookSecret, validTz,
  dueReminders, buildDigest, digestDue, escHtml,
  ZEN_API, zenDiffToOps, firstOfPrevMonth, partsIn, splitShop, shopAddOps, SHOP_RE
} from './lib.js';

const COMMANDS = [
  { command: 'today', description: 'Сводка на сегодня' },
  { command: 'shop', description: 'Список покупок' },
  { command: 'invite', description: 'Пригласить в семью' },
  { command: 'help', description: 'Что умеет бот' }
];
const CMD_VER = 2;

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
    const members = () => Object.values(meta.users).map(u => ({ id: u.id, name: u.name }));
    const pub = () => ({ id: me.id, name: me.name, isOwner: meta.owner === me.id, digest: me.digest, digestOn: me.digestOn !== false, tz: me.tz, started: !!me.started });

    if (action === 'load') {
      if (body.tz) me.tz = validTz(String(body.tz));
      await this.putMeta(meta);
      return { ok: true, me: pub(), members: members(), bot: meta.bot, zen: await this.zenStatus(me.id), personal: await this.data('u:' + me.id), family: await this.data('family') };
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
      if (typeof body.name === 'string' && body.name.trim()) me.name = body.name.trim().slice(0, 40);
      await this.putMeta(meta);
      return { ok: true, me: pub() };
    }
    if (action === 'digest') {
      if (!me.started) return { ok: false, error: 'not_started' };
      const r = await this.sendDigest(meta, me, Date.now());
      return { ok: !!(r && r.ok), error: r && r.ok ? undefined : 'send_failed' };
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
    return { status: 404, error: 'unknown_action' };
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

  async sendDigest(meta, me, now, manual = false) {
    const pers = await this.data('u:' + me.id);
    const fam = await this.data('family');
    const text = buildDigest({ name: pers.name || me.name, pers, fam, tz: me.tz || DEF_TZ, now, hasFamily: Object.keys(meta.users).length > 1 });
    return this.send(me.id, text, { reply_markup: this.openBtn(meta), disable_notification: false });
  }

  /* ---------- Каждую минуту ---------- */
  async tick(now = Date.now()) {
    if (!this.env.BOT_TOKEN) return { skipped: 'no_token' };
    const meta = await this.meta();
    if (meta.cmdv !== CMD_VER && meta.appUrl) { const cm = await tg(this.env, 'setMyCommands', { commands: COMMANDS }); if (cm.ok) meta.cmdv = CMD_VER; }
    const users = Object.values(meta.users).filter(u => u.started);
    if (!users.length) return { users: 0 };
    const fam = await this.data('family');
    const hasFamily = Object.keys(meta.users).length > 1;
    let sent = 0, zenDone = false; // за один тик — не больше одной синхронизации
    for (const u of users) {
      const tz = u.tz || DEF_TZ;
      const pers = await this.data('u:' + u.id);
      const due = dueReminders(pers, tz, now, 'p').concat(hasFamily ? dueReminders(fam, tz, now, 'f').map(r => ({ ...r, text: '👨‍👩‍👧 ' + r.text })) : []);
      for (const r of due) {
        const key = u.id + ':' + r.key;
        if (meta.sent[key]) continue;
        meta.sent[key] = now;
        const res = await this.send(u.id, r.text);
        if (res && res.ok) sent++;
      }
      if (!zenDone) {
        const z = await this.ctx.storage.get('zen:' + u.id);
        if (z && z.token && z.error !== 'token' && now - (z.lastSync || 0) > ZEN_EVERY) { zenDone = true; await this.zenSync(u); }
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
    const wh = await tg(this.env, 'setWebhook', { url: origin + '/tg', secret_token: await webhookSecret(this.env.BOT_TOKEN), allowed_updates: ['message'], drop_pending_updates: true });
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
