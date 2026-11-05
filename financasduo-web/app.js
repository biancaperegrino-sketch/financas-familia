import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import {
  invoiceCompetence, closingDate, dueDate, planInstallments, allocateSplit,
  monthStart, parseMoney, fmtMoney, addMonths, pad,
} from './rules.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const root = document.getElementById('app');

const S = {
  session: null, me: null, members: [], accounts: [], cards: [], categories: [], contexts: [], entries: [],
  view: 'home', month: monthStart(new Date().toISOString().slice(0, 10)), msg: null, err: null, form: {},
};

// ---------- utilidades de interface (sempre textContent: nada de HTML vindo de dados) ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const field = (label, input) => el('div', {}, el('label', { for: input.id }, label), input);
const today = () => new Date().toISOString().slice(0, 10);
const monthLabel = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
function notice() { return [S.err && el('div', { class: 'err', role: 'alert' }, S.err), S.msg && el('div', { class: 'ok' }, S.msg)]; }
function flash(msg, err) { S.msg = err ? null : msg; S.err = err ? msg : null; }
const go = (view) => { S.view = view; S.msg = null; S.err = null; render(); };

// ---------- dados ----------
async function loadAll() {
  const q = (t, extra) => sb.from(t).select(extra || '*');
  const [m, a, c, k, x, e] = await Promise.all([
    q('members').order('display_name'), q('accounts').eq('active', true).order('name'),
    q('cards').eq('active', true).order('name'), q('categories').eq('active', true).order('name'),
    q('contexts').order('name'),
    sb.from('ledger_entries').select('*, splits(*)').is('deleted_at', null).order('purchase_date', { ascending: false }).limit(5000),
  ]);
  for (const r of [m, a, c, k, x, e]) if (r.error) throw r.error;
  Object.assign(S, { members: m.data, accounts: a.data, cards: c.data, categories: k.data, contexts: x.data, entries: e.data });
  S.me = S.members.find((p) => p.user_id === S.session.user.id) || null;
}

// ---------- cálculos de tela (seguem as regras testadas) ----------
function accountBalance(acc) {
  let b = acc.opening_balance_cents || 0;
  for (const e of S.entries) {
    if (acc.opening_date && e.purchase_date < acc.opening_date) continue;
    const amt = e.amount_cents;
    if (e.kind === 'income' || e.kind === 'reimbursement') { if (e.account_id === acc.id) b += amt; }
    else if (e.kind === 'expense') { if (e.account_id === acc.id && !e.card_id) b -= amt; }
    else if (e.kind === 'transfer' || e.kind === 'goal_contribution') {
      if (e.account_id === acc.id) b -= amt;
      if (e.to_account_id === acc.id) b += amt;
    } else if (e.kind === 'invoice_payment') { if (e.account_id === acc.id) b -= amt; }
  }
  return b;
}
function monthSummary() {
  const family = S.contexts.find((c) => c.is_default);
  let income = 0, expense = 0;
  for (const e of S.entries) {
    if (e.competence !== S.month) continue;
    if (e.kind === 'income') income += e.amount_cents;
    if (e.kind === 'expense') {
      if (e.splits && e.splits.length) expense += e.splits.filter((s) => s.member_id === S.me?.id).reduce((t, s) => t + s.share_cents, 0);
      else if (!e.context_id || e.context_id === family?.id) expense += e.amount_cents;
    }
  }
  let receivable = 0;
  for (const e of S.entries) for (const s of e.splits || []) {
    const m = S.members.find((p) => p.id === s.member_id);
    if (m && m.role === 'external') receivable += s.share_cents - s.settled_cents;
  }
  return { income, expense, receivable };
}
const catName = (id) => S.categories.find((c) => c.id === id)?.name || 'Sem categoria';

// ---------- ações ----------
async function ensureInvoice(card, competence) {
  const found = await sb.from('invoices').select('id').eq('card_id', card.id).eq('competence', competence).maybeSingle();
  if (found.error) throw found.error;
  if (found.data) return found.data.id;
  const ins = await sb.from('invoices').insert({
    card_id: card.id, competence, closing_date: closingDate(competence, card.closing_day),
    due_date: dueDate(competence, card.closing_day, card.due_day),
  }).select('id').single();
  if (ins.error) throw ins.error;
  return ins.data.id;
}

