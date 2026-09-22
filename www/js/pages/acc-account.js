import { t } from '../i18n.js';
import { from, run, can } from '../api.js';
import { icon, esc, usd, fdate, empty, $, toCSV, downloadCSV } from '../ui.js';
import { companySelect, getCompany, setCompany, loadAccounts, accName, sourceLabel, signed } from '../acc.js';
import { natural } from './acc-coa.js';
import { journalDetail } from './acc-journals.js';

const firstOfYear = () => `${new Date().getFullYear()}-01-01`;

export async function render({ el, params, setTitle }) {
  const code = params[0];
  if (!can('acc.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  const list = (await loadAccounts()).filter((a) => a.code === code);
  const acc = list.find((a) => a.company_code === getCompany()) || list[0];
  if (!acc) { el.innerHTML = empty(t('not_found'), 'list'); return; }
  setTitle(`${code} · ${accName(acc)}`);
  el.innerHTML = `
  <div class="page-head"><div class="grow"><a class="small" href="#/acc/coa">← ${esc(t('acc_coa'))}</a>
    <h1><span class="mono">${esc(code)}</span> ${esc(accName(acc))}</h1><p>${esc(t('at_' + acc.type))}</p></div>
    <div class="row">${companySelect()}
      <input class="input" type="date" id="d1" value="${firstOfYear()}" style="width:auto"><input class="input" type="date" id="d2" value="${new Date().toISOString().slice(0, 10)}" style="width:auto">
      <button class="btn" id="csv">${icon('download')}${esc(t('export_csv'))}</button></div></div>
  <div class="card" id="out"></div>`;
  let rows = [];
  const load = async () => {
    const co = getCompany(); const d1 = $('#d1', el).value; const d2 = $('#d2', el).value;
    let q = from('v_journal_lines').select('*').eq('account_code', code).eq('journal_status', 'posted').lte('entry_date', d2)
      .order('entry_date').order('journal_id').order('id').limit(10000);
    if (co) q = q.eq('company_code', co);
    const all = await run(q);
    const nat = (l) => natural(acc.type, Number(l.debit) - Number(l.credit));
    const opening = all.filter((l) => l.entry_date < d1).reduce((a, l) => a + nat(l), 0);
    let run_ = opening;
    rows = all.filter((l) => l.entry_date >= d1).map((l) => ({ ...l, balance: (run_ += nat(l)) }));
    const dr = rows.reduce((a, l) => a + Number(l.debit), 0); const cr = rows.reduce((a, l) => a + Number(l.credit), 0);
    $('#out', el).innerHTML = `
      <div class="card-b"><div class="money">
        <div><div class="k">${esc(t('acc_opening'))}</div><div class="v">${signed(opening)}</div></div>
        <div><div class="k">${esc(t('acc_debits'))}</div><div class="v">${usd(dr)}</div></div>
        <div><div class="k">${esc(t('acc_credits'))}</div><div class="v">${usd(cr)}</div></div>
        <div><div class="k">${esc(t('acc_closing'))}</div><div class="v">${signed(run_)}</div></div></div></div>
      ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('date'))}</th><th>${esc(t('reference'))}</th><th>${esc(t('description'))}</th><th class="num">Dr</th><th class="num">Cr</th><th class="num">${esc(t('balance'))}</th></tr></thead>
      <tbody>${rows.map((l) => `<tr class="click" data-j="${l.journal_id}"><td class="nowrap">${fdate(l.entry_date)}</td>
        <td><b class="mono small">${esc(l.journal_ref)}</b><div class="muted small">${esc(l.company_code)} · ${esc(sourceLabel(l.source))}</div></td>
        <td class="small">${esc(l.description || l.memo || '')}<div class="muted">${[l.shipment_ref, l.customer_name, l.supplier_name].filter(Boolean).map(esc).join(' · ')}</div></td>
        <td class="num">${Number(l.debit) ? usd(l.debit, { bare: true }) : ''}</td><td class="num">${Number(l.credit) ? usd(l.credit, { bare: true }) : ''}</td>
        <td class="num">${signed(l.balance)}</td></tr>`).join('')}</tbody></table></div>` : empty(t('nothing_here'), 'list')}`;
  };
  $('#company', el).onchange = (e) => { setCompany(e.target.value); load(); };
  $('#d1', el).onchange = load; $('#d2', el).onchange = load;
  $('#csv', el).onclick = () => downloadCSV(`horse-cargo-ledger-${code}.csv`, toCSV(rows, [
    { label: 'Date', key: 'entry_date' }, { label: 'Journal', key: 'journal_ref' }, { label: 'Company', key: 'company_code' }, { label: 'Source', key: 'source' },
    { label: 'Description', key: 'description' }, { label: 'Memo', key: 'memo' }, { label: 'Debit', key: 'debit' }, { label: 'Credit', key: 'credit' }, { label: 'Balance', key: 'balance' },
    { label: 'Shipment', key: 'shipment_ref' }, { label: 'Customer', key: 'customer_name' }, { label: 'Supplier', key: 'supplier_name' }]));
  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-j]'); if (tr) journalDetail(tr.dataset.j, load); });
  await load();
}
