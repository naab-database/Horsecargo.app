import { t } from '../i18n.js';
import { from, run, rpc, can, errText } from '../api.js';
import { icon, esc, usd, num, fdate, fdatetime, shipBadge, statusBadge, modeTag, route, toast, confirmDialog, busy, empty, $, $$ } from '../ui.js';
import { openShipmentModal } from './shipments.js';
import { scanModal, refFromText } from '../scanner.js';

export async function render({ el, params, setTitle, rerender }) {
  const s = await run(from('v_shipments').select('*').eq('id', params[0]).single());
  const [loaded, eligible] = await Promise.all([
    run(from('v_bookings').select('*').eq('shipment_id', s.id).order('ref')),
    s.status === 'open'
      ? run(from('v_bookings').select('*').eq('status', 'received').eq('mode', s.mode).eq('origin_branch', s.origin_branch).eq('destination_branch', s.destination_branch).order('created_at'))
      : [],
  ]);
  setTitle(s.container_no || s.ref);
  const util = s.capacity_cbm ? Math.round(s.total_cbm / s.capacity_cbm * 100) : null;
  const canLoad = s.status === 'open' && can('shipment.load');

  const acts = [];
  if (can('shipment.write')) acts.push(`<button class="btn" data-act="edit">${icon('gear')}${esc(t('edit'))}</button>`);
  acts.push(`<a class="btn" href="#/doc/manifest/${s.id}">${icon('print')}${esc(t('manifest'))}</a>`);
  if (canLoad) acts.push(`<button class="btn" data-act="scanload">${icon('scan')}${esc(t('scan_to_load'))}</button>`);
  if (can('shipment.status')) {
    if (s.status === 'open') acts.push(`<button class="btn primary" data-act="depart" ${loaded.length ? '' : 'disabled'}>${icon(s.mode === 'air' ? 'plane' : 'ship')}${esc(t('mark_departed'))}</button>`);
    if (s.status === 'departed') acts.push(`<button class="btn primary" data-act="arrive">${icon('check')}${esc(t('mark_arrived'))}</button>`);
    if (s.status === 'arrived') acts.push(`<button class="btn" data-act="complete">${icon('check')}${esc(t('mark_completed'))}</button>`);
  }

  el.innerHTML = `
  <div class="page-head">
    <div class="grow">
      <div class="row" style="gap:8px">${modeTag(s.mode)} ${route(s.origin_branch, s.destination_branch)} ${shipBadge(s.status)}</div>
      <h1 class="mono" style="margin-top:4px">${esc(s.container_no || s.ref)}</h1>
      <p class="mono">${esc(s.ref)}${s.container_type ? ' · ' + esc(s.container_type) : ''}</p>
    </div>
    <div class="row">${acts.join('')}</div>
  </div>
  <div class="stack">
    <div class="grid c4">
      <div class="card kpi"><div class="k">${esc(t('bookings'))}</div><div class="v">${s.booking_count}</div><div class="s">${num(s.total_pieces, 0)} ${esc(t('pieces').toLowerCase())}</div></div>
      <div class="card kpi"><div class="k">CBM</div><div class="v">${num(s.total_cbm, 3)}</div><div class="s">${s.capacity_cbm ? `/ ${num(s.capacity_cbm, 1)}` : ''}</div></div>
      <div class="card kpi"><div class="k">${esc(t('weight_kg'))}</div><div class="v">${num(s.total_kg, 0)}</div><div class="s">kg</div></div>
      <div class="card kpi"><div class="k">${esc(t('utilisation'))}</div><div class="v">${util !== null ? util + '%' : '—'}</div>
        ${util !== null ? `<div class="progress ${util > 100 ? 'over' : ''}" style="margin-top:6px"><div style="width:${Math.min(util, 100)}%"></div></div>` : ''}</div>
    </div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-h"><h2>${esc(t('loaded_bookings'))}</h2></div>
          ${loaded.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('booking_ref'))}</th><th>${esc(t('customer'))}</th><th class="num">${esc(t('pieces'))}</th><th class="num">CBM</th><th class="num">${esc(t('balance'))}</th><th>${esc(t('status'))}</th><th></th></tr></thead>
            <tbody>${loaded.map((b) => `<tr><td><a class="mono" href="#/booking/${b.id}"><b>${esc(b.ref)}</b></a></td><td>${esc(b.customer_name)}<div class="muted small">→ ${esc(b.consignee_name)}</div></td>
              <td class="num">${num(b.pieces, 0)}</td><td class="num">${num(b.cbm, 3)}</td><td class="num" style="${b.balance_usd > 0 ? 'color:var(--red);font-weight:700' : ''}">${usd(b.balance_usd)}</td><td>${statusBadge(b.status)}</td>
              <td class="right">${canLoad ? `<button class="btn sm danger" data-act="unload" data-id="${b.id}">${esc(t('unload'))}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty(t('nothing_here'), 'box')}
        </div>
        ${s.status === 'open' ? `
        <div class="card">
          <div class="card-h"><h2>${esc(t('eligible_cargo'))}</h2><span class="muted">${eligible.length}</span>
            ${canLoad && eligible.length ? `<button class="btn sm primary" data-act="loadsel">${icon('check')}${esc(t('load_selected'))}</button>` : ''}</div>
          ${eligible.length ? `<div class="table-wrap"><table class="t"><thead><tr><th style="width:36px">${canLoad ? '<input type="checkbox" id="all">' : ''}</th><th>${esc(t('booking_ref'))}</th><th>${esc(t('customer'))}</th><th class="num">${esc(t('pieces'))}</th><th class="num">CBM</th><th class="num">kg</th></tr></thead>
            <tbody>${eligible.map((b) => `<tr><td>${canLoad ? `<input type="checkbox" class="pick" value="${b.id}" data-cbm="${b.cbm}">` : ''}</td><td><a class="mono" href="#/booking/${b.id}">${esc(b.ref)}</a></td>
              <td>${esc(b.customer_name)}</td><td class="num">${num(b.pieces, 0)}</td><td class="num">${num(b.cbm, 3)}</td><td class="num">${num(b.actual_kg, 1)}</td></tr>`).join('')}</tbody></table></div>
            <div class="card-b muted small" id="sel-sum"></div>` : empty(t('nothing_here'), 'box')}
        </div>` : ''}
      </div>
      <div class="card">
        <div class="card-h"><h2>${esc(t('details'))}</h2></div>
        <div class="card-b"><dl class="kv">
          <dt>${esc(t('container_no'))}</dt><dd class="mono">${esc(s.container_no || '—')}</dd>
          <dt>${esc(t('seal_no'))}</dt><dd class="mono">${esc(s.seal_no || '—')}</dd>
          <dt>${esc(t('carrier'))}</dt><dd>${esc(s.carrier || '—')}</dd>
          <dt>${esc(t('vessel_or_flight'))}</dt><dd>${esc(s.vessel_or_flight || '—')}</dd>
          <dt>${esc(t('bl_awb_no'))}</dt><dd class="mono">${esc(s.bl_awb_no || '—')}</dd>
          <dt>${esc(t('etd'))}</dt><dd>${fdate(s.etd)}</dd>
          <dt>${esc(t('eta'))}</dt><dd>${fdate(s.eta)}</dd>
          <dt>${esc(t('sh_departed'))}</dt><dd>${fdatetime(s.departed_at)}</dd>
          <dt>${esc(t('sh_arrived'))}</dt><dd>${fdatetime(s.arrived_at)}</dd>
          ${s.notes ? `<dt>${esc(t('notes'))}</dt><dd>${esc(s.notes)}</dd>` : ''}
        </dl></div>
      </div>
    </div>
  </div>`;

  const sumSel = () => {
    const picks = $$('.pick:checked', el);
    const cbm = picks.reduce((a, p) => a + Number(p.dataset.cbm || 0), 0);
    const box = $('#sel-sum', el);
    if (box) box.textContent = picks.length ? `${picks.length} · ${cbm.toFixed(3)} CBM → ${(Number(s.total_cbm) + cbm).toFixed(3)}${s.capacity_cbm ? ' / ' + s.capacity_cbm : ''} CBM` : '';
  };
  el.addEventListener('change', (e) => {
    if (e.target.id === 'all') $$('.pick', el).forEach((p) => { p.checked = e.target.checked; });
    if (e.target.id === 'all' || e.target.classList.contains('pick')) sumSel();
  });

  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    try {
      if (act === 'edit') return openShipmentModal(s, () => rerender());
      if (act === 'unload') { await rpc('unload_booking', { p_booking: a.dataset.id }); toast(t('saved')); return rerender(); }
      if (act === 'loadsel') {
        const ids = $$('.pick:checked', el).map((p) => p.value);
        if (!ids.length) return;
        await busy(a, async () => { for (const id of ids) await rpc('load_booking', { p_shipment: s.id, p_booking: id }); });
        toast(`${t('saved')} · ${ids.length}`); return rerender();
      }
      if (act === 'scanload') {
        let changed = false;
        const m = scanModal(t('scan_to_load'), async (text) => {
          const ref = refFromText(text);
          if (!ref) return { ok: false, msg: `${t('not_found')}: ${text}` };
          const bk = await run(from('bookings').select('id,ref,status').eq('ref', ref).maybeSingle());
          if (!bk) return { ok: false, msg: `${t('not_found')}: ${ref}` };
          try { await rpc('load_booking', { p_shipment: s.id, p_booking: bk.id }); changed = true; return { ok: true, msg: `${ref} ✓` }; } catch (err) { return { ok: false, msg: `${ref}: ${errText(err)}` }; }
        });
        const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (changed) rerender(); } });
        obs.observe(document.getElementById('modal-root'), { childList: true });
        return;
      }
      if (act === 'depart') { if (!(await confirmDialog(t('depart_confirm')))) return; await rpc('update_shipment_status', { p_shipment: s.id, p_status: 'departed', p_note: null }); toast(t('saved')); return rerender(); }
      if (act === 'arrive') { if (!(await confirmDialog(t('arrive_confirm')))) return; await rpc('update_shipment_status', { p_shipment: s.id, p_status: 'arrived', p_note: null }); toast(t('saved')); return rerender(); }
      if (act === 'complete') { if (!(await confirmDialog(t('mark_completed') + '?'))) return; await rpc('update_shipment_status', { p_shipment: s.id, p_status: 'completed', p_note: null }); toast(t('saved')); return rerender(); }
    } catch (err) { toast(errText(err), 'err'); }
  });
}