async function saveEntry(f) {
  const amount = parseMoney(f.valor);
  if (!amount) throw new Error('Informe um valor maior que zero, por exemplo 187,40.');
  if (!f.data) throw new Error('Informe a data.');
  const [pk, pid] = f.pagamento.split(':');
  const household_id = S.me.household_id;
  const base = {
    household_id, kind: f.tipo, description: f.descricao || null, merchant: f.descricao || null,
    category_id: f.categoria || null, context_id: f.contexto || null, purchase_date: f.data,
    status: 'realized', created_by: S.session.user.id, updated_by: S.session.user.id,
  };
  let rows;
  if (f.tipo === 'expense' && pk === 'card') {
    const card = S.cards.find((c) => c.id === pid);
    const n = Math.max(1, parseInt(f.parcelas || '1', 10));
    const plan = planInstallments(amount, n, f.data, card.closing_day);
    const planId = n > 1 ? crypto.randomUUID() : null;
    rows = [];
    for (const p of plan) {
      rows.push({
        ...base, amount_cents: p.amount, competence: p.competence, card_id: card.id,
        invoice_id: await ensureInvoice(card, p.competence),
        installment_plan_id: planId, installment_no: n > 1 ? p.no : null, installment_total: n > 1 ? n : null,
        paid_by_member_id: S.me.id,
      });
    }
  } else {
    rows = [{ ...base, amount_cents: amount, competence: monthStart(f.data), account_id: pid, paid_by_member_id: S.me.id }];
  }
  const ins = await sb.from('ledger_entries').insert(rows).select('id, amount_cents');
  if (ins.error) throw ins.error;
  const pais = S.contexts.find((c) => c.id === f.contexto && c.name === 'Apartamento dos pais');
  if (f.tipo === 'expense' && pais) {
    const sister = S.members.find((m) => m.role === 'external');
    const splits = [];
    for (const r of ins.data) {
      for (const s of allocateSplit(r.amount_cents, [{ memberId: S.me.id, percentBp: 5000 }, { memberId: sister.id, percentBp: 5000 }])) {
        splits.push({ entry_id: r.id, member_id: s.memberId, percent_bp: s.percentBp, share_cents: s.cents });
      }
    }
    const sp = await sb.from('splits').insert(splits);
    if (sp.error) throw sp.error;
  }
}

async function registerReimbursement(valor, accountId, data) {
  let left = parseMoney(valor);
  if (!left) throw new Error('Informe o valor recebido, por exemplo 400,00.');
  const total = left;
  const ins = await sb.from('ledger_entries').insert({
    household_id: S.me.household_id, kind: 'reimbursement', amount_cents: total, purchase_date: data,
    competence: monthStart(data), description: 'Reembolso (Pix da irmã)', account_id: accountId, status: 'realized',
    created_by: S.session.user.id, updated_by: S.session.user.id,
  });
  if (ins.error) throw ins.error;
  // quita os valores a receber, do mais antigo para o mais novo
  const open = [];
  for (const e of [...S.entries].reverse()) for (const s of e.splits || []) {
    const m = S.members.find((p) => p.id === s.member_id);
    if (m && m.role === 'external' && s.share_cents > s.settled_cents) open.push(s);
  }
  for (const s of open) {
    if (left <= 0) break;
    const pay = Math.min(left, s.share_cents - s.settled_cents);
    const up = await sb.from('splits').update({ settled_cents: s.settled_cents + pay }).eq('id', s.id);
    if (up.error) throw up.error;
    left -= pay;
  }
  if (left > 0) return 'Reembolso registrado. Sobraram ' + fmtMoney(left) + ' sem lançamento correspondente a receber.';
  return 'Reembolso registrado.';
}

// ---------- telas ----------
function loginView() {
  const email = el('input', { id: 'email', type: 'email', autocomplete: 'username', required: true });
  const pass = el('input', { id: 'senha', type: 'password', autocomplete: 'current-password', minlength: 8, required: true });
  const submit = async (signup) => {
    S.err = S.msg = null;
    const r = signup
      ? await sb.auth.signUp({ email: email.value.trim(), password: pass.value })
      : await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (r.error) { flash(r.error.message, true); return render(); }
    if (signup && !r.data.session) { flash('Conta criada. Confirme pelo e-mail que enviamos e depois entre.'); return render(); }
  };
  return el('div', {},
    el('h1', {}, 'FinançasDuo'), ...notice(),
    el('form', { class: 'card', onsubmit: (ev) => { ev.preventDefault(); submit(false); } },
      field('E-mail', email), field('Senha (mínimo 8 caracteres)', pass),
      el('button', { class: 'full', type: 'submit' }, 'Entrar'),
      el('button', { class: 'full sec', type: 'button', onclick: () => submit(true) }, 'Criar conta')),
    el('p', { class: 'mute' }, 'Seu marido cria a conta com o e-mail que você cadastrar para ele em Cadastros.'));
}

