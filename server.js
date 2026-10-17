require('dotenv').config();
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const env = process.env;
const STAGES = ['novo', 'contato', 'proposta', 'negociacao', 'ganho', 'perdido'];
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = mysql.createPool({
  host: env.DB_HOST || 'localhost',
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME || 'crm',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  dateStrings: ['DATE'], // colunas DATE chegam como 'AAAA-MM-DD', sem problema de fuso
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const digits = s => String(s || '').replace(/\D/g, '');
// Telefones brasileiros sem código do país (10 ou 11 dígitos) ganham o 55, que a API do WhatsApp exige.
const normPhone = s => { const d = digits(s); return d.length === 10 || d.length === 11 ? '55' + d : d; };
const must = (cond, msg) => { if (!cond) throw new HttpError(400, msg); };

app.use(helmet());
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Autenticação ---------- */
const sign = u => jwt.sign({ id: u.id, role: u.role, name: u.name }, env.JWT_SECRET, { expiresIn: '12h' });

function auth(req, res, next) {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), env.JWT_SECRET);
    if (p.kind === 'visitor') throw new Error();
    req.user = p;
    next();
  } catch { res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); }
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Acesso restrito a administradores.' });

app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }), wrap(async (req, res) => {
  const { email, password } = req.body;
  const [[u]] = await db.query('SELECT * FROM users WHERE email=? AND active=1', [email || '']);
  if (!u || !(await bcrypt.compare(password || '', u.password_hash)))
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  res.json({ token: sign(u), user: { id: u.id, name: u.name, role: u.role } });
}));

/* ---------- Equipe ---------- */
app.get('/api/users', auth, wrap(async (_req, res) => {
  const [rows] = await db.query('SELECT id,name,email,role,active FROM users ORDER BY name');
  res.json(rows);
}));
app.post('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const { name, email, password, role } = req.body;
  must(name && email && password && password.length >= 8, 'Informe nome, e-mail e senha com 8+ caracteres.');
  try {
    await db.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)',
      [name, email, await bcrypt.hash(password, 12), role === 'admin' ? 'admin' : 'agent']);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Já existe um usuário com este e-mail.');
    throw e;
  }
  res.status(201).json({ ok: true });
}));

/* ---------- Utilitários de dados ---------- */
async function patch(table, id, body, allowed) {
  const f = allowed.filter(k => k in body);
  if (!f.length) return;
  await db.query(`UPDATE ${table} SET ${f.map(k => `${k}=?`).join(',')} WHERE id=?`,
    [...f.map(k => (body[k] === '' ? null : body[k])), id]);
}

async function findOrCreateContact({ name, phone, email, source }) {
  phone = normPhone(phone);
  if (phone) {
    const [[c]] = await db.query('SELECT * FROM contacts WHERE phone=? LIMIT 1', [phone]);
    if (c) return c;
  }
  const [r] = await db.query('INSERT INTO contacts (name,phone,email,source) VALUES (?,?,?,?)',
    [name, phone || null, email || null, source]);
  return { id: r.insertId, name, phone };
}

async function getConversation(contactId, channel) {
  const [[c]] = await db.query(
    "SELECT id FROM conversations WHERE contact_id=? AND channel=? AND status='open' ORDER BY id DESC LIMIT 1",
    [contactId, channel]);
  if (c) return c.id;
  const [r] = await db.query('INSERT INTO conversations (contact_id,channel) VALUES (?,?)', [contactId, channel]);
  return r.insertId;
}

