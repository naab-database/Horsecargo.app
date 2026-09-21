import { t } from '../i18n.js';
import { rpc, can, errText, state } from '../api.js';
import { icon, esc, usd, num, modal, toast, busy, $ } from '../ui.js';
import { companySelect, getCompany, setCompany, loadMoneyAccounts, loadAccounts, fxDefault } from '../acc.js';

export async function render({ el, setTitle, rerender }) {
  setTitle(t('acc_money'));
  if (!can('acc.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  const co = getCompany();
  const d = await rpc('acc_dashboard', { p_company: co || null });
  const [accs, coa] = await Promise.all([loadMoneyAccounts(true), loadAccounts(true)]);
  const codeOf = Object.fromEntries(coa.map((a) => [a.id, a.code]));
  const byId = Object.fromEntries(accs.map((a) => [a.id, a]));
  const kinds = ['cash', 'mobile_money', 'bank'];
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('acc_money'))}</h1><p>${esc(t('acc_money_sub'))}</p></div>
    <div class="row">${companySelect()}
      ${can('acc.write') ? `<a class="btn" href="#/acc/journals?new=1">${icon('truck')}${esc(t('acc_transfer'))}</a>` : ''}
      ${can('acc.approve') ? `<button class="btn primary" id="new">${icon('plus')}${esc(t('acc_new_money'))}</button>` : ''}</div></div>
  <div class="stack">
    <div class="grid c4">${kinds.map((k) => `<div class="card kpi"><div class="k">${esc(t('mk_' + k))}</div><div class="v">${usd(d.money.filter((m) => m.kind === k).reduce((a, m) => a + Number(m.balance_usd), 0))}</div></div>`).join('')}
      <div class="card kpi"><div class="k">${esc(t('total'))}</div><div class="v">${usd(d.cash)}</div></div></div>
    <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('acc_account'))}</th><th class="hide-m">${esc(t('branch'))}</th><th>${esc(t('currency'))}</th><th class="num">≈ ${esc(t('acc_native'))}</th><th class="num">USD</th></tr></thead>
      <tbody>${d.money.map((m) => { const a = byId[m.id] || {}; return `<tr class="click" data-code="${esc(codeOf[a.account_id] || '')}">
        <td><b>${esc(m.name)}</b><div class="muted small">${esc(m.company)} · ${esc(t('mk_' + m.kind))}${a.bank_name ? ' · ' + esc(a.bank_name) : ''}${a.account_number ? ' · ' + esc(a.account_number) : ''}</div></td>
        <td class="hide-m">${esc(m.branch || '—')}</td><td>${esc(m.currency)}</td>
        <td class="num muted">${m.currency === 'USD' ? '' : num(m.balance_usd * fxDefault(m.currency), 0)}</td>
        <td class="num" style="${m.balance_usd < 0 ? 'color:var(--red);font-weight:700' : ''}">${usd(m.balance_usd)}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="card-b muted small">${esc(t('acc_money_hint'))}</div></div>
  </div>`;
  $('#company', el).onchange = (e) => { setCompany(e.target.value); rerender(); };
  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-code]'); if (tr && tr.dataset.code) location.hash = `#/acc/account/${tr.dataset.code}`; });
  if ($('#new', el)) $('#new', el).onclick = () => modal({
    title: t('acc_new_money'),
    body: `<form class="form" id="mf" novalidate>
      <div class="field"><label class="req">${esc(t('branch'))}</label><select class="input" name="branch">${state.branches.map((b) => `<option value="${b.code}">${esc(b.code)} · ${esc(b.name)} (${esc(b.company_code || '')})</option>`).join('')}</select></div>
      <div class="field"><label class="req">${esc(t('acc_kind'))}</label><select class="input" name="kind">${kinds.map((k) => `<option value="${k}">${esc(t('mk_' + k))}</option>`).join('')}</select></div>
      <div class="field full"><label class="req">${esc(t('name'))}</label><input class="input" name="name" required placeholder="Bank — CRDB TZS"></div>
      <div class="field"><label class="req">${esc(t('currency'))}</label><select class="input" name="currency"><option>USD</option><option>AED</option><option>TZS</option></select></div>
      <div class="field"><label>${esc(t('acc_bank_name'))}</label><input class="input" name="bank_name"></div>
      <div class="field full"><label>${esc(t('acc_account_number'))}</label><input class="input" name="account_number"></div>
    </form>`,
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="ms">${icon('check')}${esc(t('save'))}</button>`,
    onMount: (m) => {
      m.el.querySelector('#ms').onclick = (ev) => busy(ev.currentTarget, async () => {
        const f = m.el.querySelector('#mf');
        if (!f.name.value.trim()) { toast(t('required_fields'), 'err'); return; }
        try {
          await rpc('acc_create_money_account', { p: { branch_code: f.branch.value, kind: f.kind.value, name: f.name.value.trim(), currency: f.currency.value, bank_name: f.bank_name.value, account_number: f.account_number.value } });
          await loadMoneyAccounts(true); m.close(); toast(t('saved')); rerender();
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}