function onboardingView() {
  const fam = el('input', { id: 'fam', value: 'Nossa família' });
  const nome = el('input', { id: 'nome', placeholder: 'Seu nome' });
  return el('div', {}, el('h1', {}, 'Primeiros passos'), ...notice(),
    el('form', { class: 'card', onsubmit: async (ev) => {
      ev.preventDefault();
      const r = await sb.rpc('bootstrap_household', { p_name: fam.value.trim(), p_my_name: nome.value.trim() });
      if (r.error) { flash(r.error.message, true); return render(); }
      await loadAll(); flash('Família criada. Agora cadastre suas contas.'); go('cadastros');
    } },
      el('p', { class: 'mute' }, 'Vamos criar a base da família com categorias, o contexto "Apartamento dos pais" e sua irmã para o rateio.'),
      field('Nome da família', fam), field('Seu nome', nome),
      el('button', { class: 'full', type: 'submit' }, 'Criar')));
}

function homeView() {
  const { income, expense, receivable } = monthSummary();
  const bankAccs = S.accounts.filter((a) => a.kind === 'checking' || a.kind === 'wallet');
  const reserves = S.accounts.filter((a) => a.kind === 'savings' || a.kind === 'reserve');
  const bank = bankAccs.reduce((t, a) => t + accountBalance(a), 0);
  const reserve = reserves.reduce((t, a) => t + accountBalance(a), 0);
  const cardTotals = S.cards.map((c) => ({
    c, total: S.entries.filter((e) => e.card_id === c.id && e.kind === 'expense' && e.competence === S.month).reduce((t, e) => t + e.amount_cents, 0),
  }));
  const committed = cardTotals.reduce((t, x) => t + x.total, 0);
  const future = S.entries.filter((e) => e.card_id && e.kind === 'expense' && e.competence > S.month).reduce((t, e) => t + e.amount_cents, 0);
  const [y, m] = S.month.split('-').map(Number);
  const shift = (k) => { const t = addMonths(y, m, k); S.month = `${t.y}-${pad(t.m)}-01`; render(); };
  const list = S.entries.filter((e) => e.competence === S.month || (e.purchase_date >= S.month && e.purchase_date.slice(0, 7) === S.month.slice(0, 7))).slice(0, 40);
  const kindLabel = { expense: '–', income: '+', reimbursement: '+', transfer: '↔', invoice_payment: '–', goal_contribution: '→' };

  return el('div', {},
    el('div', { class: 'top' },
      el('button', { class: 'link', 'aria-label': 'Mês anterior', onclick: () => shift(-1) }, '‹'),
      el('h1', { class: 'cap', style: 'margin:0' }, monthLabel(S.month)),
      el('button', { class: 'link', 'aria-label': 'Próximo mês', onclick: () => shift(1) }, '›')),
    ...notice(),
    el('div', { class: 'nav' },
      el('button', { class: 'sec', onclick: () => go('cadastros') }, 'Cadastros'),
      el('button', { class: 'sec', onclick: () => go('reembolso') }, 'Pix da irmã'),
      el('button', { class: 'link', onclick: () => sb.auth.signOut() }, 'Sair')),
    el('div', { class: 'hero' },
      el('small', {}, 'Saldo bancário (contas e carteiras)'), el('div', { class: 'big' }, fmtMoney(bank)),
      el('div', { class: 'row' }, el('small', {}, 'Faturas de cartão deste mês'), el('span', {}, fmtMoney(committed))),
      el('div', { class: 'row' }, el('small', {}, 'Parcelas e faturas futuras'), el('span', {}, fmtMoney(future))),
      el('div', { class: 'row' }, el('small', {}, 'A receber da sua irmã'), el('span', {}, fmtMoney(receivable))),
      el('div', { class: 'row' }, el('small', {}, 'Reservas (fora do cálculo)'), el('span', {}, fmtMoney(reserve)))),
    el('div', { class: 'grid2' },
      el('div', { class: 'card' }, el('div', { class: 'mute' }, 'Receita'), el('b', {}, fmtMoney(income))),
      el('div', { class: 'card' }, el('div', { class: 'mute' }, 'Despesa da família'), el('b', {}, fmtMoney(expense)))),
    cardTotals.length ? el('div', { class: 'card' }, el('h2', {}, 'Faturas do mês'),
      ...cardTotals.map(({ c, total }) => {
        const pct = c.limit_cents ? Math.min(100, Math.round((total / c.limit_cents) * 100)) : 0;
        return el('div', {}, el('div', { class: 'row' }, el('span', {}, c.name), el('b', {}, fmtMoney(total))),
          c.limit_cents ? el('div', { class: 'bar' }, el('div', { style: `width:${pct}%` })) : null);
      })) : null,
    el('div', { class: 'card' }, el('h2', {}, 'Lançamentos do mês'),
      list.length ? list.map((e) => {
        const where = e.card_id ? S.cards.find((c) => c.id === e.card_id)?.name : S.accounts.find((a) => a.id === e.account_id)?.name;
        const parc = e.installment_total ? ` ${e.installment_no}/${e.installment_total}` : '';
        const ctx = S.contexts.find((c) => c.id === e.context_id);
        return el('div', { class: 'item' },
          el('div', {}, el('div', {}, (e.description || catName(e.category_id)) + parc),
            el('div', { class: 'mute' }, [e.purchase_date.split('-').reverse().join('/'), where, catName(e.category_id), ctx && ctx.name !== 'Família' ? ctx.name : null].filter(Boolean).join(' · '))),
          el('div', { style: 'text-align:right' },
            el('div', { class: e.kind === 'income' || e.kind === 'reimbursement' ? 'pos' : '' }, kindLabel[e.kind] + ' ' + fmtMoney(e.amount_cents)),
            el('button', { class: 'link', 'aria-label': 'Excluir lançamento', onclick: async () => {
              if (!confirm('Excluir este lançamento? Ele continua no histórico de auditoria.')) return;
              const r = await sb.from('ledger_entries').update({ deleted_at: new Date().toISOString(), updated_by: S.session.user.id }).eq('id', e.id);
              if (r.error) flash(r.error.message, true); else { await loadAll(); flash('Lançamento excluído.'); }
              render();
            } }, 'excluir')));
      }) : el('p', { class: 'mute' }, 'Nada lançado neste mês.')),
    el('button', { class: 'fab', 'aria-label': 'Nova despesa', onclick: () => go('nova') }, '+'));
}

