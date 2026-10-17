'use strict';
const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('chat_token'), socket;

const clock = v => new Date(v).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function bubble(m) {
  const box = $('#msgs');
  if (box.querySelector(`[data-mid="${m.id}"]`)) return;
  const d = document.createElement('div');
  d.className = 'msg ' + (m.direction === 'in' ? 'out' : ''); // o que o cliente escreve fica à direita
  d.dataset.mid = m.id;
  d.textContent = m.body;
  const t = document.createElement('small');
  t.textContent = clock(m.created_at || Date.now());
  d.appendChild(t);
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

async function open() {
  const r = await fetch('/api/public/chat/messages', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { sessionStorage.removeItem('chat_token'); token = null; return; }
  $('#start').hidden = true; $('#msgs').hidden = false; $('#send').hidden = false;
  (await r.json()).forEach(bubble);
  socket = io({ auth: { token } });
  socket.on('message', bubble);
  $('#send textarea').focus();
}

$('#start').onsubmit = async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try {
    const r = await fetch('/api/public/chat/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    const j = await r.json();
    if (!r.ok) { $('#err').textContent = j.error; return; }
    token = j.token; sessionStorage.setItem('chat_token', token); open();
  } catch { $('#err').textContent = 'Sem conexão. Tente novamente.'; }
  finally { btn.disabled = false; }
};

const ta = $('#send textarea');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#send').requestSubmit(); } });
$('#send').onsubmit = e => {
  e.preventDefault();
  const text = ta.value.trim(); if (!text) return;
  socket.emit('visitor:message', text, ok => {
    if (ok) { ta.value = ''; ta.style.height = 'auto'; } else $('#err').textContent = 'Não foi possível enviar. Tente novamente.';
  });
};

if (token) open();
