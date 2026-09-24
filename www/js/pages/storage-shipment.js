import { t } from '../i18n.js';
import { from, run, rpc, can, errText } from '../api.js';
import { icon, esc, num, fdatetime, empty, $, $$, modal, busy, toast, confirmDialog } from '../ui.js';
import { stateBadge, bar, packingModal } from './storage.js';

export async function render({ el, params, setTitle, rerender }) {
  const id = params[0];
  const [head, items, entries] = await Promise.all([
    run(from('v_storage').select('*').eq('shipment_id', id).maybeSingle()),
    run(from('v_storage_items').select('*').eq('shipment_id', id).order('id')),
    run(from('v_packing_entries').select('*').eq('shipment_id', id).order('packed_at', { ascending: false })),
  ]);
  if (!head) { el.innerHTML = empty(t('storage_none_for_shipment'), 'warehouse'); setTitle(t('storage')); return; }
  setTitle(`${t('storage')} · ${head.shipment_ref}`);

  const lines = entries.length
    ? await run(from('v_packing_lines').select('*').in('entry_id', entries.map((e) => e.id)))
    : [];
  const byEntry = (eid) => lines.filter((l) => l.entry_id === eid);

  el.innerHTML = `
  <div class="page-head">
    <div class="grow">
      <h1>${esc(head.shipment_ref)} ${stateBadge(head.state)}</h1>
      <p>${esc(head.customer_name)}${head.customer_phone ? ' · ' + esc(head.customer_phone) : ''} · ${esc(head.origin_branch)}→${esc(head.destination_branch)}</p>
    </div>
    <div class="row">
      <a class="btn" href="#/shipment/${esc(head.shipment_id)}">${icon('box')}${esc(t('open_shipment'))}</a>
      ${can('storage.pack') && head.state !== 'fully_packed' ? `<button class="btn primary" id="pack">${icon('check')}${esc(t('record_packing'))}</button>` : ''}
    </div>
  </div>

  <div class="note info" style="margin-bottom:14px">${icon('info')}
    <div>${esc(t('packing_vs_status'))} — ${esc(t('transport_status'))}: <b>${esc(t('st_' + head.shipment_status))}</b></div></div>

  <div class="card">
    <div class="card-h"><h2>${esc(t('items_in_storage'))}</h2></div>
    <div class="table-wrap"><table class="t"><thead><tr>
      <th>${esc(t('item'))}</th><th class="num">${esc(t('received'))}</th><th class="num">${esc(t('packed'))}</th>
      <th class="num">${esc(t('remaining'))}</th><th>${esc(t('packing_state'))}</th><th class="hide-m">${esc(t('history'))}</th></tr></thead>
    <tbody>${items.map((i) => {
      const hist = lines.filter((l) => l.item_id === i.item_id).sort((a, b) => new Date(a.packed_at) - new Date(b.packed_at));
      return `<tr>
        <td><b>${esc(i.description)}</b><div class="muted small">${esc(i.unit)}${i.location ? ' · ' + esc(i.location) : ''}</div></td>
        <td class="num">${num(i.received_qty, 0)}</td>
        <td class="num">${num(i.packed_qty, 0)}</td>
        <td class="num"><b>${num(i.remaining_qty, 0)}</b></td>
        <td>${stateBadge(i.state)}${bar(i.received_qty, i.packed_qty)}</td>
        <td class="hide-m small">${hist.length ? hist.map((h) => `<div class="${h.void ? 'struck muted' : ''}">
              <span class="mono">${esc(h.entry_ref)}</span> · ${num(h.qty, 0)} ${esc(h.unit)} · ${fdatetime(h.packed_at)}
              ${h.packed_by_name ? ' · ' + esc(h.packed_by_name) : ''}</div>`).join('')
            : `<span class="muted">${esc(t('not_packed_yet'))}</span>`}</td></tr>`;
    }).join('')}</tbody></table></div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-h"><h2>${esc(t('packing_entries'))}</h2><span class="muted small">${entries.length}</span></div>
    ${entries.length ? `<div class="table-wrap"><table class="t"><thead><tr>
        <th>${esc(t('entry'))}</th><th>${esc(t('when'))}</th><th>${esc(t('by'))}</th>
        <th class="num">${esc(t('quantity'))}</th><th>${esc(t('notes'))}</th><th></th></tr></thead>
      <tbody>${entries.map((e) => `<tr class="${e.void ? 'void-row' : ''}">
        <td><b class="mono">${esc(e.ref)}</b>${e.void ? ` <span class="badge s-cancelled">${esc(t('reversed'))}</span>` : ''}
          <div class="muted small">${byEntry(e.id).map((l) => `${esc(l.description)} ×${num(l.qty, 0)}`).join(', ')}</div></td>
        <td class="nowrap small">${fdatetime(e.packed_at)}</td>
        <td class="small">${esc(e.packed_by_name || t('system'))}</td>
        <td class="num">${num(e.total_qty, 0)}</td>
        <td class="small">${esc(e.notes || '')}${e.void ? `<div class="muted small">${esc(t('reason'))}: ${esc(e.void_reason || '')}${e.voided_by_name ? ' · ' + esc(e.voided_by_name) : ''}</div>` : ''}</td>
        <td class="num">${!e.void && can('storage.correct') ? `<button class="btn small danger" data-void="${e.id}">${esc(t('reverse'))}</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
      : empty(t('not_packed_yet'), 'clipboard')}
  </div>`;

  const pack = $('#pack', el);
  if (pack) pack.onclick = () => packingModal(id, rerender);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-void]'); if (!b) return;
    const reason = await confirmDialog(t('reverse_confirm'), { okText: t('reverse'), danger: true, withReason: true, reasonLabel: t('reason') });
    if (!reason) return;
    try { await rpc('void_packing_entry', { p_entry: b.dataset.void, p_reason: reason }); toast(t('packing_reversed'), 'ok'); rerender(); }
    catch (err) { toast(errText(err), 'err'); }
  });
}