function novaView() {
  if (!S.accounts.length) { flash('Cadastre ao menos uma conta antes de lançar.', true); S.view = 'cadastros'; return cadastrosView(); }
  const f = S.form;
  const tipo = el('select', { id: 'tipo' }, el('option', { value: 'expense' }, 'Despesa'), el('option', { value: 'income' }, 'Receita'));
  const valor = el('input', { id: 'valor', inputmode: 'decimal', placeholder: '0,00', autofocus: true });
  const desc = el('input', { id: 'desc', placeholder: 'Ex.: Supermercado Bom Preço' });
  const cat = el('select', { id: 'cat' }, el('option', { value: '' }, 'Classificar depois'), S.categories.map((c) => el('option', { value: c.id }, c.name)));
  const pag = el('select', { id: 'pag' },
    S.cards.map((c) => el('option', { value: 'card:' + c.id }, 'Cartão: ' + c.name)),
    S.accounts.filter((a) => a.kind === 'checking' || a.kind === 'wallet').map((a) => el('option', { value: 'acc:' + a.id }, a.name)));
  const data = el('input', { id: 'data', type: 'date', value: today() });
  const parc = el('input', { id: 'parc', type: 'number', min: 1, max: 48, value: 1, inputmode: 'numeric' });
  const ctx = el('select', { id: 'ctx' }, S.contexts.map((c) => el('option', { value: c.id, selected: c.is_default }, c.name)));
  const hint = el('div', { class: 'mute' });
  const parcBox = el('div', {}, field('Parcelas', parc));
  const refresh = () => {
    const isCard = pag.value.startsWith('card:') && tipo.value === 'expense';
    parcBox.style.display = isCard ? '' : 'none';
    const pais = S.contexts.find((c) => c.id === ctx.value)?.name === 'Apartamento dos pais' && tipo.value === 'expense';
    const c = S.cards.find((x) => 'card:' + x.id === pag.value);
    let t = '';
    if (isCard && c && parseInt(parc.value || '1', 10) >= 1) {
      const comp = invoiceCompetence(data.value || today(), c.closing_day);
      t += `Entra na fatura de ${monthLabel(comp)} (vence em ${dueDate(comp, c.closing_day, c.due_day).split('-').reverse().join('/')}). `;
    }
    if (pais) t += 'Rateio 50% você / 50% sua irmã. A parte dela fica como valor a receber.';
    hint.textContent = t;
  };
  [tipo, pag, data, parc, ctx].forEach((n) => n.addEventListener('change', refresh));
  refresh();
  return el('div', {},
    el('div', { class: 'top' }, el('h1', { style: 'margin:0' }, 'Novo lançamento'), el('button', { class: 'link', onclick: () => go('home') }, 'Fechar')),
    ...notice(),
    el('form', { class: 'card', onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        await saveEntry({ tipo: tipo.value, valor: valor.value, descricao: desc.value.trim(), categoria: cat.value, pagamento: pag.value, data: data.value, parcelas: parc.value, contexto: ctx.value });
        await loadAll();
        S.month = monthStart(data.value); flash('Lançamento salvo.'); go('home');
      } catch (e) { flash(e.message || String(e), true); render(); }
    } },
      field('Tipo', tipo), field('Valor (R$)', valor), field('Estabelecimento ou descrição', desc), field('Categoria', cat),
      field('Pago com / recebido em', pag), field('Data', data), parcBox, field('Contexto', ctx), hint,
      el('button', { class: 'full', type: 'submit' }, 'Salvar')));
}

