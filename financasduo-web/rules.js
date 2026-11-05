// Mesmas regras de src/domain/rules.ts (testadas), em JavaScript para rodar no navegador sem build.
export const pad = (n) => String(n).padStart(2, '0');
export const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addMonths(y, m, k) {
  const idx = y * 12 + (m - 1) + k;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

export function invoiceCompetence(purchase, closingDay) {
  const [y, m, d] = purchase.split('-').map(Number);
  const closing = Math.min(closingDay, lastDay(y, m));
  const t = addMonths(y, m, d >= closing ? 1 : 0);
  return `${t.y}-${pad(t.m)}-01`;
}

export function closingDate(competence, closingDay) {
  const [y, m] = competence.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(Math.min(closingDay, lastDay(y, m)))}`;
}

export function dueDate(competence, closingDay, dueDay) {
  const [y, m] = competence.split('-').map(Number);
  const t = addMonths(y, m, dueDay > closingDay ? 0 : 1);
  return `${t.y}-${pad(t.m)}-${pad(Math.min(dueDay, lastDay(t.y, t.m)))}`;
}

export function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

export function planInstallments(amount, n, purchase, closingDay) {
  const [fy, fm] = invoiceCompetence(purchase, closingDay).split('-').map(Number);
  return splitEvenly(amount, n).map((a, i) => {
    const t = addMonths(fy, fm, i);
    return { no: i + 1, total: n, amount: a, competence: `${t.y}-${pad(t.m)}-01` };
  });
}

export function allocateSplit(total, parts) {
  const sumBp = parts.reduce((s, p) => s + p.percentBp, 0);
  if (sumBp !== 10000) throw new Error('O rateio deve somar 100%');
  const shares = parts.map((p) => ({ memberId: p.memberId, percentBp: p.percentBp, cents: Math.floor((total * p.percentBp) / 10000) }));
  shares[0].cents += total - shares.reduce((s, x) => s + x.cents, 0);
  return shares;
}

export const monthStart = (iso) => iso.slice(0, 7) + '-01';

export function parseMoney(s) {
  const n = Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export const fmtMoney = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
