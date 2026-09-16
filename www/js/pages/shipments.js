import { t } from '../i18n.js';
import { from, run, can, state, errText } from '../api.js';
import { icon, esc, num, fdate, shipBadge, modeTag, route, modal, toast, formData, checkRequired, busy, empty, $, $$ } from '../ui.js';

export function shipmentForm(s = {}) {
  const br = (sel) => state.branches.map((b) => `<option value="${b.code}" ${sel === b.code ? 'selected' : ''}>${esc(b.code)} · ${esc(b.name)}</option>`).join('');
  const locked = !!s.id;
  return `<form class="form" id="sh-form" novalidate>
    <div class="field"><label class="req">${esc(t('mode'))}</label><select class="input" name="mode" ${locked ? 'disabled' : ''}>
      <option value="sea" ${s.mode !== 'air' ? 'selected' : ''}>${esc(t('sea'))}</option><option value="air" ${s.mode === 'air' ? 'selected' : ''}>${esc(t('air'))}</option></select></div>
    <div class="field"><label>${esc(t('container_type'))}</label><select class="input" name="container_type">
      ${['20GP', '40GP', '40HC', 'LCL', 'AIR'].map((x) => `<option ${s.container_type === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div class="field"><label class="req">${esc(t('origin'))}</label><select class="input" name="origin_branch" ${locked ? 'disabled' : ''}>${br(s.origin_branch || 'DXB')}</select></div>
    <div class="field"><label class="req">${esc(t('destination'))}</label><select class="input" name="destination_branch" ${locked ? 'disabled' : ''}>${br(s.destination_branch || 'DAR')}</select></div>
    <div class="field"><label>${esc(t('container_no'))}</label><input class="input mono" name="container_no" value="${esc(s.container_no)}" placeholder="MSKU1234567"></div>
    <div class="field"><label>${esc(t('seal_no'))}</label><input class="input mono" name="seal_no" value="${esc(s.seal_no)}"></div>
    <div class="field"><label>${esc(t('carrier'))}</label><input class="input" name="carrier" value="${esc(s.carrier)}" placeholder="MSC / Maersk / Emirates SkyCargo"></div>
    <div class="field"><label>${esc(t('vessel_or_flight'))}</label><input class="input" name="vessel_or_flight" value="${esc(s.vessel_or_flight)}"></div>
    <div class="field"><label>${esc(t('bl_awb_no'))}</label><input class="input mono" name="bl_awb_no" value="${esc(s.bl_awb_no)}"></div>
    <div class="field"><label>${esc(t('capacity_cbm'))}</label><input class="input" type="number" step="0.1" min="0" name="capacity_cbm" value="${esc(s.capacity_cbm ?? '')}" placeholder="20GP≈28 · 40GP≈58 · 40HC≈68"></div>
    <div class="field"><label>${esc(t('etd'))}</label><input class="input" type="date" name="etd" value="${esc(s.etd || '')}"></div>
    <div class="field"><label>${esc(t('eta'))}</label><input class="input" type="date" name="eta" value="${esc(s.eta || '')}"></div>
    <div class="field full"><label>${esc(t('notes'))}</label><textarea class="input" name="notes">${esc(s.notes)}</textarea></div>
  </form>`;
}

export function openShipmentModal(s = null, onSaved) {
  modal({
    title: s ? `${t('edit')} · ${s.ref}` : t('new_container'), wide: true, body: shipmentForm(s || {}),
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="sh-save">${icon('check')}${esc(t('save'))}</button>`,
    onMount: (m) => {
      const f = m.el.querySelector('#sh-form');
      const cap = { '20GP': 28, '40GP': 58, '40HC': 68 };
      f.container_type.onchange = () => { if (!f.capacity_cbm.value && cap[f.container_type.value]) f.capacity_cbm.value = cap[f.container_type.value]; };
      f.mode.onchange = () => { if (f.mode.value === 'air') f.container_type.value = 'AIR'; };
      if (!s) f.container_type.onchange();
      m.el.querySelector('#sh-save').onclick = (e) => busy(e.currentTarget, async () => {
        if (!checkRequired(f)) return;
        const d = formData(f);
        if (!s && d.origin_branch === d.destination_branch) { toast(`${t('origin')} = ${t('destination')}`, 'err'); return; }
        if (s) { delete d.mode; delete d.origin_branch; delete d.destination_branch; }
        try {
          const row = s ? await run(from('shipments').update(d).eq('id', s.id).select().single()) : await run(from('shipments').insert(d).select().single());
          m.close(); toast(`${t('saved')} · ${row.ref}`); onSaved && onSaved(row);
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}

export async function render({ el, setTitle, query }) {
  setTitle(t('shipments'));
  let status = query.get('status') || '';
  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>${esc(t('shipments'))}</h1></div>
    ${can('shipment.write') ? `<button class="btn primary" id="new">${icon('plus')}${esc(t('new_container'))}</button>` : ''}
  </div>
  <div class="card">
    <div class="card-b" style="border-bottom:1px solid var(--line-2)"><div class="chips" id="chips">
      ${['', 'open', 'departed', 'arrived', 'completed'].map((s) => `<button class="chip" data-v="${s}">${esc(s ? t('sh_' + s) : t('all'))}</button>`).join('')}</div></div>
    <div id="list"></div>
  </div>`;

  const load = async () => {
    $$('#chips .chip', el).forEach((c) => c.classList.toggle('on', c.dataset.v === status));
    let q = from('v_shipments').select('*').order('created_at', { ascending: false }).limit(200);
    if (status) q = q.eq('status', status);
    const rows = await run(q);
    const util = (r) => r.capacity_cbm ? Math.round(r.total_cbm / r.capacity_cbm * 100) : null;
    $('#list', el).innerHTML = rows.length ? `
      <div class="table-wrap cards-m"><table class="t"><thead><tr><th>${esc(t('container'))}</th><th>${esc(t('route'))}</th><th>${esc(t('status'))}</th>
        <th class="num">${esc(t('bookings'))}</th><th class="num">CBM</th><th>${esc(t('utilisation'))}</th><th>${esc(t('eta'))}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="click" data-href="#/shipment/${r.id}">
        <td><b class="mono">${esc(r.container_no || r.ref)}</b><div class="muted small mono">${esc(r.ref)} · ${esc(r.container_type || '')}</div></td>
        <td class="nowrap">${modeTag(r.mode)}<div>${route(r.origin_branch, r.destination_branch)}</div></td>
        <td>${shipBadge(r.status)}</td><td class="num">${r.booking_count}</td><td class="num">${num(r.total_cbm, 2)}</td>
        <td style="min-width:110px">${util(r) !== null ? `<div class="progress ${util(r) > 100 ? 'over' : ''}"><div style="width:${Math.min(util(r), 100)}%"></div></div><div class="muted small">${util(r)}%</div>` : '—'}</td>
        <td class="nowrap">${fdate(r.eta)}</td></tr>`).join('')}</tbody></table></div>
      <div class="list-cards">${rows.map((r) => `<a class="lc" href="#/shipment/${r.id}"><div class="top"><b class="mono">${esc(r.container_no || r.ref)}</b>${shipBadge(r.status)}</div>
        <div class="sub">${esc(t(r.mode))} · ${esc(r.origin_branch)} → ${esc(r.destination_branch)} · ${r.booking_count} ${esc(t('bookings').toLowerCase())} · ${num(r.total_cbm, 2)} CBM</div>
        <div class="sub">${esc(t('eta'))} ${fdate(r.eta)}</div></a>`).join('')}</div>` : empty(t('nothing_here'), 'container');
  };

  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
  $('#chips', el).onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; status = c.dataset.v; load(); };
  const nb = $('#new', el);
  if (nb) nb.onclick = () => openShipmentModal(null, (row) => { location.hash = `#/shipment/${row.id}`; });
  await load();
  if (query.get('new') && nb) nb.click();
}