function cadastrosView() {
  const accName = el('input', { id: 'an', placeholder: 'Ex.: Conta Banco do Brasil' });
  const accKind = el('select', { id: 'ak' }, el('option', { value: 'checking' }, 'Conta corrente'), el('option', { value: 'wallet' }, 'Carteira / Mercado Pago'),
    el('option', { value: 'savings' }, 'Poupança / investimento'), el('option', { value: 'reserve' }, 'Reserva de emergência'));
  const accInst = el('input', { id: 'ai', placeholder: 'Banco do Brasil' });
  const accBal = el('input', { id: 'ab', inputmode: 'decimal', placeholder: '0,00' });
  const accDate = el('input', { id: 'ad', type: 'date', value: today() });
  const cName = el('input', { id: 'cn', placeholder: 'Ex.: Mercado Pago' });
  const cInst = el('input', { id: 'ci' });
  const cLim = el('input', { id: 'cl', inputmode: 'decimal', placeholder: '0,00' });
  const cClose = el('input', { id: 'cc', type: 'number', min: 1, max: 31, placeholder: 'Dia do fechamento' });
  const cDue = el('input', { id: 'cd', type: 'number', min: 1, max: 31, placeholder: 'Dia do vencimento' });
  const cPay = el('select', { id: 'cp' }, el('option', { value: '' }, 'Conta que paga a fatura'), S.accounts.map((a) => el('option', { value: a.id }, a.name)));
  const iName = el('input', { id: 'in', placeholder: 'Nome do seu marido' });
  const iMail = el('input', { id: 'im', type: 'email', placeholder: 'E-mail dele' });
  const guard = (fn) => async (ev) => {
    ev.preventDefault();
    try { await fn(); await loadAll(); } catch (e) { flash(e.message || String(e), true); }
    render();
  };
  return el('div', {},
    el('div', { class: 'top' }, el('h1', { style: 'margin:0' }, 'Cadastros'), el('button', { class: 'link', onclick: () => go('home') }, 'Voltar')),
    ...notice(),
    el('div', { class: 'card' }, el('h2', {}, 'Contas e carteiras'),
      S.accounts.map((a) => el('div', { class: 'row' }, el('span', {}, a.name), el('b', {}, fmtMoney(accountBalance(a))))),
      el('form', { onsubmit: guard(async () => {
        if (!accName.value.trim()) throw new Error('Informe o nome da conta.');
        const bal = accBal.value.trim() ? parseMoney(accBal.value) : 0;
        if (bal === null) throw new Error('Saldo inicial inválido.');
        const r = await sb.from('accounts').insert({ household_id: S.me.household_id, owner_member_id: S.me.id, name: accName.value.trim(), institution: accInst.value.trim() || null, kind: accKind.value, opening_balance_cents: bal, opening_date: accDate.value });
        if (r.error) throw r.error; flash('Conta cadastrada.');
      }) }, field('Nome', accName), field('Tipo', accKind), field('Instituição', accInst), field('Saldo na data de início (R$)', accBal), field('Data do saldo', accDate),
        el('p', { class: 'mute' }, 'O saldo inicial não conta como receita.'), el('button', { class: 'full', type: 'submit' }, 'Adicionar conta'))),
    el('div', { class: 'card' }, el('h2', {}, 'Cartões de crédito'),
      S.cards.map((c) => el('div', { class: 'row' }, el('span', {}, c.name), el('span', { class: 'mute' }, `fecha dia ${c.closing_day} · vence dia ${c.due_day}`))),
      el('form', { onsubmit: guard(async () => {
        if (!cName.value.trim()) throw new Error('Informe o nome do cartão.');
        const closing = parseInt(cClose.value, 10), due = parseInt(cDue.value, 10);
        if (!(closing >= 1 && closing <= 31 && due >= 1 && due <= 31)) throw new Error('Informe dias de fechamento e vencimento entre 1 e 31.');
        const lim = cLim.value.trim() ? parseMoney(cLim.value) : null;
        const r = await sb.from('cards').insert({ household_id: S.me.household_id, holder_member_id: S.me.id, name: cName.value.trim(), institution: cInst.value.trim() || null, limit_cents: lim, closing_day: closing, due_day: due, pay_account_id: cPay.value || null });
        if (r.error) throw r.error; flash('Cartão cadastrado.');
      }) }, field('Nome', cName), field('Instituição', cInst), field('Limite (R$)', cLim), field('Fechamento', cClose), field('Vencimento', cDue), field('Conta de pagamento', cPay),
        el('button', { class: 'full', type: 'submit' }, 'Adicionar cartão'))),
    el('div', { class: 'card' }, el('h2', {}, 'Pessoas'),
      S.members.map((m) => el('div', { class: 'row' }, el('span', {}, m.display_name), el('span', { class: 'mute' }, m.role === 'external' ? 'sem login (rateio)' : m.user_id ? 'com acesso' : 'convidado(a)'))),
      el('form', { onsubmit: guard(async () => {
        if (!iName.value.trim() || !iMail.value.trim()) throw new Error('Informe nome e e-mail.');
        const r = await sb.rpc('invite_member', { p_name: iName.value.trim(), p_email: iMail.value.trim() });
        if (r.error) throw r.error; flash('Convite registrado. Ele deve criar a conta com esse mesmo e-mail.');
      }) }, field('Nome', iName), field('E-mail', iMail), el('button', { class: 'full', type: 'submit' }, 'Convidar'))));
}

