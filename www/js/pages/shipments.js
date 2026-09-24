import { t } from '../i18n.js';
import { from, run, can, state, destinations } from '../api.js';
import { icon, esc, usd, money, num, fdate, statusBadge, modeTag, empty, debounce, $, $$, toCSV, downloadCSV } from '../ui.js';

export const FLOW = ['received_dubai', 'packed', 'dispatched', 'in_transit', 'in_customs', 'arrived', 'delivered'];
export const payBadge = (s) => s === 'paid' ? `<span class="badge s-ready">${esc(t('ps_paid'))}</span>`
  : s === 'part_paid' ? `<span class="badge s-booked">${esc(t('ps_part_paid'))}</span>`
  : s === 'none' ? '' : `<span class="badge s-pending_deposit">${esc(t('ps_unpaid'))}</span>`;

export async function render({ el, setTitle, query }) {
  setTitle(t('shipments'));
  let status = query.get('status') || '';
  let mode = ''; let dest = ''; let pay = ''; let q = '';
  let from_ = query.get('from') || ''; let to = query.get('to') || '';

  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>${esc(t('shipments'))}</h1><p>${esc(t('shipments_sub'))}</p></div>
    <div class="row">
      <button class="btn hide-m" id="csv">${icon('download')}${esc(t('export_csv'))}</button>
      ${can('shipment.create') ? `<a class="btn primary" href="#/shipments/new">${icon('plus')}${esc(t('new_shipment'))}</a>` : ''}
    </div>
  </div>
  <div class="card">
    <div class="card-b" style="border-bottom:1px solid var(--line-2)">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <div class="search grow"><span>${icon('search')}</span><input class="input" id="q" placeholder="${esc(t('search_ship_ph'))}" autocomplete="off"></div>
        <select class="input" id="mode" style="width:auto"><option value="">${esc(t('all'))} · ${esc(t('mode'))}</option><option value="sea">${esc(t('sea'))}</option><option value="air">${esc(t('air'))}</option></select>
        <select class="input" id="dest" style="width:auto"><option value="">${esc(t('all'))} · ${esc(t('destination'))}</option>
          ${destinations().map((b) => `<option value="${b.code}">${esc(b.name)}</option>`).join('')}</select>
        <select class="input" id="pay" style="width:auto"><option value="">${esc(t('all'))} · ${esc(t('payment'))}</option>
          <option value="unpaid">${esc(t('ps_unpaid'))}</option><option value="part_paid">${esc(t('ps_part_paid'))}</option><option value="paid">${esc(t('ps_paid'))}</option></select>
        <input class="input" type="date" id="d1" value="${esc(from_)}" style="width:auto" title="${esc(t('from'))}">
        <input class="input" type="date" id="d2" value="${esc(to)}" style="width:auto" title="${esc(t('to'))}">
      </div>
      <div class="chips" style="margin-top:10px" id="chips">
        <button class="chip" data-v="">${esc(t('all'))}</button>
        ${FLOW.map((s) => `<button class="chip" data-v="${s}">${esc(t('st_' + s))}</button>`).join('')}
        <button class="chip" data-v="cancelled">${esc(t('st_cancelled'))}</button>
      </div>
    </div>
    <div id="list"><div class="boot" style="min-height:30vh"><div class="spinner"></div></div></div>
  </div>`;

  let rows = [];
  const load = async () => {
    $$('#chips .chip', el).forEach((c) => c.classList.toggle('on', c.dataset.v === status));
    let b = from('v_shipments').select('*').order('created_at', { ascending: false }).limit(300);
    if (status) b = b.eq('status', status);
    if (mode) b = b.eq('mode', mode);
    if (dest) b = b.eq('destination_branch', dest);
    if (pay) b = b.eq('payment_status', pay);
    if (from_) b = b.gte('created_at', from_);
    if (to) b = b.lte('created_at', to + 'T23:59:59');
    if (q) b = b.or(`ref.ilike.%${q}%,customer_name.ilike.%${q}%,receiver_name.ilike.%${q}%,customer_phone.ilike.%${q}%,receiver_phone.ilike.%${q}%,description.ilike.%${q}%`);
    rows = await run(b);
    $('#list', el).innerHTML = rows.length ? `
      <div class="table-wrap"><table class="t"><thead><tr>
        <th>${esc(t('shipment_no'))}</th><th>${esc(t('sender'))} → ${esc(t('receiver'))}</th>
        <th class="hide-m">${esc(t('mode'))}</th><th class="num hide-m">${esc(t('measure'))}</th>
        <th>${esc(t('status'))}</th><th class="num">${esc(t('invoice'))}</th><th>${esc(t('payment'))}</th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody></table></div>`
      : empty(t('nothing_here'), 'box');
  };
  const rowHtml = (s) => `<tr class="click" data-href="#/shipment/${s.id}">
    <td><b class="mono">${esc(s.ref)}</b><div class="muted small">${fdate(s.created_at)} · ${esc(s.origin_branch)}→${esc(s.destination_branch)}</div></td>
    <td>${esc(s.customer_name)}<div class="muted small">→ ${esc(s.receiver_name)}${s.item_count > 1 ? ` · ${s.item_count} ${esc(t('items'))}` : ''}</div></td>
    <td class="hide-m">${modeTag(s.mode)}</td>
    <td class="num hide-m nowrap">${s.mode === 'sea' ? num(s.cbm, 3) + ' CBM' : num(s.weight_kg || s.actual_kg, 1) + ' kg'}</td>
    <td>${statusBadge(s.status)}</td>
    <td class="num nowrap">${money(s.invoice_total_txn, s.invoice_currency)}${s.balance_txn > 0.009 && s.status !== 'cancelled' ? `<div class="small" style="color:var(--red)">${esc(t('balance'))} ${money(s.balance_txn, s.invoice_currency)}</div>` : ''}</td>
    <td>${payBadge(s.payment_status)}</td></tr>`;

  $('#chips', el).onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; status = c.dataset.v; load(); };
  $('#q', el).oninput = debounce((e) => { q = e.target.value.trim(); load(); }, 300);
  $('#mode', el).onchange = (e) => { mode = e.target.value; load(); };
  $('#dest', el).onchange = (e) => { dest = e.target.value; load(); };
  $('#pay', el).onchange = (e) => { pay = e.target.value; load(); };
  $('#d1', el).onchange = (e) => { from_ = e.target.value; load(); };
  $('#d2', el).onchange = (e) => { to = e.target.value; load(); };
  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
  $('#csv', el).onclick = () => downloadCSV('horse-cargo-shipments.csv', toCSV(rows, [
    { label: 'Shipment', key: 'ref' }, { label: 'Date', key: 'created_at' }, { label: 'Mode', key: 'mode' },
    { label: 'Origin', key: 'origin_branch' }, { label: 'Destination', key: 'destination_branch' },
    { label: 'Sender', key: 'customer_name' }, { label: 'Sender phone', key: 'customer_phone' },
    { label: 'Receiver', key: 'receiver_name' }, { label: 'Receiver phone', key: 'receiver_phone' },
    { label: 'Cargo', key: 'description' }, { label: 'CBM', key: 'cbm' }, { label: 'Weight kg', key: 'weight_kg' },
    { label: 'Rate USD', key: 'rate_used' }, { label: 'Freight USD', key: 'quoted_amount' },
    { label: 'Currency', key: 'invoice_currency' }, { label: 'Exchange rate (1 USD)', key: 'invoice_fx' },
    { label: 'Invoice total', key: 'invoice_total_txn' }, { label: 'Paid', key: 'paid_txn' }, { label: 'Balance', key: 'balance_txn' },
    { label: 'Invoice USD', key: 'invoice_total' }, { label: 'Paid USD', key: 'paid_usd' }, { label: 'Balance USD', key: 'balance_usd' },
    { label: 'Status', key: 'status' }, { label: 'Payment', key: 'payment_status' }, { label: 'Invoice no', key: 'invoice_ref' }]));
  await load();
}
