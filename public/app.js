'use strict';
/* ====================== Utilitários ====================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const skeleton = (n = 4) => Array.from({ length: n }, () => '<div class="sk"></div>').join('');

const iso = d => new Date(d).toLocaleDateString('sv-SE');           // AAAA-MM-DD no fuso do navegador
const today = () => iso(Date.now());
const yesterday = () => iso(Date.now() - 864e5);
const clock = v => new Date(v).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateBR = v => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '');
const dayLabel = k => (k === today() ? 'Hoje' : k === yesterday() ? 'Ontem' : dateBR(k));
const listTime = v => { const k = iso(v); return k === today() ? clock(v) : k === yesterday() ? 'Ontem' : dateBR(k).slice(0, 5); };
const linkify = html => html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

function fmtPhone(p) {
  if (!p) return '';
  const fmt = n => (n.length === 9 ? `${n.slice(0, 5)}-${n.slice(5)}` : `${n.slice(0, 4)}-${n.slice(4)}`);
  if (p.startsWith('55') && (p.length === 12 || p.length === 13)) return `+55 (${p.slice(2, 4)}) ${fmt(p.slice(4))}`;
  if (p.length === 10 || p.length === 11) return `(${p.slice(0, 2)}) ${fmt(p.slice(2))}`;
  return '+' + p;
}

const TONES = [['#DCEEEF', '#0F5C63'], ['#FBEBC8', '#7A5200'], ['#E6E3F4', '#4B3F8F'], ['#F8DCD6', '#9A3320'], ['#DCEBDD', '#2C6B3A'], ['#E9E5DA', '#5E5640']];
function avatar(name, size = '') {
  const s = String(name || '?').trim() || '?';
  let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = TONES[h % TONES.length];
  const parts = s.split(/\s+/);
  const ini = ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  return `<span class="av ${size}" style="background:${bg};color:${fg}" aria-hidden="true">${esc(ini)}</span>`;
}

const STAGES = { novo: 'Novo', contato: 'Em contato', proposta: 'Proposta', negociacao: 'Negociação', ganho: 'Ganho', perdido: 'Perdido' };
const PAY = { pending: 'Pendente', approved: 'Aprovado', rejected: 'Recusado', cancelled: 'Cancelado', refunded: 'Estornado' };
const SOURCE = { manual: 'Manual', whatsapp: 'WhatsApp', chat: 'Chat do site' };
const MSG_STATUS = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' };
const NAV = [['dashboard', 'Painel', 'home'], ['chats', 'Conversas', 'chat'], ['contacts', 'Contatos', 'users'],
  ['deals', 'Funil', 'kanban'], ['tasks', 'Tarefas', 'check'], ['payments', 'Cobranças', 'card']];

let token = localStorage.getItem('token');
let me = JSON.parse(localStorage.getItem('me') || 'null');
let socket, current = 'dashboard', activeConv = null, convStatus = 'open', convQ = '', payFilter = 'all';
const cache = {};

/* ====================== Interface base ====================== */
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  $('#toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), 3300);
  setTimeout(() => t.remove(), 3700);
}
const fail = e => toast(e.message || 'Algo deu errado. Tente novamente.', 'error');

function ask(title, text, ok = 'Confirmar', danger = false) {
  return new Promise(resolve => {
    const d = $('#ask');
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p class="txt">${esc(text)}</p>
      <div class="row"><button value="0">Cancelar</button><button value="1" class="${danger ? 'danger-solid' : 'primary'}">${esc(ok)}</button></div></form>`;
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === '1');
    d.showModal();
  });
}

function openForm(title, fields, values, onSave) {
  const d = $('#dlg');
  const control = f => {
    const v = values[f.name];
    if (f.type === 'select')
      return `<select name="${f.name}">${f.options.map(([val, lab]) =>
        `<option value="${esc(val)}" ${String(v ?? '') === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
    return `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.ph || '')}" ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''} autocomplete="off">`;
  };
  d.innerHTML = `<form><h2>${esc(title)}</h2>${fields.map(f => `<label class="field">${esc(f.label)}${control(f)}</label>`).join('')}
    <p class="err" id="ferr" role="alert"></p>
    <div class="row"><button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div></form>`;
  if (!d.open) d.showModal();
  const form = $('form', d);
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('.primary', form); btn.disabled = true;
    try { await onSave(Object.fromEntries(new FormData(form))); }
    catch (err) { $('#ferr').textContent = err.message; }
    finally { btn.disabled = false; }
  };
  $('input,select', form)?.focus();
}

function openDrawer() { $('#drawer').hidden = false; $('#scrim').hidden = false; document.body.classList.add('lock'); }
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; document.body.classList.remove('lock'); }

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/auth')) { logout(); throw new Error(j.error); }
  if (!r.ok) throw new Error(j.error || 'Erro inesperado.');
  return j;
}

