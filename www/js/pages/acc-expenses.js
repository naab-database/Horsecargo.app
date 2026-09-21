import { t } from '../i18n.js';
import { from, run, rpc, can, errText, state } from '../api.js';
import { icon, esc, usd, money, fdate, modal, toast, confirmDialog, busy, empty, $, toCSV, downloadCSV } from '../ui.js';
import { companySelect, getCompany, setCompany, loadMoneyAccounts, moneyOptions, costAccountOptions, fxDefault, shipmentOptions } from '../acc.js';

export async function render({ el, setTitle, query, rerender }) {
  setTitle(t('acc_expenses'));
  if (!can('acc.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('acc_expenses'))}</h1><p>${esc(t('acc_expenses_sub'))}</p></div>
    <div class="row">${companySelect()}<button class="btn hide-m" id="csv">${icon('download')}${esc(t('export_csv'))}</button>
    ${can('acc.write') ? `<button class="btn primary" id="new">${icon('plus')}${esc(t('acc_new_expense'))}</button>` : ''}</div></div>
  <div class="card"><div id="list"></div></div>`;
  let rows = [];
  const load = async () => {
    let q = from('v_expenses').select('*').order('expense_date', { ascending: false }).order('created_at', { ascending: false }).limit(500);
    const co = getCompany(); if (co) q = q.eq('company_code', co);
    rows = await run(q);
    $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>${esc(t('reference'))}</th><th>${esc(t('description'))}</th><th class="hide-m">${esc(t('acc_account'))}</th><th class="hide-m">${esc(t('acc_paid_from'))}</th>
      <th class="num">${esc(t('amount'))}</th><th class="num">USD</th><th></th></tr></thead>
      <tbody>${rows.map((x) => `<tr style="${x.void ? 'opacity:.5;text-decoration:line-through' : ''}">
        <td><b class="mono">${esc(x.ref)}</b><div class="muted small">${fdate(x.expense_date)} · ${esc(x.company_code)}${x.branch_code ? ' · ' + esc(x.branch_code) : ''}</div></td>
        <td>${esc(x.description)}<div class="muted small">${[x.supplier_name, x.container_no || x.shipment_ref, x.booking_ref, x.reference].filter(Boolean).map(esc).join(' · ')}</div></td>
        <td class="hide-m"><span class="mono small">${esc(x.account_code)}</span> ${esc(x.account_name || '')}</td>
        <td class="hide-m">${esc(x.money_account_name)}</td>
        <td class="num nowrap">${money(x.amount_txn, x.currency)}</td><td class="num">${usd(x.amount_usd, { bare: true })}</td>
        <td class="right">${!x.void && can('acc.approve') ? `<button class="icon-btn" data-void="${x.id}" title="${esc(t('void'))}">${icon('trash')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : empty(t('nothing_here'), 'money');
  };
  $('#company', el).onchange = (e) => { setCompany(e.target.value); load(); };
  $('#csv', el).onclick = () => downloadCSV('horse-cargo-expenses.csv', toCSV(rows, [
    { label: 'Ref', key: 'ref' }, { label: 'Date', key: 'expense_date' }, { label: 'Company', key: 'company_code' }, { label: 'Branch', key: 'branch_code' },
    { label: 'Account', key: 'account_code' }, { label: 'Account name', key: 'account_name' }, { label: 'Description', key: 'description' },
    { label: 'Paid from', key: 'money_account_name' }, { label: 'Currency', key: 'currency' }, { label: 'Amount', key: 'amount_txn' }, { label: 'USD', key: 'amount_usd' },
    { label: 'Supplier', key: 'supplier_name' }, { label: 'Container', key: 'container_no' }, { label: 'Booking', key: 'booking_ref' }, { label: 'Void', key: 'void' }]));
  if ($('#new', el)) $('#new', el).onclick = () => expenseModal(null, load);
  el.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-void]'); if (!v) return;
    const reason = await confirmDialog(`${t('void')}?`, { danger: true, withReason: true, okText: t('void') });
    if (!reason) return;
    try { await rpc('acc_void_expense', { p_expense: v.dataset.void, p_reason: reason }); toast(t('saved')); load(); } catch (err) { toast(errText(err), 'err'); }
  });
  await load();
  if (query.get('new') === '1' && can('acc.write')) expenseModal(query.get('shipment'), load);
}

export async function expenseModal(shipmentId, done) {
  const [accs, sups, shOpts] = await Promise.all([
    loadMoneyAccounts(),
    run(from('suppliers').select('id,name,default_account_code').eq('active', true).order('name')),
    shipmentOptions(shipmentId || ''),
  ]);
  const co0 = getCompany();
  const first = accs.find((m) => !co0 || m.company_code === co0) || accs[0];
  modal({
    title: t('acc_new_expense'), wide: true,
    body: `<form class="form" id="xf" novalidate>
      <div class="field"><label class="req">${esc(t('acc_paid_from'))}</label><select class="input" name="money" required>${moneyOptions(accs, first?.id)}</select></div>
      <div class="field"><label class="req">${esc(t('acc_account'))}</label><select class="input" name="account" required></select></div>
      <div class="field full"><label class="req">${esc(t('description'))}</label><input class="input" name="description" required></div>
      <div class="field"><label class="req">${esc(t('currency'))}</label><select class="input" name="currency"><option>USD</option><option>AED</option><option>TZS</option></select></div>
      <div class="field"><label class="req">${esc(t('amount'))}</label><input class="input" type="number" step="0.01" min="0" name="amount" required inputmode="decimal"></div>
      <div class="field"><label>${esc(t('fx_rate'))}</label><input class="input" type="number" step="0.0001" name="fx" value="1"></div>
      <div class="field"><label>${esc(t('usd_equiv'))}</label><input class="input" id="xusd" readonly></div>
      <div class="field"><label>${esc(t('date'))}</label><input class="input" type="date" name="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>${esc(t('acc_supplier'))} <span class="muted small">(${esc(t('optional'))})</span></label><select class="input" name="supplier"><option value="">—</option>${sups.map((s) => `<option value="${s.id}" data-acc="${esc(s.default_account_code || '')}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(t('acc_link_container'))} <span class="muted small">(${esc(t('optional'))})</span></label><select class="input" name="shipment">${shOpts}</select></div>
      <div class="field"><label>${esc(t('txn_ref'))}</label><input class="input" name="reference"></div>
      <div class="field full muted small">${esc(t('acc_ic_hint'))}</div>
    </form>`,
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="xs">${icon('check')}${esc(t('save'))}</button>`,
    onMount: async (m) => {
      const f = m.el.querySelector('#xf');
      const ma = () => accs.find((x) => x.id === f.money.value);
      const upd = () => { m.el.querySelector('#xusd').value = usd(Number(f.amount.value || 0) / Number(f.fx.value || 1)); };
      const setCur = () => { f.fx.value = fxDefault(f.currency.value) || 1; f.fx.readOnly = f.currency.value === 'USD'; upd(); };
      const setMoney = async () => {
        const a = ma(); if (!a) return;
        const keep = f.account.value;
        f.account.innerHTML = await costAccountOptions(a.company_code, keep);
        f.currency.value = a.currency; setCur();
      };
      f.money.onchange = setMoney; f.currency.onchange = setCur;
      f.amount.oninput = upd; f.fx.oninput = upd;
      f.supplier.onchange = () => { const c = f.supplier.selectedOptions[0]?.dataset.acc; if (c && [...f.account.options].some((o) => o.value === c)) f.account.value = c; };
      await setMoney();
      if (!f.account.value) f.account.value = '6900';
      m.el.querySelector('#xs').onclick = (ev) => busy(ev.currentTarget, async () => {
        if (!f.description.value.trim() || !(Number(f.amount.value) > 0)) { toast(t('required_fields'), 'err'); return; }
        try {
          const r = await rpc('acc_record_expense', { p: {
            money_account_id: f.money.value, account_code: f.account.value, description: f.description.value.trim(),
            amount: Number(f.amount.value), currency: f.currency.value, fx_rate: Number(f.fx.value), expense_date: f.date.value,
            supplier_id: f.supplier.value || null, shipment_id: f.shipment.value || null, reference: f.reference.value || null } });
          m.close(); toast(`${t('saved')} · ${r.ref}`); done && done();
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}
