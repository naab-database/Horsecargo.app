import { t } from '../i18n.js';
import { from, run, can, state } from '../api.js';
import { icon, esc, usd, fdate, num, statusBadge, modeTag, route, debounce, empty, $, $$, toCSV, downloadCSV } from '../ui.js';

const STATUSES = ['pending_deposit', 'booked', 'received', 'loaded', 'in_transit', 'arrived', 'clearing', 'ready', 'released', 'cancelled'];
const PAGE = 30;

export async function render({ el, setTitle, query }) {
  setTitle(t('bookings'));
  const f = { status: query.get('status') || '', mode: '', branch: '', q: '' };
  let offset = 0; let rows = []; let total = 0;

  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>${esc(t('bookings'))}</h1></div>
    <div class="row">
      <button class="btn hide-m" id="csv">${icon('download')}${esc(t('export_csv'))}</button>
      ${can('booking.create') ? `<a class="btn primary" href="#/bookings/new">${icon('plus')}${esc(t('new_booking'))}</a>` : ''}
    </div>
  </div>
  <div class="card">
    <div class="card-b stack" style="gap:10px;border-bottom:1px solid var(--line-2)">
      <div class="row">
        <div class="search" style="flex:1;min-width:220px">${icon('search')}<input class="input" id="q" placeholder="${esc(t('search_ph'))}"></div>
        <div class="seg" id="mode"><button data-v="" class="on">${esc(t('all'))}</button><button data-v="sea">${icon('ship')}${esc(t('sea'))}</button><button data-v="air">${icon('plane')}${esc(t('air'))}</button></div>
        <select class="input" id="branch" style="width:auto"><option value="">${esc(t('branch'))}: ${esc(t('all'))}</option>
          ${state.branches.map((b) => `<option value="${b.code}">${esc(b.code)} · ${esc(b.name)}</option>`).join('')}</select>
      </div>
      <div class="chips" id="chips"><button class="chip" data-v="">${esc(t('all'))}</button>
        ${STATUSES.map((s) => `<button class="chip" data-v="${s}">${esc(t('st_' + s))}</button>`).join('')}</div>
    </div>
    <div id="list"></div>
    <div class="card-b hidden" id="more-wrap" style="text-align:center"><button class="btn" id="more">${esc(t('load_more'))}</button></div>
  </div>`;

  const syncChips = () => $$('#chips .chip', el).forEach((c) => c.classList.toggle('on', c.dataset.v === f.status));
  syncChips();

  const build = (b) => {
    if (f.status) b = b.eq('status', f.status);
    if (f.mode) b = b.eq('mode', f.mode);
    if (f.branch) b = b.or(`origin_branch.eq.${f.branch},destination_branch.eq.${f.branch}`);
    if (f.q) { const s = f.q.replace(/[,()]/g, ' '); b = b.or(`ref.ilike.*${s}*,customer_name.ilike.*${s}*,customer_phone.ilike.*${s}*,consignee_name.ilike.*${s}*,consignee_phone.ilike.*${s}*,description.ilike.*${s}*`); }
    return b;
  };

  const draw = () => {
    const list = $('#list', el);
    if (!rows.length) { list.innerHTML = empty(); $('#more-wrap', el).classList.add('hidden'); return; }
    list.innerHTML = `
    <div class="table-wrap cards-m"><table class="t"><thead><tr>
      <th>${esc(t('booking_ref'))}</th><th>${esc(t('customer'))}</th><th>${esc(t('route'))}</th><th class="hide-m">${esc(t('cargo'))}</th>
      <th>${esc(t('status'))}</th><th class="num">${esc(t('balance'))}</th><th class="hide-m">${esc(t('date'))}</th></tr></thead>
    <tbody>${rows.map((b) => `<tr class="click" data-href="#/booking/${b.id}">
      <td class="mono nowrap"><b>${esc(b.ref)}</b></td>
      <td><div>${esc(b.customer_name)}</div><div class="muted small">→ ${esc(b.consignee_name)}</div></td>
      <td class="nowrap">${modeTag(b.mode)}<div>${route(b.origin_branch, b.destination_branch)}</div></td>
      <td class="hide-m"><div style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.description)}</div>
        <div class="muted small">${b.cbm !== null ? `${num(b.pieces, 0)} pcs · ${num(b.cbm, 3)} CBM · ${num(b.actual_kg, 1)} kg` : `≈ ${num(b.est_pieces, 0)} pcs · ${num(b.est_cbm, 2)} CBM`}</div></td>
      <td>${statusBadge(b.status)}${b.shipment_ref ? `<div class="muted small mono">${esc(b.container_no || b.shipment_ref)}</div>` : ''}</td>
      <td class="num" style="${b.balance_usd > 0 ? 'color:var(--red);font-weight:700' : ''}">${usd(b.balance_usd)}</td>
      <td class="hide-m nowrap">${fdate(b.created_at)}</td></tr>`).join('')}</tbody></table></div>
    <div class="list-cards">${rows.map((b) => `<a class="lc" href="#/booking/${b.id}">
      <div class="top"><span class="mono"><b>${esc(b.ref)}</b></span>${statusBadge(b.status)}</div>
      <div class="sub">${esc(b.customer_name)} → ${esc(b.consignee_name)}</div>
      <div class="sub row" style="justify-content:space-between"><span>${esc(t(b.mode))} · ${esc(b.origin_branch)} → ${esc(b.destination_branch)}</span>
      <span class="num" style="${b.balance_usd > 0 ? 'color:var(--red);font-weight:700' : ''}">${usd(b.balance_usd)}</span></div></a>`).join('')}</div>`;
    $('#more-wrap', el).classList.toggle('hidden', rows.length >= total);
  };

  const load = async (reset = true) => {
    if (reset) { offset = 0; rows = []; }
    const { data, count } = await run(build(from('v_bookings').select('*', { count: 'exact' })).order('created_at', { ascending: false }).range(offset, offset + PAGE - 1));
    rows = rows.concat(data); offset += data.length; total = count;
    draw();
  };

  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
  $('#q', el).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); load(); }, 300));
  $('#chips', el).addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c) return; f.status = c.dataset.v; syncChips(); load(); });
  $('#mode', el).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; f.mode = b.dataset.v; $$('#mode button', el).forEach((x) => x.classList.toggle('on', x === b)); load(); });
  $('#branch', el).onchange = (e) => { f.branch = e.target.value; load(); };
  $('#more', el).onclick = () => load(false);
  $('#csv', el).onclick = async () => {
    const data = await run(build(from('v_bookings').select('*')).order('created_at', { ascending: false }).limit(5000));
    downloadCSV(`horse-cargo-bookings-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(data, [
      { label: 'Booking', key: 'ref' }, { label: 'Date', value: (r) => r.created_at.slice(0, 10) }, { label: 'Customer', key: 'customer_name' },
      { label: 'Customer phone', key: 'customer_phone' }, { label: 'Consignee', key: 'consignee_name' }, { label: 'Mode', key: 'mode' },
      { label: 'Origin', key: 'origin_branch' }, { label: 'Destination', key: 'destination_branch' }, { label: 'Status', key: 'status' },
      { label: 'Pieces', value: (r) => r.pieces ?? r.est_pieces }, { label: 'CBM', value: (r) => r.cbm ?? r.est_cbm }, { label: 'KG', value: (r) => r.actual_kg ?? r.est_kg },
      { label: 'Invoice USD', key: 'invoice_total' }, { label: 'Paid USD', key: 'paid_usd' }, { label: 'Balance USD', key: 'balance_usd' },
      { label: 'Container', value: (r) => r.container_no || r.shipment_ref || '' },
    ]));
  };
  await load();
}