const actions = {};
document.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) return $('#dlg').close();
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) actions[el.dataset.act]?.(el.dataset, el);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[role=button],tr[data-act]')) e.target.click();
  if (e.key === 'Escape' && !$('#drawer').hidden && !$('#dlg').open && !$('#ask').open) closeDrawer();
});

const emptyState = (icon, title, text, cta = '') =>
  `<div class="empty-state">${ic(icon, 'big')}<h3>${esc(title)}</h3><p>${esc(text)}</p>${cta}</div>`;

function page(title, sub, actionsHTML, body) {
  $('#view').innerHTML = `<div class="page"><header class="page-head"><div><h1>${title}</h1><p id="sub">${sub || ''}</p></div>
    <div class="actions">${actionsHTML || ''}</div></header><div id="body">${body || ''}</div></div>`;
}

/* ====================== Painel ====================== */
const views = {};
const dueTag = (d, done) => {
  if (!d) return '';
  const late = !done && d < today();
  return `<span class="due ${late ? 'late' : ''}">${ic('cal')}${d === today() ? 'Hoje' : dateBR(d)}</span>`;
};

views.dashboard = async () => {
  page(`Olá, ${esc(me.name.split(' ')[0])}`, new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }), '', skeleton(6));
  const d = await api('/dashboard');
  const max = Math.max(1, ...d.stages.map(s => s.n));
  const bars = Object.keys(STAGES).map(k => {
    const s = d.stages.find(x => x.stage === k) || { n: 0, total: 0 };
    return `<div class="bar-row stage-${k}"><span>${STAGES[k]}</span><div class="bar-track"><div class="bar-fill" style="width:${(s.n / max) * 100}%"></div></div>
      <span class="num"><b>${s.n}</b> <span class="muted">${money(s.total)}</span></span></div>`;
  }).join('');
  const tile = (to, icon, label, value, small, hot) =>
    `<button class="tile ${hot ? 'hot' : ''}" data-act="go" data-to="${to}"><span class="lab">${ic(icon)}${label}</span><b>${value}</b><small>${small}</small></button>`;
  $('#body').innerHTML = `
    <div class="tiles">
      ${tile('chats', 'chat', 'Conversas abertas', d.open_chats, d.unread ? `${d.unread} não lida${d.unread > 1 ? 's' : ''}` : 'Tudo em dia', d.unread > 0)}
      ${tile('deals', 'kanban', 'Oportunidades abertas', d.open_deals, `${money(d.pipeline)} no funil`)}
      ${tile('payments', 'card', 'Recebido no mês', money(d.revenue_month), `${money(d.pending_amount)} a receber`)}
      ${tile('contacts', 'users', 'Contatos', d.contacts, 'na base')}
    </div>
    <div class="cols">
      <section class="panel"><h2>Funil de vendas</h2><div class="bars">${bars}</div></section>
      <section class="panel"><h2>Próximas tarefas</h2>${d.tasks.length ? `<div class="rows">${d.tasks.map(t => `<div data-act="go" data-to="tasks">
        <div class="grow"><b>${esc(t.title)}</b><span>${esc(t.contact_name || 'Sem contato')}</span></div>${dueTag(t.due_date)}</div>`).join('')}</div>`
        : '<p class="muted">Nenhuma tarefa pendente.</p>'}</section>
    </div>
    <section class="panel"><h2>Conversas recentes</h2>${d.chats.length ? `<div class="rows">${d.chats.map(c => `<div data-act="openConv" data-id="${c.id}" role="button" tabindex="0">
      ${avatar(c.name)}<div class="grow"><b>${esc(c.name)}</b><span>${esc(c.last_body || '')}</span></div>
      ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}<span class="muted">${listTime(c.last_message_at)}</span></div>`).join('')}</div>`
      : '<p class="muted">Nenhuma conversa aberta no momento.</p>'}</section>`;
};
actions.go = ({ to }) => go(to);

/* ====================== Contatos ====================== */
const contactFields = [
  { name: 'name', label: 'Nome', required: true },
  { name: 'phone', label: 'Telefone / WhatsApp', ph: '(11) 99999-8888' },
  { name: 'email', label: 'E-mail', type: 'email' },
  { name: 'company', label: 'Empresa' },
];