/* ---------- Contatos ---------- */
app.get('/api/contacts', auth, wrap(async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const [rows] = await db.query(
    'SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? OR company LIKE ? ORDER BY created_at DESC LIMIT 500',
    [q, q, q, q]);
  res.json(rows);
}));
app.post('/api/contacts', auth, wrap(async (req, res) => {
  const b = req.body;
  must(b.name && b.name.trim(), 'Informe o nome do contato.');
  const [r] = await db.query('INSERT INTO contacts (name,email,phone,company,owner_id) VALUES (?,?,?,?,?)',
    [b.name.trim(), b.email || null, normPhone(b.phone) || null, b.company || null, req.user.id]);
  res.status(201).json({ id: r.insertId });
}));
app.get('/api/contacts/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [[c]] = await db.query('SELECT * FROM contacts WHERE id=?', [id]);
  if (!c) throw new HttpError(404, 'Contato não encontrado.');
  const [deals] = await db.query('SELECT * FROM deals WHERE contact_id=? ORDER BY created_at DESC', [id]);
  const [notes] = await db.query(
    'SELECT n.*, u.name author FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE contact_id=? ORDER BY n.id DESC', [id]);
  const [payments] = await db.query('SELECT * FROM payments WHERE contact_id=? ORDER BY id DESC', [id]);
  const [tasks] = await db.query(
    'SELECT id,title,due_date,done FROM tasks WHERE contact_id=? ORDER BY done, due_date IS NULL, due_date LIMIT 20', [id]);
  res.json({ ...c, deals, notes, payments, tasks });
}));
app.put('/api/contacts/:id', auth, wrap(async (req, res) => {
  const b = { ...req.body };
  if ('name' in b) must(String(b.name).trim(), 'O nome não pode ficar vazio.');
  if ('phone' in b) b.phone = normPhone(b.phone) || null;
  await patch('contacts', Number(req.params.id), b, ['name', 'email', 'phone', 'company']);
  res.json({ ok: true });
}));
app.delete('/api/contacts/:id', auth, wrap(async (req, res) => {
  await db.query('DELETE FROM contacts WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
}));
app.post('/api/contacts/:id/notes', auth, wrap(async (req, res) => {
  must(req.body.body && req.body.body.trim(), 'Escreva a nota.');
  await db.query('INSERT INTO notes (contact_id,user_id,body) VALUES (?,?,?)',
    [Number(req.params.id), req.user.id, req.body.body.trim()]);
  res.status(201).json({ ok: true });
}));
app.post('/api/contacts/:id/conversation', auth, wrap(async (req, res) => {
  const [[c]] = await db.query('SELECT phone FROM contacts WHERE id=?', [Number(req.params.id)]);
  must(c && c.phone, 'O contato precisa ter telefone para conversar no WhatsApp.');
  res.json({ id: await getConversation(Number(req.params.id), 'whatsapp') });
}));

/* ---------- Funil (oportunidades) ---------- */
app.get('/api/deals', auth, wrap(async (_req, res) => {
  const [rows] = await db.query(
    'SELECT d.*, c.name contact_name FROM deals d JOIN contacts c ON c.id=d.contact_id ORDER BY d.updated_at DESC');
  res.json(rows);
}));
app.post('/api/deals', auth, wrap(async (req, res) => {
  const b = req.body;
  must(b.contact_id && b.title && b.title.trim(), 'Informe o contato e o título.');
  must(!b.stage || STAGES.includes(b.stage), 'Etapa inválida.');
  const [r] = await db.query('INSERT INTO deals (contact_id,title,value,stage,owner_id,expected_close) VALUES (?,?,?,?,?,?)',
    [b.contact_id, b.title.trim(), Number(b.value) || 0, b.stage || 'novo', req.user.id, b.expected_close || null]);
  res.status(201).json({ id: r.insertId });
}));
app.put('/api/deals/:id', auth, wrap(async (req, res) => {
  const b = { ...req.body };
  must(!('stage' in b) || STAGES.includes(b.stage), 'Etapa inválida.');
  if ('value' in b) b.value = Number(b.value) || 0;
  await patch('deals', Number(req.params.id), b, ['title', 'value', 'stage', 'expected_close']);
  res.json({ ok: true });
}));
app.delete('/api/deals/:id', auth, wrap(async (req, res) => {
  await db.query('DELETE FROM deals WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
}));

/* ---------- Tarefas ---------- */
app.get('/api/tasks', auth, wrap(async (_req, res) => {
  const [rows] = await db.query(
    `SELECT t.*, c.name contact_name FROM tasks t LEFT JOIN contacts c ON c.id=t.contact_id
     ORDER BY t.done, t.due_date IS NULL, t.due_date LIMIT 300`);
  res.json(rows);
}));
app.post('/api/tasks', auth, wrap(async (req, res) => {
  const b = req.body;
  must(b.title && b.title.trim(), 'Informe o título da tarefa.');
  await db.query('INSERT INTO tasks (title,due_date,contact_id,assigned_to) VALUES (?,?,?,?)',
    [b.title.trim(), b.due_date || null, b.contact_id || null, req.user.id]);
  res.status(201).json({ ok: true });
}));
app.post('/api/tasks/:id/toggle', auth, wrap(async (req, res) => {
  await db.query('UPDATE tasks SET done=1-done WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
}));
app.delete('/api/tasks/:id', auth, wrap(async (req, res) => {
  await db.query('DELETE FROM tasks WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
}));

/* ---------- Painel ---------- */
app.get('/api/dashboard', auth, wrap(async (_req, res) => {
  const [[d]] = await db.query(`SELECT
    (SELECT COUNT(*) FROM contacts) contacts,
    (SELECT COUNT(*) FROM deals WHERE stage NOT IN ('ganho','perdido')) open_deals,
    (SELECT COALESCE(SUM(value),0) FROM deals WHERE stage NOT IN ('ganho','perdido')) pipeline,
    (SELECT COUNT(*) FROM conversations WHERE status='open') open_chats,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='approved' AND paid_at >= DATE_FORMAT(NOW(),'%Y-%m-01')) revenue_month,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='pending' AND checkout_url IS NOT NULL) pending_amount,
    (SELECT COALESCE(SUM(unread),0) FROM conversations WHERE status='open') unread`);
  const [stages] = await db.query('SELECT stage, COUNT(*) n, COALESCE(SUM(value),0) total FROM deals GROUP BY stage');
  const [tasks] = await db.query(
    `SELECT t.id,t.title,t.due_date,c.name contact_name FROM tasks t LEFT JOIN contacts c ON c.id=t.contact_id
     WHERE t.done=0 ORDER BY t.due_date IS NULL, t.due_date LIMIT 5`);
  const [chats] = await db.query(
    `SELECT cv.id, cv.channel, cv.unread, cv.last_message_at, ct.name,
       (SELECT body FROM messages WHERE conversation_id=cv.id ORDER BY id DESC LIMIT 1) last_body
     FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id
     WHERE cv.status='open' ORDER BY cv.last_message_at DESC LIMIT 5`);
  res.json({ ...d, stages, tasks, chats });
}));

/* ---------- Chat: mensagens e conversas ---------- */
async function saveMessage({ convId, direction, body, userId = null, waId = null }) {
  const [r] = await db.query(
    'INSERT INTO messages (conversation_id,direction,sender_user_id,body,wa_message_id) VALUES (?,?,?,?,?)',
    [convId, direction, userId, body, waId]);
  await db.query("UPDATE conversations SET last_message_at=NOW(), status='open', unread=unread+? WHERE id=?",
    [direction === 'in' ? 1 : 0, convId]);
  const [[msg]] = await db.query('SELECT * FROM messages WHERE id=?', [r.insertId]);
  io.to('agents').emit('message', msg);
  io.to(`conv:${convId}`).emit('message', { id: msg.id, direction: msg.direction, body: msg.body, created_at: msg.created_at });
  return msg;
}

async function sendAgentMessage(convId, userId, body) {
  const [[cv]] = await db.query(
    'SELECT cv.channel, ct.phone FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id WHERE cv.id=?', [convId]);
  if (!cv) throw new HttpError(404, 'Conversa não encontrada.');
  let waId = null;
  if (cv.channel === 'whatsapp') {
    must(cv.phone, 'O contato não tem telefone.');
    waId = await sendWhatsApp(cv.phone, body);
  }
  return saveMessage({ convId, direction: 'out', body, userId, waId });
}

app.get('/api/conversations', auth, wrap(async (req, res) => {
  const status = req.query.status === 'closed' ? 'closed' : 'open';
  const q = `%${req.query.q || ''}%`;
  const [rows] = await db.query(
    `SELECT cv.id, cv.channel, cv.status, cv.unread, cv.last_message_at, cv.contact_id, ct.name, ct.phone,
       (SELECT body FROM messages WHERE conversation_id=cv.id ORDER BY id DESC LIMIT 1) last_body
     FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id
     WHERE cv.status=? AND (ct.name LIKE ? OR ct.phone LIKE ?) ORDER BY cv.last_message_at DESC LIMIT 200`, [status, q, q]);
  res.json(rows);
}));
app.get('/api/conversations/:id/messages', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [[cv]] = await db.query(
    'SELECT cv.id, cv.channel, cv.contact_id, ct.name FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id WHERE cv.id=?', [id]);
  if (!cv) throw new HttpError(404, 'Conversa não encontrada.');
  await db.query('UPDATE conversations SET unread=0 WHERE id=?', [id]);
  const [messages] = await db.query('SELECT * FROM messages WHERE conversation_id=? ORDER BY id LIMIT 500', [id]);
  res.json({ conversation: cv, messages });
}));
app.post('/api/conversations/:id/read', auth, wrap(async (req, res) => {
  await db.query('UPDATE conversations SET unread=0 WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
}));
app.post('/api/conversations/:id/messages', auth, wrap(async (req, res) => {
  const body = String(req.body.body || '').trim();
  must(body, 'Escreva uma mensagem.');
  res.status(201).json(await sendAgentMessage(Number(req.params.id), req.user.id, body.slice(0, 4000)));
}));
app.post('/api/conversations/:id/close', auth, wrap(async (req, res) => {
  await db.query("UPDATE conversations SET status='closed' WHERE id=?", [Number(req.params.id)]);
  res.json({ ok: true });
}));

/* ---------- Chat do site (clientes) ---------- */
function visitorAuth(req, res, next) {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), env.JWT_SECRET);
    if (p.kind !== 'visitor') throw new Error();
    req.conv = p.conv;
    next();
  } catch { res.status(401).json({ error: 'Sessão do chat expirada.' }); }
}
app.post('/api/public/chat/start', rateLimit({ windowMs: 10 * 60 * 1000, limit: 15 }), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  must(name, 'Informe seu nome para iniciar a conversa.');
  const contact = await findOrCreateContact({
    name, phone: req.body.phone, email: String(req.body.email || '').slice(0, 160), source: 'chat' });
  // Sempre cria uma conversa nova: quem digita o telefone de outra pessoa não herda o histórico dela.
  const [r] = await db.query("INSERT INTO conversations (contact_id,channel) VALUES (?, 'web')", [contact.id]);
  const token = jwt.sign({ kind: 'visitor', conv: r.insertId }, env.JWT_SECRET, { expiresIn: '24h' });
  io.to('agents').emit('conversation', { id: r.insertId });
  res.json({ token });
}));
app.get('/api/public/chat/messages', visitorAuth, wrap(async (req, res) => {
  const [rows] = await db.query(
    'SELECT id,direction,body,created_at FROM messages WHERE conversation_id=? ORDER BY id LIMIT 500', [req.conv]);
  res.json(rows);
}));

