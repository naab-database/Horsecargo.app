import { t } from '../i18n.js';
import { from, run, can } from '../api.js';
import { icon, esc, usd, money, fdate, empty, $, $$, toCSV, downloadCSV } from '../ui.js';
import { companySelect, getCompany, setCompany } from '../acc.js';

const ST = ['', 'open', 'part_paid', 'paid', 'void'];
export const billBadge = (s) => `<span class="badge ${s === 'paid' ? 's-ready' : s === 'void' ? 's-cancelled' : s === 'part_paid' ? 's-booked' : 's-pending_deposit'}">${esc(t('bs_' + s))}</span>`;

export async function render({ el, setTitle, query, rerender }) {
  setTitle(t('acc_bills'));
  let status = query.get('status') || '';
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('acc_bills'))}</h1><p>${esc(t('acc_bills_sub'))}</p></div>
    <div class="row">${companySelect()}<button class="btn hide-m" id="csv">${icon('download')}${esc(t('export_csv'))}</button>
    ${can('acc.write') ? `<a class="btn primary" href="#/acc/bills/new">${icon('plus')}${esc(t('acc_new_bill'))}</a>` : ''}</div></div>
  <div class="card">
    <div class="card-b" style="border-bottom:1px solid var(--line-2)"><div class="chips" id="chips">${ST.map((s) => `<button class="chip" data-v="${s}">${esc(s ? t('bs_' + s) : t('all'))}</button>`).join('')}</div></div>
    <div id="list"></div>
  </div>`;
  let rows = [];
  const load = async () => {
    $$('#chips .chip', el).forEach((c) => c.classList.toggle('on', c.dataset.v === status));
    let q = from('v_bills').select('*').order('bill_date', { ascending: false }).limit(500);
    const co = getCompany(); if (co) q = q.eq('company_code', co);
    if (status) q = q.eq('status', status);
    rows = await run(q);
    $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>${esc(t('acc_bill'))}</th><th>${esc(t('acc_supplier'))}</th><th class="hide-m">${esc(t('in_container'))}</th><th>${esc(t('status'))}</th>
      <th class="num">${esc(t('amount'))}</th><th class="num">${esc(t('balance'))} USD</th><th class="hide-m">${esc(t('date'))}</th></tr></thead>
      <tbody>${rows.map((b) => `<tr class="click" data-href="#/acc/bill/${b.id}"><td><b class="mono">${esc(b.ref)}</b><div class="muted small">${esc(b.company_code)} · ${esc(b.branch_code)}${b.supplier_invoice_no ? ' · #' + esc(b.supplier_invoice_no) : ''}</div></td>
        <td>${esc(b.supplier_name)}</td><td class="hide-m mono small">${esc(b.containers || '—')}</td><td>${billBadge(b.status)}</td>
        <td class="num nowrap">${money(b.total_txn, b.currency)}</td><td class="num" style="${b.balance_usd > 0 && b.status !== 'void' ? 'color:var(--red);font-weight:700' : ''}">${b.status === 'void' ? '—' : usd(b.balance_usd)}</td>
        <td class="hide-m nowrap">${fdate(b.bill_date)}</td></tr>`).join('')}</tbody></table></div>` : empty(t('nothing_here'), 'list');
  };
  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
  $('#chips', el).onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; status = c.dataset.v; load(); };
  $('#company', el).onchange = (e) => { setCompany(e.target.value); load(); };
  $('#csv', el).onclick = () => downloadCSV('horse-cargo-bills.csv', toCSV(rows, [
    { label: 'Bill', key: 'ref' }, { label: 'Company', key: 'company_code' }, { label: 'Branch', key: 'branch_code' }, { label: 'Date', key: 'bill_date' },
    { label: 'Supplier', key: 'supplier_name' }, { label: 'Supplier invoice', key: 'supplier_invoice_no' }, { label: 'Currency', key: 'currency' },
    { label: 'Total', key: 'total_txn' }, { label: 'Total USD', key: 'total_usd' }, { label: 'Paid USD', key: 'paid_usd' }, { label: 'Balance USD', key: 'balance_usd' },
    { label: 'Status', key: 'status' }, { label: 'Containers', key: 'containers' }]));
  await load();
}