function reembolsoView() {
  const valor = el('input', { id: 'rv', inputmode: 'decimal', placeholder: '0,00' });
  const acc = el('select', { id: 'ra' }, S.accounts.filter((a) => a.kind === 'checking' || a.kind === 'wallet').map((a) => el('option', { value: a.id }, a.name)));
  const data = el('input', { id: 'rd', type: 'date', value: today() });
  const { receivable } = monthSummary();
  return el('div', {},
    el('div', { class: 'top' }, el('h1', { style: 'margin:0' }, 'Pix da irmã'), el('button', { class: 'link', onclick: () => go('home') }, 'Voltar')),
    ...notice(),
    el('form', { class: 'card', onsubmit: async (ev) => {
      ev.preventDefault();
      try { const m = await registerReimbursement(valor.value, acc.value, data.value); await loadAll(); flash(m); go('home'); }
      catch (e) { flash(e.message || String(e), true); render(); }
    } },
      el('p', {}, 'A receber hoje: ', el('b', {}, fmtMoney(receivable))),
      el('p', { class: 'mute' }, 'O reembolso quita o valor a receber e não conta como receita.'),
      field('Valor recebido (R$)', valor), field('Recebido em', acc), field('Data', data),
      el('button', { class: 'full', type: 'submit' }, 'Registrar')));
}

// ---------- ciclo principal ----------
function render() {
  let v;
  try {
    if (!S.session) v = loginView();
    else if (!S.me) v = onboardingView();
    else v = { home: homeView, nova: novaView, cadastros: cadastrosView, reembolso: reembolsoView }[S.view]();
  } catch (e) { v = el('div', { class: 'err' }, 'Erro ao montar a tela: ' + (e.message || e)); }
  root.replaceChildren(v);
}

async function boot(session) {
  S.session = session;
  if (!session) { S.me = null; return render(); }
  try {
    await sb.rpc('claim_member');
    await loadAll();
  } catch (e) { S.err = 'Não foi possível carregar os dados: ' + (e.message || e); }
  render();
}

sb.auth.onAuthStateChange((_ev, session) => { setTimeout(() => boot(session), 0); });
sb.auth.getSession().then(({ data }) => boot(data.session));