/* ---------- WhatsApp Cloud API (Meta) ---------- */
async function sendWhatsApp(to, body) {
  if (!env.WA_ACCESS_TOKEN || !env.WA_PHONE_NUMBER_ID) throw new HttpError(400, 'WhatsApp não configurado no servidor.');
  const r = await fetch(`https://graph.facebook.com/${env.WA_API_VERSION || 'v21.0'}/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: true } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `WhatsApp: ${j.error?.message || 'falha ao enviar a mensagem.'}`);
  return j.messages?.[0]?.id || null;
}

function validSignature(req) {
  if (!env.WA_APP_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', env.WA_APP_SECRET).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(req.headers['x-hub-signature-256'] || '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/webhook/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.WA_VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook/whatsapp', wrap(async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido; a Meta reenvia se demorar
  for (const entry of req.body.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      for (const m of v.messages || []) {
        const [dup] = await db.query('SELECT id FROM messages WHERE wa_message_id=?', [m.id]);
        if (dup.length) continue;
        const name = v.contacts?.find(c => c.wa_id === m.from)?.profile?.name || m.from;
        const body = m.type === 'text' ? m.text.body : `[${m.type}] — mídia ainda não suportada neste CRM`;
        const contact = await findOrCreateContact({ name, phone: m.from, source: 'whatsapp' });
        await saveMessage({ convId: await getConversation(contact.id, 'whatsapp'), direction: 'in', body, waId: m.id });
      }
      for (const s of v.statuses || []) {
        if (!['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;
        await db.query('UPDATE messages SET status=? WHERE wa_message_id=?', [s.status, s.id]);
        io.to('agents').emit('status', { waId: s.id, status: s.status });
      }
    }
  }
}));

/* ---------- Pagamentos (Mercado Pago) ---------- */
app.get('/api/payments', auth, wrap(async (_req, res) => {
  const [rows] = await db.query(
    'SELECT p.*, c.name contact_name FROM payments p LEFT JOIN contacts c ON c.id=p.contact_id ORDER BY p.id DESC LIMIT 300');
  res.json(rows);
}));

app.post('/api/payments', auth, wrap(async (req, res) => {
  must(env.MP_ACCESS_TOKEN, 'O módulo de pagamentos não está configurado no servidor.');
  const { contact_id, deal_id, description } = req.body;
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  must(contact_id && description && amount > 0, 'Informe contato, descrição e um valor maior que zero.');
  const [r] = await db.query('INSERT INTO payments (contact_id,deal_id,description,amount,created_by) VALUES (?,?,?,?,?)',
    [contact_id, deal_id || null, description.slice(0, 200), amount, req.user.id]);
  const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ title: description.slice(0, 200), quantity: 1, currency_id: 'BRL', unit_price: amount }],
      external_reference: String(r.insertId),
      notification_url: `${env.PUBLIC_URL}/webhook/payments`,
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    await db.query("UPDATE payments SET status='cancelled' WHERE id=?", [r.insertId]);
    throw new HttpError(502, 'Não foi possível gerar o link de pagamento. Confira o token do Mercado Pago.');
  }
  await db.query('UPDATE payments SET provider_ref=?, checkout_url=? WHERE id=?', [j.id, j.init_point, r.insertId]);
  res.status(201).json({ id: r.insertId, checkout_url: j.init_point });
}));

app.post('/api/payments/:id/send', auth, wrap(async (req, res) => {
  const [[p]] = await db.query('SELECT * FROM payments WHERE id=?', [Number(req.params.id)]);
  must(p && p.checkout_url && p.contact_id, 'Cobrança sem link ou sem contato.');
  const [[c]] = await db.query('SELECT phone FROM contacts WHERE id=?', [p.contact_id]);
  must(c && c.phone, 'O contato precisa ter telefone para receber o link no WhatsApp.');
  const convId = await getConversation(p.contact_id, 'whatsapp');
  const text = `${p.description} — R$ ${Number(p.amount).toFixed(2).replace('.', ',')}\nPague por aqui: ${p.checkout_url}`;
  await sendAgentMessage(convId, req.user.id, text);
  res.json({ ok: true, conversation_id: convId });
}));

// O Mercado Pago só avisa "tem novidade"; confirmamos o status consultando a API deles (não confiamos no corpo recebido).
app.post('/webhook/payments', wrap(async (req, res) => {
  res.sendStatus(200);
  const type = req.body?.type || req.query.type;
  const pid = req.body?.data?.id || req.query['data.id'];
  if (type !== 'payment' || !pid || !env.MP_ACCESS_TOKEN) return;
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(pid)}`,
    { headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` } });
  if (!r.ok) return;
  const p = await r.json();
  const map = { approved: 'approved', rejected: 'rejected', cancelled: 'cancelled', refunded: 'refunded', charged_back: 'refunded' };
  const status = map[p.status] || 'pending';
  const id = Number(p.external_reference);
  if (!id) return;
  await db.query(
    "UPDATE payments SET status=?, provider_payment_id=?, paid_at=IF(?='approved', COALESCE(paid_at, NOW()), paid_at) WHERE id=?",
    [status, String(p.id), status, id]);
  if (status === 'approved') io.to('agents').emit('payment', { id });
}));

/* ---------- Tempo real (Socket.IO) ---------- */
io.use((socket, next) => {
  try { socket.p = jwt.verify(socket.handshake.auth?.token, env.JWT_SECRET); next(); }
  catch { next(new Error('unauthorized')); }
});
io.on('connection', socket => {
  const p = socket.p;
  if (p.kind === 'visitor') {
    socket.join(`conv:${p.conv}`);
    socket.on('visitor:message', async (text, ack) => {
      try {
        text = String(text || '').trim().slice(0, 2000);
        if (!text) return;
        await saveMessage({ convId: p.conv, direction: 'in', body: text });
        if (typeof ack === 'function') ack(true);
      } catch (e) { console.error(e); if (typeof ack === 'function') ack(false); }
    });
  } else {
    socket.join('agents');
  }
});

/* ---------- Erros ---------- */
app.use((err, _req, res, _next) => {
  if (res.headersSent) return console.error(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

if (!env.JWT_SECRET) { console.error('Defina JWT_SECRET no arquivo .env'); process.exit(1); }
server.listen(env.PORT || 3000, () => console.log(`CRM rodando na porta ${env.PORT || 3000}`));