views.contacts = async () => {
  page('Contatos', '', `<label class="search">${ic('search')}<input id="q" type="search" placeholder="Buscar por nome, telefone ou e-mail" aria-label="Buscar contatos"></label>
    <button class="primary" data-act="newContact">${ic('plus')}Novo contato</button>`, skeleton(6));
  const load = async () => {
    const q = $('#q')?.value || '';
    const rows = await api('/contacts?q=' + encodeURIComponent(q));
    if (current !== 'contacts') return;
    $('#sub').textContent = `${rows.length} ${rows.length === 1 ? 'contato' : 'contatos'}`;
    $('#body').innerHTML = rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nome</th><th>Telefone</th><th>E-mail</th><th>Origem</th><th>Cadastro</th></tr></thead><tbody>${
      rows.map(c => `<tr data-act="contact" data-id="${c.id}" tabindex="0"><td><div class="who">${avatar(c.name)}<div><b>${esc(c.name)}</b><span>${esc(c.company || '')}</span></div></div></td>
        <td>${esc(fmtPhone(c.phone))}</td><td>${esc(c.email || '')}</td><td><span class="tag src-${c.source}">${SOURCE[c.source]}</span></td>
        <td class="muted">${dateBR(iso(c.created_at))}</td></tr>`).join('')}</tbody></table></div>`
      : q ? emptyState('search', 'Nada encontrado', `Nenhum contato corresponde a “${q}”.`)
        : emptyState('users', 'Nenhum contato ainda', 'Cadastre o primeiro ou aguarde uma mensagem no WhatsApp: quem escrever vira contato automaticamente.',
          `<button class="primary" data-act="newContact">${ic('plus')}Novo contato</button>`);
  };
  cache.reloadList = load;
  $('#q').oninput = debounce(() => load().catch(fail), 250);
  await load();
};

actions.newContact = () => openForm('Novo contato', contactFields, {}, async data => {
  await api('/contacts', 'POST', data); $('#dlg').close(); toast('Contato criado.', 'ok'); afterContactChange();
});

async function renderContact(el, id, drawer) {
  el.innerHTML = skeleton(6);
  const c = await api('/contacts/' + id);
  cache[drawer ? 'drawerId' : 'ctxId'] = id;
  const info = [['phone', fmtPhone(c.phone)], ['mail', c.email], ['building', c.company]].filter(x => x[1]);
  el.innerHTML = `
    <div class="c-head">${avatar(c.name, 'xl')}<div><h2>${esc(c.name)}</h2><p>${SOURCE[c.source]}, desde ${dateBR(iso(c.created_at))}</p></div>
      ${drawer ? `<button class="icon-btn ghost" data-act="closeDrawer" aria-label="Fechar">${ic('x')}</button>` : ''}</div>
    <div class="c-actions">
      <button class="primary" data-act="chatWith" data-id="${c.id}" ${c.phone ? '' : 'disabled title="Cadastre um telefone para conversar"'}>${ic('chat')}Conversar</button>
      <button data-act="charge" data-id="${c.id}">${ic('card')}Cobrar</button>
      <button data-act="editContact" data-id="${c.id}">${ic('edit')}Editar</button>
      <button class="icon-btn danger" data-act="delContact" data-id="${c.id}" aria-label="Excluir contato">${ic('trash')}</button></div>
    ${info.map(([i, t]) => `<div class="info-row">${ic(i)}<span>${esc(t)}</span></div>`).join('') || '<p class="muted">Sem telefone, e-mail ou empresa.</p>'}
    <section class="sec"><h3>Oportunidades <button class="link" data-act="newDeal" data-contact="${c.id}">Adicionar</button></h3>
      ${c.deals.length ? c.deals.map(x => `<div class="mini"><span class="t">${esc(x.title)}<br><b>${money(x.value)}</b></span><span class="tag stage-${x.stage}">${STAGES[x.stage]}</span></div>`).join('') : '<p class="muted">Nenhuma oportunidade.</p>'}</section>
    <section class="sec"><h3>Cobranças</h3>
      ${c.payments.length ? c.payments.map(p => `<div class="mini"><span class="t">${esc(p.description)}<br><b>${money(p.amount)}</b></span><span class="tag pay-${p.status}">${PAY[p.status]}</span></div>`).join('') : '<p class="muted">Nenhuma cobrança.</p>'}</section>
    <section class="sec"><h3>Tarefas</h3>
      ${c.tasks.length ? c.tasks.map(t => `<div class="mini"><span class="t">${esc(t.title)}</span>${t.done ? '<span class="tag pay-approved">Feita</span>' : dueTag(t.due_date)}</div>`).join('') : '<p class="muted">Nenhuma tarefa.</p>'}</section>
    <section class="sec"><h3>Notas</h3>
      <form class="noteform"><input name="body" placeholder="Escreva uma nota" aria-label="Nova nota" required><button class="primary">Salvar</button></form>
      ${c.notes.map(n => `<div class="note"><small>${esc(n.author || 'Sistema')}, ${dateBR(iso(n.created_at))} ${clock(n.created_at)}</small>${esc(n.body)}</div>`).join('')}</section>`;
  $('.noteform', el).onsubmit = async e => {
    e.preventDefault();
    try { await api(`/contacts/${id}/notes`, 'POST', { body: e.target.body.value }); renderContact(el, id, drawer); } catch (err) { fail(err); }
  };
}

function afterContactChange() {
  if (!$('#drawer').hidden && cache.drawerId) renderContact($('#drawer-body'), cache.drawerId, true).catch(fail);
  if ($('#ctx') && cache.ctxId) renderContact($('#ctx'), cache.ctxId, false).catch(() => {});
  if (current === 'contacts') cache.reloadList?.();
  if (current === 'chats') loadConvs().catch(() => {});
}

actions.contact = ({ id }) => { openDrawer(); renderContact($('#drawer-body'), id, true).catch(err => { closeDrawer(); fail(err); }); };
actions.closeDrawer = closeDrawer;
actions.editContact = async ({ id }) => {
  const c = await api('/contacts/' + id);
  openForm('Editar contato', contactFields, c, async data => {
    await api('/contacts/' + id, 'PUT', data); $('#dlg').close(); toast('Contato atualizado.', 'ok'); afterContactChange();
  });
};
actions.delContact = async ({ id }) => {
  if (!await ask('Excluir contato?', 'Oportunidades, notas e conversas deste contato também serão apagadas. Esta ação não pode ser desfeita.', 'Excluir', true)) return;
  try {
    await api('/contacts/' + id, 'DELETE'); closeDrawer(); toast('Contato excluído.', 'ok');
    cache.ctxId = null; current === 'chats' ? go('chats') : route();
  } catch (err) { fail(err); }
};
actions.chatWith = async ({ id }) => {
  try { const r = await api(`/contacts/${id}/conversation`, 'POST'); go('chats', r.id); } catch (err) { fail(err); }
};
actions.charge = ({ id }) => newCharge(id);

/* ====================== Funil ====================== */
const dealFields = contacts => [
  { name: 'contact_id', label: 'Contato', type: 'select', options: contacts.map(c => [c.id, c.name]) },
  { name: 'title', label: 'Título', required: true, ph: 'Ex.: Plano anual' },
  { name: 'value', label: 'Valor (R$)', type: 'number', step: '0.01' },
  { name: 'stage', label: 'Etapa', type: 'select', options: Object.entries(STAGES) },
  { name: 'expected_close', label: 'Previsão de fechamento', type: 'date' },
];

views.deals = async () => {
  page('Funil', '', `<button class="primary" data-act="newDeal">${ic('plus')}Nova oportunidade</button>`, skeleton(6));
  const rows = await api('/deals'); cache.deals = rows;
  if (current !== 'deals') return;
  const openRows = rows.filter(r => !['ganho', 'perdido'].includes(r.stage));
  $('#sub').textContent = `${openRows.length} em andamento, ${money(openRows.reduce((s, r) => s + Number(r.value), 0))} no funil`;
  $('#body').innerHTML = `<div class="board">${Object.entries(STAGES).map(([k, l]) => {
    const items = rows.filter(r => r.stage === k);
    return `<section class="col stage-${k}" data-stage="${k}" aria-label="${l}"><header>${l}<small>${items.length} - ${money(items.reduce((s, r) => s + Number(r.value), 0))}</small></header>${
      items.map(r => {
        const late = r.expected_close && r.expected_close < today() && !['ganho', 'perdido'].includes(r.stage);
        return `<article class="deal" draggable="true" data-id="${r.id}" data-act="editDeal" tabindex="0" role="button">
          <b>${esc(r.title)}</b><div class="meta">${avatar(r.contact_name, 'sm')}<span>${esc(r.contact_name)}</span></div>
          <div class="foot"><span class="val">${money(r.value)}</span>${r.expected_close ? `<span class="due ${late ? 'late' : ''}">${ic('cal')}${dateBR(r.expected_close)}</span>` : ''}</div></article>`;
      }).join('')}</section>`;
  }).join('')}</div>`;
  $$('.deal').forEach(c => {
    c.ondragstart = e => { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('drag'); };
    c.ondragend = () => c.classList.remove('drag');
  });
  $$('.col').forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = async e => {
      e.preventDefault(); col.classList.remove('over');
      try { await api('/deals/' + e.dataTransfer.getData('text/plain'), 'PUT', { stage: col.dataset.stage }); views.deals(); } catch (err) { fail(err); }
    };
  });
};
actions.newDeal = async ({ contact }) => {
  try {
    const contacts = await api('/contacts');
    if (!contacts.length) return toast('Cadastre um contato antes de criar uma oportunidade.', 'error');
    openForm('Nova oportunidade', dealFields(contacts), { stage: 'novo', contact_id: contact }, async data => {
      await api('/deals', 'POST', data); $('#dlg').close(); toast('Oportunidade criada.', 'ok');
      current === 'deals' ? views.deals() : afterContactChange();
    });
  } catch (err) { fail(err); }
};
actions.editDeal = ({ id }) => {
  const deal = cache.deals.find(d => d.id == id);
  openForm(deal.title, dealFields([]).filter(f => f.name !== 'contact_id'), { ...deal, expected_close: deal.expected_close?.slice(0, 10) }, async data => {
    await api('/deals/' + id, 'PUT', data); $('#dlg').close(); views.deals();
  });
  $('#dlg .row').insertAdjacentHTML('afterbegin', `<button type="button" class="danger" data-act="delDeal" data-id="${id}" style="margin-right:auto">${ic('trash')}Excluir</button>`);
};
actions.delDeal = async ({ id }) => {
  if (!await ask('Excluir oportunidade?', 'Ela sai do funil e não poderá ser recuperada.', 'Excluir', true)) return;
  try { await api('/deals/' + id, 'DELETE'); $('#dlg').close(); views.deals(); } catch (err) { fail(err); }
};

/* ====================== Conversas ====================== */
function setBadge(n) {
  $$('[data-badge]').forEach(b => (b.textContent = n || ''));
  document.title = n ? `(${n}) CRM` : 'CRM';
}
const refreshBadge = () => api('/conversations?status=open').then(rows => setBadge(rows.reduce((s, c) => s + c.unread, 0))).catch(() => {});

async function loadConvs() {
  const box = $('#convs'); if (!box) return;
  const rows = await api(`/conversations?status=${convStatus}&q=${encodeURIComponent(convQ)}`);
  if (!$('#convs')) return;
  if (convStatus === 'open' && !convQ) setBadge(rows.reduce((s, c) => s + c.unread, 0));
  box.innerHTML = rows.length ? rows.map(c => `<div class="conv ${c.id === activeConv ? 'on' : ''} ${c.unread ? 'unread' : ''}" data-act="openConv" data-id="${c.id}" role="button" tabindex="0">
      ${avatar(c.name)}<div class="cbody"><div class="top"><b>${esc(c.name)}</b><span class="tag src-${c.channel === 'web' ? 'chat' : 'whatsapp'}">${c.channel === 'web' ? 'Site' : 'WhatsApp'}</span><time>${listTime(c.last_message_at)}</time></div>
      <div class="sub"><p>${esc(c.last_body || 'Sem mensagens')}</p>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div></div></div>`).join('')
    : emptyState('chat', convQ ? 'Nada encontrado' : convStatus === 'open' ? 'Nenhuma conversa aberta' : 'Nenhuma conversa encerrada',
      convQ ? 'Tente outro nome ou telefone.' : 'Quando um cliente escrever, a conversa aparece aqui na hora.');
}

views.chats = async arg => {
  activeConv = arg ? Number(arg) : null;
  if (!$('#inbox')) {
    $('#view').innerHTML = `<div class="inbox" id="inbox" data-pane="list">
      <section class="list"><div class="list-head"><h1>Conversas</h1>
        <label class="search">${ic('search')}<input id="cq" type="search" placeholder="Buscar conversa" aria-label="Buscar conversa" value="${esc(convQ)}"></label>
        <div class="tabs"><button class="${convStatus === 'open' ? 'on' : ''}" data-act="convTab" data-s="open">Abertas</button>
        <button class="${convStatus === 'closed' ? 'on' : ''}" data-act="convTab" data-s="closed">Encerradas</button></div></div>
        <div class="convs" id="convs">${skeleton(5)}</div></section>
      <section class="thread" id="thread"></section><aside class="ctx" id="ctx"></aside></div>`;
    $('#cq').oninput = debounce(e => { convQ = e.target.value; loadConvs().catch(fail); }, 250);
  }
  await loadConvs();
  await showConv();
};

actions.openConv = ({ id }) => go('chats', id);
actions.backToList = () => go('chats');
actions.convTab = ({ s }) => {
  convStatus = s;
  $$('.list-head .tabs button').forEach(b => b.classList.toggle('on', b.dataset.s === s));
  loadConvs().catch(fail);
};
actions.closeConv = async ({ id }) => {
  try { await api(`/conversations/${id}/close`, 'POST'); toast('Conversa encerrada.', 'ok'); go('chats'); } catch (err) { fail(err); }
};

const msgHTML = m => `<div class="msg ${m.direction}" data-mid="${m.id}" ${m.wa_message_id ? `data-wa="${esc(m.wa_message_id)}"` : ''}>${linkify(esc(m.body))}<small>${clock(m.created_at)}${
  m.direction === 'out' && m.wa_message_id ? ` <i class="st">${MSG_STATUS[m.status] || ''}</i>` : ''}</small></div>`;

function addMsg(m) {
  const box = $('#msgs');
  if (!box || $(`[data-mid="${m.id}"]`, box)) return;
  $('.hint', box)?.remove();
  const k = iso(m.created_at);
  const sep = box.dataset.day !== k ? `<div class="day"><span>${dayLabel(k)}</span></div>` : '';
  box.dataset.day = k;
  box.insertAdjacentHTML('beforeend', sep + msgHTML(m));
  box.scrollTop = box.scrollHeight;
}

async function showConv() {
  const inbox = $('#inbox'); if (!inbox) return;
  inbox.dataset.pane = activeConv ? 'thread' : 'list';
  $$('.conv', inbox).forEach(x => x.classList.toggle('on', Number(x.dataset.id) === activeConv));
  if (!activeConv) {
    $('#thread').innerHTML = emptyState('chat', 'Selecione uma conversa', 'Mensagens do WhatsApp e do chat do site chegam aqui em tempo real.');
    $('#ctx').innerHTML = ''; cache.ctxId = null; return;
  }
  const { conversation: cv, messages } = await api(`/conversations/${activeConv}/messages`);
  if (!$('#inbox') || cv.id !== activeConv) return;
  const lastIn = [...messages].reverse().find(m => m.direction === 'in');
  const expired = cv.channel === 'whatsapp' && (!lastIn || Date.now() - new Date(lastIn.created_at) > 864e5);
  $('#thread').innerHTML = `<header class="t-head"><button class="icon-btn ghost back" data-act="backToList" aria-label="Voltar para a lista">${ic('back')}</button>
      <div class="who">${avatar(cv.name, 'lg')}<div><b>${esc(cv.name)}</b><span>${cv.channel === 'whatsapp' ? 'WhatsApp' : 'Chat do site'}</span></div></div>
      <button class="only-narrow" data-act="contact" data-id="${cv.contact_id}">${ic('users')}Contato</button>
      <button data-act="charge" data-id="${cv.contact_id}">${ic('card')}Cobrar</button>
      <button data-act="closeConv" data-id="${cv.id}">Encerrar</button></header>
    <div class="msgs" id="msgs">${messages.length ? '' : '<p class="hint">Ainda não há mensagens. Escreva abaixo para começar.</p>'}</div>
    ${expired ? `<p class="notice">${lastIn ? 'A janela de 24 h do WhatsApp fechou: texto livre só é entregue se o cliente escrever de novo.' : 'Este contato ainda não escreveu para você.'} Para falar primeiro é preciso um modelo de mensagem aprovado pela Meta.</p>` : ''}
    <form class="composer" id="composer"><textarea name="body" rows="1" placeholder="Escreva uma mensagem" aria-label="Mensagem" required></textarea>
      <button class="primary" aria-label="Enviar mensagem">${ic('send')}</button></form>`;
  messages.forEach(addMsg);
  const ta = $('#composer textarea');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
  $('#composer').onsubmit = async e => {
    e.preventDefault();
    const btn = $('button', e.target), text = ta.value.trim(); if (!text) return;
    btn.disabled = true;
    try { const m = await api(`/conversations/${cv.id}/messages`, 'POST', { body: text }); ta.value = ''; ta.style.height = 'auto'; addMsg(m); }
    catch (err) { fail(err); }
    finally { btn.disabled = false; ta.focus(); }
  };
  if (window.matchMedia('(min-width:861px)').matches) ta.focus();
  renderContact($('#ctx'), cv.contact_id, false).catch(() => {});
  loadConvs().catch(() => {});
}

/* ====================== Tarefas ====================== */
views.tasks = async () => {
  page('Tarefas', '', '', skeleton(5));
  const [rows, contacts] = await Promise.all([api('/tasks'), api('/contacts')]);
  if (current !== 'tasks') return;
  const t0 = today(), open = rows.filter(t => !t.done);
  const groups = [
    ['Atrasadas', open.filter(t => t.due_date && t.due_date < t0), 'late'], ['Hoje', open.filter(t => t.due_date === t0), ''],
    ['Próximas', open.filter(t => !t.due_date || t.due_date > t0), ''], ['Concluídas', rows.filter(t => t.done).slice(0, 10), ''],
  ].filter(g => g[1].length);
  const row = t => `<div class="task ${t.done ? 'done' : ''}"><input class="chk" type="checkbox" data-act="toggleTask" data-id="${t.id}" ${t.done ? 'checked' : ''} aria-label="Concluir: ${esc(t.title)}">
    <div class="t"><b>${esc(t.title)}</b>${t.contact_name ? `<small>${esc(t.contact_name)}</small>` : ''}</div>${dueTag(t.due_date, t.done)}
    <button class="icon-btn ghost danger" data-act="delTask" data-id="${t.id}" aria-label="Excluir tarefa">${ic('trash')}</button></div>`;
  $('#sub').textContent = `${open.length} em aberto`;
  $('#body').innerHTML = `<form class="quick" id="taskform"><input name="title" placeholder="O que precisa ser feito?" aria-label="Título da tarefa" required>
    <input name="due_date" type="date" aria-label="Prazo"><select name="contact_id" aria-label="Contato"><option value="">Sem contato</option>${contacts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    <button class="primary">${ic('plus')}Adicionar</button></form>
    ${groups.length ? groups.map(([n, items, cls]) => `<section class="group ${cls}"><h2>${n} <span class="n">${items.length}</span></h2>${items.map(row).join('')}</section>`).join('')
      : emptyState('check', 'Nenhuma tarefa', 'Registre retornos e lembretes acima para não perder nenhum cliente.')}`;
  $('#taskform').onsubmit = async e => {
    e.preventDefault();
    try { await api('/tasks', 'POST', Object.fromEntries(new FormData(e.target))); views.tasks(); } catch (err) { fail(err); }
  };
};
actions.toggleTask = async ({ id }) => { try { await api(`/tasks/${id}/toggle`, 'POST'); views.tasks(); } catch (err) { fail(err); } };
actions.delTask = async ({ id }) => { try { await api('/tasks/' + id, 'DELETE'); views.tasks(); } catch (err) { fail(err); } };

/* ====================== Cobranças ====================== */
views.payments = async () => {
  page('Cobranças', '', `<button class="primary" data-act="newCharge">${ic('plus')}Nova cobrança</button>`, skeleton(5));
  const rows = await api('/payments');
  if (current !== 'payments') return;
  const month = today().slice(0, 7);
  const received = rows.filter(p => p.status === 'approved' && p.paid_at && iso(p.paid_at).startsWith(month)).reduce((s, p) => s + Number(p.amount), 0);
  const pending = rows.filter(p => p.status === 'pending' && p.checkout_url);
  const list = payFilter === 'all' ? rows : rows.filter(p => p.status === payFilter);
  $('#body').innerHTML = `<div class="tiles three">
      <div class="tile"><span class="lab">Recebido no mês</span><b>${money(received)}</b></div>
      <div class="tile"><span class="lab">A receber</span><b>${money(pending.reduce((s, p) => s + Number(p.amount), 0))}</b><small>${pending.length} link${pending.length === 1 ? '' : 's'} em aberto</small></div>
      <div class="tile"><span class="lab">Total de cobranças</span><b>${rows.length}</b></div></div>
    <div class="toolbar"><div class="tabs">${[['all', 'Todas'], ['pending', 'Pendentes'], ['approved', 'Aprovadas']].map(([k, l]) => `<button class="${payFilter === k ? 'on' : ''}" data-act="payFilter" data-f="${k}">${l}</button>`).join('')}</div></div>
    ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Data</th><th>Contato</th><th>Descrição</th><th>Valor</th><th>Status</th><th></th></tr></thead><tbody>${list.map(p => `<tr>
      <td class="muted">${dateBR(iso(p.created_at))}</td><td>${esc(p.contact_name || 'Contato removido')}</td><td>${esc(p.description)}</td><td><b>${money(p.amount)}</b></td>
      <td><span class="tag pay-${p.status}">${PAY[p.status]}</span></td>
      <td class="right">${p.status === 'pending' && p.checkout_url ? `<div class="acts"><button data-act="copyLink" data-url="${esc(p.checkout_url)}">${ic('copy')}Copiar link</button>
        ${p.contact_id ? `<button data-act="sendLink" data-id="${p.id}">${ic('send')}Enviar no WhatsApp</button>` : ''}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : emptyState('card', 'Nenhuma cobrança por aqui', 'Gere um link de pagamento, envie ao cliente pelo WhatsApp e acompanhe o status em tempo real.',
        `<button class="primary" data-act="newCharge">${ic('plus')}Nova cobrança</button>`)}`;
};
actions.payFilter = ({ f }) => { payFilter = f; views.payments(); };
actions.newCharge = () => newCharge();
async function newCharge(contactId) {
  try {
    const contacts = await api('/contacts');
    if (!contacts.length) return toast('Cadastre um contato antes de criar uma cobrança.', 'error');
    openForm('Nova cobrança', [
      { name: 'contact_id', label: 'Contato', type: 'select', options: contacts.map(c => [c.id, c.name]) },
      { name: 'description', label: 'Descrição', required: true, ph: 'Ex.: Mensalidade de novembro' },
      { name: 'amount', label: 'Valor (R$)', type: 'number', step: '0.01', required: true },
    ], { contact_id: contactId }, async data => {
      await api('/payments', 'POST', data); $('#dlg').close(); closeDrawer(); toast('Link de pagamento gerado.', 'ok'); go('payments');
    });
  } catch (err) { fail(err); }
}
actions.copyLink = async ({ url }) => {
  try { await navigator.clipboard.writeText(url); toast('Link copiado.', 'ok'); } catch { prompt('Copie o link de pagamento:', url); }
};
actions.sendLink = async ({ id }, el) => {
  el.disabled = true;
  try { await api(`/payments/${id}/send`, 'POST'); toast('Link enviado no WhatsApp.', 'ok'); } catch (err) { fail(err); }
  el.disabled = false;
};

/* ====================== Equipe ====================== */
views.team = async () => {
  page('Equipe', '', `<button class="primary" data-act="newUser">${ic('plus')}Novo usuário</button>`, skeleton(4));
  const rows = await api('/users');
  if (current !== 'team') return;
  $('#body').innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th></tr></thead><tbody>${rows.map(u => `<tr>
    <td><div class="who">${avatar(u.name)}<b>${esc(u.name)}</b></div></td><td>${esc(u.email)}</td>
    <td><span class="tag ${u.role === 'admin' ? 'stage-proposta' : 'stage-novo'}">${u.role === 'admin' ? 'Administrador' : 'Atendente'}</span></td></tr>`).join('')}</tbody></table></div>`;
};
actions.newUser = () => openForm('Novo usuário', [
  { name: 'name', label: 'Nome', required: true }, { name: 'email', label: 'E-mail', type: 'email', required: true },
  { name: 'password', label: 'Senha (mínimo 8 caracteres)', type: 'password', required: true },
  { name: 'role', label: 'Perfil', type: 'select', options: [['agent', 'Atendente'], ['admin', 'Administrador']] },
], {}, async data => { await api('/users', 'POST', data); $('#dlg').close(); toast('Usuário criado.', 'ok'); views.team(); });

/* ====================== Rotas, tempo real e login ====================== */
function route() {
  const [v, a] = location.hash.replace(/^#\//, '').split('/');
  let view = views[v] ? v : 'dashboard';
  if (view === 'team' && me.role !== 'admin') view = 'dashboard';
  current = view; closeDrawer();
  $$('#nav a, #tabs a').forEach(l => l.classList.toggle('on', l.dataset.view === view));
  Promise.resolve(views[view](a)).catch(fail);
}
function go(view, arg) {
  const h = `#/${view}${arg ? '/' + arg : ''}`;
  if (location.hash === h) route(); else location.hash = h;
}
window.addEventListener('hashchange', () => { if (token && me) route(); });

function connect() {
  socket = io({ auth: { token } });
  socket.on('message', async m => {
    if (current === 'chats') {
      if (activeConv === m.conversation_id) {
        addMsg(m);
        if (m.direction === 'in') await api(`/conversations/${m.conversation_id}/read`, 'POST').catch(() => {});
      }
      loadConvs().catch(() => {});
    } else if (m.direction === 'in') { toast('Nova mensagem recebida.'); refreshBadge(); }
  });
  socket.on('conversation', () => { if (current === 'chats') loadConvs().catch(() => {}); else refreshBadge(); });
  socket.on('status', s => {
    const el = $(`[data-wa="${CSS.escape(s.waId)}"] .st`);
    if (el) el.textContent = MSG_STATUS[s.status] || '';
  });
  socket.on('payment', () => { toast('Pagamento aprovado!', 'ok'); if (['payments', 'dashboard'].includes(current)) route(); });
}

function start() {
  $('#login').hidden = true; $('#shell').hidden = false;
  const items = me.role === 'admin' ? [...NAV, ['team', 'Equipe', 'shield']] : NAV;
  const link = ([k, l, i]) => `<a href="#/${k}" data-view="${k}">${ic(i)}<span>${l}</span>${k === 'chats' ? '<span class="badge" data-badge></span>' : ''}</a>`;
  $('#nav').innerHTML = items.map(link).join('');
  $('#tabs').innerHTML = items.map(link).join('');
  $('#me').innerHTML = `${avatar(me.name)}<div><b>${esc(me.name)}</b><small>${me.role === 'admin' ? 'Administrador' : 'Atendente'}</small></div>
    <button id="logout" class="icon-btn" aria-label="Sair">${ic('logout')}</button>`;
  $('#logout').onclick = logout;
  connect(); route(); refreshBadge();
}

function logout() { localStorage.clear(); location.hash = ''; location.reload(); }
$('#logout-m').onclick = logout;

$('#loginform').onsubmit = async e => {
  e.preventDefault();
  const btn = $('button', e.target); btn.disabled = true;
  try {
    const r = await api('/auth/login', 'POST', Object.fromEntries(new FormData(e.target)));
    token = r.token; me = r.user;
    localStorage.setItem('token', token); localStorage.setItem('me', JSON.stringify(me));
    start();
  } catch (err) { $('#loginerr').textContent = err.message; }
  finally { btn.disabled = false; }
};

if (token && me) start(); else $('#login').hidden = false;
