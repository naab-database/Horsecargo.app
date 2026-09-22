import { t } from '../i18n.js';
import { rpc, can, state } from '../api.js';
import { icon, esc, usd, num, $ } from '../ui.js';
import { companySelect, getCompany, setCompany, companyName } from '../acc.js';

export async function render({ el, setTitle, rerender }) {
  setTitle(t('acc'));
  if (!can('acc.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  const co = getCompany();
  const d = await rpc('acc_dashboard', { p_company: co || null });
  const gp = d.revenue_month - d.cos_month;
  const np = gp - d.expense_month;
  const fx = (cur) => cur === 'AED' ? state.settings.fx_aed : cur === 'TZS' ? state.settings.fx_tzs : 1;
  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>${esc(t('acc'))}</h1><p>${esc(companyName(co))} · ${esc(t('acc_book_ccy'))}</p></div>
    <div class="row">${companySelect()}
      ${can('acc.write') ? `<a class="btn" href="#/acc/expenses?new=1">${icon('plus')}${esc(t('acc_new_expense'))}</a>
      <a class="btn primary" href="#/acc/bills/new">${icon('plus')}${esc(t('acc_new_bill'))}</a>` : ''}</div>
  </div>
  <div class="stack">
    <div class="grid c4">
      <div class="card kpi"><div class="k">${esc(t('acc_cash_bank'))}</div><div class="v">${usd(d.cash)}</div></div>
      <div class="card kpi"><div class="k">${esc(t('acc_receivable'))}</div><div class="v">${usd(d.ar)}</div><div class="s">${esc(t('acc_deposits_held'))}: ${usd(d.deposits)}</div></div>
      <div class="card kpi"><div class="k">${esc(t('acc_payable'))}</div><div class="v">${usd(d.ap)}</div><div class="s">${d.open_bills} ${esc(t('acc_open_bills'))}</div></div>
      <div class="card kpi"><div class="k">${esc(t('acc_duty_held'))}</div><div class="v">${usd(d.duty)}</div><div class="s">${esc(t('acc_duty_hint'))}</div></div>
    </div>
    <div class="card">
      <div class="card-h"><h2>${esc(t('acc_this_month'))}</h2><a class="small" href="#/acc/reports">${esc(t('acc_reports'))} →</a></div>
      <div class="money">
        <div><div class="k">${esc(t('acc_revenue'))}</div><div class="v">${usd(d.revenue_month)}</div></div>
        <div><div class="k">${esc(t('acc_cos'))}</div><div class="v">${usd(d.cos_month)}</div></div>
        <div><div class="k">${esc(t('acc_gross_profit'))}</div><div class="v ${gp < 0 ? 'due' : 'ok'}">${usd(gp)}</div></div>
        <div><div class="k">${esc(t('acc_net_profit'))}</div><div class="v ${np < 0 ? 'due' : 'ok'}">${usd(np)}</div></div>
      </div>
    </div>
    <div class="split">
      <div class="card">
        <div class="card-h"><h2>${esc(t('acc_money'))}</h2><a class="small" href="#/acc/money">${esc(t('view'))} →</a></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('acc_account'))}</th><th class="hide-m">${esc(t('branch'))}</th><th class="num">USD</th><th class="num hide-m">≈ ${esc(t('acc_native'))}</th></tr></thead>
        <tbody>${d.money.map((m) => `<tr><td><b>${esc(m.name)}</b><div class="muted small">${esc(m.company)} · ${esc(t('mk_' + m.kind))}</div></td><td class="hide-m">${esc(m.branch || '—')}</td>
          <td class="num" style="${m.balance_usd < 0 ? 'color:var(--red)' : ''}">${usd(m.balance_usd)}</td>
          <td class="num hide-m muted">${m.currency === 'USD' ? '' : `${esc(m.currency)} ${num(m.balance_usd * fx(m.currency), 0)}`}</td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="stack">
        ${d.draft_journals ? `<a class="callout warn" href="#/acc/journals?status=draft">${icon('clock')}<div><b>${d.draft_journals}</b> ${esc(t('acc_drafts_waiting'))}</div></a>` : ''}
        ${!co && Math.abs(d.ic_net) > 0.01 ? `<div class="callout danger">${icon('alert')}<div>${esc(t('acc_ic_mismatch'))}: ${usd(d.ic_net)}</div></div>` : ''}
        <div class="card"><div class="card-h"><h2>${esc(t('quick_actions'))}</h2></div><div class="card-b stack" style="gap:8px">
          <a class="btn" style="justify-content:flex-start" href="#/acc/reports?tab=ships">${icon('box')}${esc(t('acc_shipment_pnl'))}</a>
          <a class="btn" style="justify-content:flex-start" href="#/acc/reports?tab=pl">${icon('chart')}${esc(t('acc_pl'))}</a>
          <a class="btn" style="justify-content:flex-start" href="#/acc/reports?tab=bs">${icon('scale')}${esc(t('acc_bs'))}</a>
          <a class="btn" style="justify-content:flex-start" href="#/acc/bills">${icon('list')}${esc(t('acc_bills'))} · ${usd(d.open_bills_usd)}</a>
          ${can('acc.write') ? `<a class="btn" style="justify-content:flex-start" href="#/acc/journals?new=1">${icon('plus')}${esc(t('acc_new_journal'))}</a>` : ''}
        </div></div>
      </div>
    </div>
  </div>`;
  $('#company', el).onchange = (e) => { setCompany(e.target.value); rerender(); };
}
