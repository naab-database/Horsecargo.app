import { t } from '../i18n.js';
import { from, run, rpc, can, errText, destinations } from '../api.js';
import { icon, esc, num, fdate, fdatetime, empty, debounce, $, $$, toCSV, downloadCSV, modal, busy, toast, confirmDialog } from '../ui.js';

export const STATES = ['unpacked', 'partially_packed', 'fully_packed'];
export const stateBadge = (s) => `<span class="badge pk-${esc(s)}">${esc(t('pk_' + s))}</span>`;

// "73 CTN · 10 BAG", or a plain total when everything shares one unit
export function unitLine(units, field) {
  const u = units || {};
  const keys = Object.keys(u);
  if (!keys.length) return '0';
  return keys.map((k) => `${num(u[k][field], 0)} ${esc(k)}`).join(' · ');
}
export const bar = (received, packed) => {
  const pct = Number(received) > 0 ? Math.min(100, Math.round((Number(packed) / Number(received)) * 100)) : 0;
  return `<div class="pkbar" title="${pct}%"><span style="width:${pct}%"></span></div>`;
};

export async function render({ el, setTitle, query, rerender }) {
  setTitle(t('storage'));
  let st = query.get('state') || '';
  let dest = ''; let q = '';

  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>${esc(t('storage'))}</h1><p>${esc(t('storage_sub'))}</p></div>
    <div class="row"><button class="btn hide-m" id="csv">${icon('download')}${esc(t('export_csv'))}</button></div>
  </div>
  <div class="grid c4" id="tot" style="margin-bottom:14px"></div>
  <div class="card">
    <div class="card-b" style="border-bottom:1px solid var(--line-2)">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <div class="search grow"><span>${icon('search')}</span><input class="input" id="q" placeholder="${esc(t('search_storage_ph'))}" autocomplete="off"></div>
        <select class="input" id="dest" style="width:auto"><option value="">${esc(t('all'))} · ${esc(t('destination'))}</option>
          ${destinations().map((b) => `<option value="${b.code}">${esc(b.name)}</option>`).join('')}</select>
      </div>
      <div class="chips" style="margin-top:10px" id="chips">
        <button class="chip" data-v="">${esc(t('all'))}</button>
        ${STATES.map((s) => `<button class="chip" data-v="${s}">${esc(t('pk_' + s))}</button>`).join('')}
      </div>
    </div>
    <div id="list"><div class="boot" style="min-height:30vh"><div class="spinner"></div></div></div>
  </div>`;

  let rows = [];
  const load = async () => {
    $$('#chips .chip', el).forEach((c) => c.classList.toggle('on', c.dataset.v === st));
    let b = from('v_storage').select('*').order('last_movement', { ascending: false }).limit(300);
    if (st) b = b.eq('state', st);
    if (dest) b = b.eq('destination_branch', dest);
    if (q) b = b.or(`shipment_ref.ilike.%${q}%,customer_name.ilike.%${q}%,customer_phone.ilike.%${q}%,customer_code.ilike.%${q}%`);
    rows = await run(b);

    // a plain item search as well, so "tiles" finds the shipment holding them
    if (q && rows.length === 0) {
      const items = await run(from('v_storage_items').select('shipment_id').ilike('description', `%${q}%`).limit(100));
      const ids = [...new Set(items.map((i) => i.shipment_id))];
      if (ids.length) {
        let b2 = from('v_storage').select('*').in('shipment_id', ids).order('last_movement', { ascending: false });
        if (st) b2 = b2.eq('state', st);
        rows = await run(b2);
      }
    }

    const sum = (f) => rows.reduce((a, r) => a + Number(r[f] || 0), 0);
    $('#tot', el).innerHTML = `
      <div class="card kpi"><div class="k">${esc(t('shipments_in_store'))}</div><div class="v">${rows.length}</div></div>
      <div class="card kpi"><div class="k">${esc(t('received'))}</div><div class="v">${num(sum('received_qty'), 0)}</div></div>
      <div class="card kpi"><div class="k">${esc(t('packed'))}</div><div class="v">${num(sum('packed_qty'), 0)}</div></div>
      <div class="card kpi ${sum('remaining_qty') > 0 ? 'alert' : ''}"><div class="k">${esc(t('remaining'))}</div><div class="v">${num(sum('remaining_qty'), 0)}</div></div>`;

    $('#list', el).innerHTML = rows.length ? `
      <div class="table-wrap"><table class="t"><thead><tr>
        <th>${esc(t('shipment_no'))}</th><th>${esc(t('customer'))}</th>
        <th class="num">${esc(t('received'))}</th><th class="num">${esc(t('packed'))}</th><th class="num">${esc(t('remaining'))}</th>
        <th>${esc(t('packing_state'))}</th><th class="hide-m">${esc(t('last_movement'))}</th><th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody></table></div>`
      : empty(t('storage_empty'), 'warehouse');
  };

  const rowHtml = (r) => `<tr class="click" data-href="#/storage/${r.shipment_id}">
    <td><b class="mono">${esc(r.shipment_ref)}</b><div class="muted small">${esc(r.origin_branch)}→${esc(r.destination_branch)} · ${esc(t('st_' + r.shipment_status))}</div></td>
    <td>${esc(r.customer_name)}<div class="muted small">${esc(r.customer_phone || '')}</div></td>
    <td class="num nowrap">${unitLine(r.units, 'received')}</td>
    <td class="num nowrap">${unitLine(r.units, 'packed')}</td>
    <td class="num nowrap"><b>${unitLine(r.units, 'remaining')}</b></td>
    <td>${stateBadge(r.state)}${bar(r.received_qty, r.packed_qty)}</td>
    <td class="hide-m muted small nowrap">${fdate(r.last_movement)}</td>
    <td class="num">${can('storage.pack') && r.state !== 'fully_packed'
      ? `<button class="btn small" data-pack="${r.shipment_id}">${esc(t('record_packing'))}</button>` : ''}</td></tr>`;

  $('#chips', el).onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; st = c.dataset.v; load(); };
  $('#q', el).oninput = debounce((e) => { q = e.target.value.trim(); load(); }, 300);
  $('#dest', el).onchange = (e) => { dest = e.target.value; load(); };
  el.addEventListener('click', (e) => {
    const p = e.target.closest('[data-pack]');
    if (p) { e.stopPropagation(); packingModal(p.dataset.pack, load); return; }
    const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href;
  });
  $('#csv', el).onclick = () => downloadCSV('horse-cargo-storage.csv', toCSV(rows, [
    { label: 'Shipment', key: 'shipment_ref' }, { label: 'Customer', key: 'customer_name' },
    { label: 'Phone', key: 'customer_phone' }, { label: 'Destination', key: 'destination_branch' },
    { label: 'Received', key: 'received_qty' }, { label: 'Packed', key: 'packed_qty' },
    { label: 'Remaining', key: 'remaining_qty' }, { label: 'Packing state', key: 'state' },
    { label: 'Transport status', key: 'shipment_status' }, { label: 'Last movement', key: 'last_movement' }]));
  await load();
}

// ───────── the packing sheet: every item, how many are left, how many go now ─────────
export async function packingModal(shipmentId, after) {
  const [head, items] = await Promise.all([
    run(from('v_storage').select('*').eq('shipment_id', shipmentId).maybeSingle()),
    run(from('v_storage_items').select('*').eq('shipment_id', shipmentId).order('id')),
  ]);
  if (!items.length) { toast(t('storage_none_for_shipment'), 'warn'); return; }
  const token = 'pk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  modal({
    title: `${t('record_packing')} · ${head?.shipment_ref || ''}`,
    wide: true,
    body: `
      <p class="muted">${esc(t('packing_help'))}</p>
      <div class="table-wrap"><table class="t pack-t"><thead><tr>
        <th>${esc(t('item'))}</th><th class="num">${esc(t('received'))}</th><th class="num">${esc(t('packed'))}</th>
        <th class="num">${esc(t('remaining'))}</th><th class="num" style="width:130px">${esc(t('pack_now'))}</th></tr></thead>
      <tbody>${items.map((i) => `<tr data-item="${i.item_id}">
        <td><b>${esc(i.description)}</b><div class="muted small">${esc(i.unit)}${i.location ? ' · ' + esc(i.location) : ''}</div></td>
        <td class="num" data-l="${esc(t('received'))}: ">${num(i.received_qty, 0)}</td>
        <td class="num" data-l="${esc(t('packed'))}: ">${num(i.packed_qty, 0)}</td>
        <td class="num" data-l="${esc(t('remaining'))}: "><b>${num(i.remaining_qty, 0)}</b></td>
        <td class="num">${Number(i.remaining_qty) > 0
          ? `<input class="input num qty" type="number" min="0" step="1" max="${i.remaining_qty}" placeholder="0" inputmode="numeric">
             <button type="button" class="link small all-btn">${esc(t('pack_all'))}</button>`
          : `<span class="badge pk-fully_packed">${esc(t('pk_fully_packed'))}</span>`}</td></tr>`).join('')}
      </tbody></table></div>
      <label class="fl" style="margin-top:12px"><span>${esc(t('notes'))}</span>
        <input class="input" id="pk-notes" placeholder="${esc(t('packing_notes_ph'))}" maxlength="200"></label>
      <div class="muted small" id="pk-sum" style="margin-top:8px"></div>`,
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button>
           <button class="btn primary" id="pk-save">${icon('check')}${esc(t('save'))}</button>`,
    onMount: (m) => {
      const root = m.el;
      const sum = () => {
        const total = $$('.qty', root).reduce((a, i) => a + (Number(i.value) || 0), 0);
        $('#pk-sum', root).textContent = total ? `${t('total_to_pack')}: ${total}` : '';
        $('#pk-save', root).disabled = total <= 0;
      };
      $$('.qty', root).forEach((i) => {
        i.oninput = () => {
          const max = Number(i.max);
          if (Number(i.value) > max) { i.value = max; toast(t('only_n_left').replace('{n}', max), 'warn'); }
          sum();
        };
      });
      $$('.all-btn', root).forEach((b) => {
        b.onclick = () => { const i = b.parentElement.querySelector('.qty'); i.value = i.max; sum(); };
      });
      sum();
      $('#pk-save', root).onclick = (e) => busy(e.currentTarget, async () => {
        const lines = $$('.pack-t tbody tr', root).map((tr) => {
          const inp = tr.querySelector('.qty'); const qty = Number(inp?.value || 0);
          return qty > 0 ? { item_id: Number(tr.dataset.item), qty } : null;
        }).filter(Boolean);
        if (!lines.length) return;
        try {
          const r = await rpc('record_packing', { p: { shipment_id: shipmentId, lines, notes: $('#pk-notes', root).value.trim() || null, client_token: token } });
          toast(r.duplicate ? t('already_recorded') : `${t('packing_saved')} · ${r.ref}`, 'ok');
          m.close();
          if (after) after();
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}

export { confirmDialog, fdatetime };
