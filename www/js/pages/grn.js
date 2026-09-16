import { t } from '../i18n.js';
import { from, run, rpc, can, sb, state, errText, photoBucket, catName } from '../api.js';
import { icon, esc, usd, num, toast, busy, confirmDialog, modal, $, $$ } from '../ui.js';

export async function render({ el, params, setTitle }) {
  const b = await run(from('v_bookings').select('*').eq('id', params[0]).single());
  setTitle(`GRN · ${b.ref}`);
  if (!can('grn.record')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(errText({ message: 'NOT_ALLOWED:' }))}</div></div>`; return; }
  if (b.status !== 'booked') {
    el.innerHTML = `<div class="card card-b stack"><div class="callout ${b.status === 'pending_deposit' ? 'danger' : 'info'}">${icon('lock')}<div>${esc(b.status === 'pending_deposit' ? t('gate_deposit') : `${b.ref}: ${t('st_' + b.status)}`)}</div></div>
      <div><a class="btn" href="#/booking/${b.id}">${icon('arrowLeft')}${esc(t('back'))}</a></div></div>`;
    return;
  }
  const s = state.settings;
  const cat = state.categories.find((c) => c.id === b.category_id);

  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><div class="muted">${esc(t('record_grn'))}</div><h1 class="mono">${esc(b.ref)}</h1>
      <p>${esc(b.customer_name)} · ${esc(catName(b) || '')} · ${esc(b.mode.toUpperCase())} ${esc(b.origin_branch)} → ${esc(b.destination_branch)}</p></div>
  </div>
  <div class="split">
    <div class="stack">
      <div class="card">
        <div class="card-h"><h2>${esc(t('measurements'))}</h2><button class="btn sm" id="add-line">${icon('plus')}${esc(t('add_line'))}</button></div>
        <div class="card-b" style="padding:10px">
          <div class="muted small" style="padding:0 6px 8px">${esc(t('cargo_description'))}: ${esc(b.description)} · ≈ ${num(b.est_pieces, 0)} pcs / ${num(b.est_cbm, 2)} CBM / ${num(b.est_kg, 1)} kg</div>
          <div class="table-wrap"><table class="t" id="lines"><thead><tr>
            <th>${esc(t('pieces'))}</th><th>${esc(t('length_cm'))}</th><th>${esc(t('width_cm'))}</th><th>${esc(t('height_cm'))}</th><th>${esc(t('weight_kg'))}</th><th>${esc(t('packaging'))}</th><th class="num">CBM</th><th></th></tr></thead>
            <tbody></tbody></table></div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h2>${esc(t('condition'))}</h2></div>
        <div class="card-b form">
          <div class="field full"><div class="seg" id="cond">${['good', 'damaged', 'partial'].map((c, i) => `<button type="button" data-v="${c}" class="${i === 0 ? 'on' : ''}">${esc(t('c_' + c))}</button>`).join('')}</div></div>
          <div class="field full"><label>${esc(t('notes'))}</label><textarea class="input" id="cond-notes" placeholder="e.g. 2 cartons wet on arrival, re-taped"></textarea></div>
          ${photoBucket() ? `<div class="field full"><label>${esc(t('photos'))} <span class="muted">(${esc(t('optional'))})</span></label><input class="input" type="file" id="photos" accept="image/*" capture="environment" multiple></div>` : ''}
        </div>
      </div>
    </div>
    <div class="card" style="position:sticky;top:76px">
      <div class="card-h"><h2>${esc(t('total'))}</h2></div>
      <div class="card-b stack" style="gap:10px">
        <div class="row" style="justify-content:space-between"><span class="muted">${esc(t('pieces'))}</span><b class="num" id="t-pcs">0</b></div>
        <div class="row" style="justify-content:space-between"><span class="muted">CBM</span><b class="num" id="t-cbm" style="font-size:20px">0.000</b></div>
        <div class="row" style="justify-content:space-between"><span class="muted">${esc(t('actual_kg'))}</span><b class="num" id="t-kg">0</b></div>
        <div class="row" style="justify-content:space-between"><span class="muted">${esc(t('volumetric_kg'))}</span><b class="num" id="t-vol">0</b></div>
        ${b.mode === 'air' ? `<div class="row" style="justify-content:space-between"><span class="muted">${esc(t('chargeable_kg'))}</span><b class="num" id="t-chg">0</b></div>` : ''}
        <div style="border-top:1px solid var(--line);padding-top:10px" class="row"><span class="muted" style="flex:1">${esc(t('est_freight'))}</span><b class="num" id="t-fr" style="font-size:22px">$0.00</b></div>
        <div class="muted small">${cat ? (b.mode === 'sea' ? `${usd(cat.sea_rate_cbm)} / CBM · min ${num(s.min_cbm_sea, 2)} CBM · min ${usd(cat.min_charge_sea)}` : `${usd(cat.air_rate_kg)} / kg · min ${usd(cat.min_charge_air)}`) : ''}</div>
        <div class="callout warn">${icon('lock')}<div class="small">${esc(t('grn_confirm'))}</div></div>
        <button class="btn primary" id="save" style="min-height:46px">${icon('check')}${esc(t('record_grn'))}</button>
      </div>
    </div>
  </div>`;

  const tbody = $('#lines tbody', el);
  const addLine = (v = {}) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="input sm num" style="width:64px" type="number" min="1" step="1" data-k="pieces" value="${v.pieces ?? 1}" inputmode="numeric"></td>
      <td><input class="input sm num" style="width:72px" type="number" min="0" step="0.1" data-k="length_cm" value="${v.length_cm ?? ''}" inputmode="decimal"></td>
      <td><input class="input sm num" style="width:72px" type="number" min="0" step="0.1" data-k="width_cm" value="${v.width_cm ?? ''}" inputmode="decimal"></td>
      <td><input class="input sm num" style="width:72px" type="number" min="0" step="0.1" data-k="height_cm" value="${v.height_cm ?? ''}" inputmode="decimal"></td>
      <td><input class="input sm num" style="width:80px" type="number" min="0" step="0.1" data-k="weight_kg" value="${v.weight_kg ?? ''}" inputmode="decimal"></td>
      <td><select class="input sm" data-k="packaging" style="width:110px">${['Carton', 'Bale', 'Pallet', 'Crate', 'Sack', 'Loose'].map((p) => `<option>${p}</option>`).join('')}</select></td>
      <td class="num" data-cbm>0</td>
      <td><button class="icon-btn" data-rm title="×">${icon('trash')}</button></td>`;
    tbody.appendChild(tr);
    calc();
    tr.querySelector('[data-k=length_cm]').focus();
  };

  const readLines = () => $$('tr', tbody).map((tr) => {
    const o = {}; tr.querySelectorAll('[data-k]').forEach((i) => { o[i.dataset.k] = i.dataset.k === 'packaging' ? i.value : Number(i.value || 0); });
    return o;
  });

  const calc = () => {
    let pcs = 0, cbm = 0, kg = 0;
    $$('tr', tbody).forEach((tr, i) => {
      const l = readLines()[i];
      const c = l.pieces * l.length_cm * l.width_cm * l.height_cm / 1e6;
      tr.querySelector('[data-cbm]').textContent = c.toFixed(4);
      pcs += l.pieces; cbm += c; kg += l.weight_kg;
    });
    cbm = Math.round(cbm * 1000) / 1000;
    const vol = cbm * 1e6 / Number(s.air_volumetric_divisor);
    const chg = Math.max(kg, vol);
    let fr = 0;
    if (cat) fr = b.mode === 'sea' ? Math.max(Math.max(cbm, Number(s.min_cbm_sea)) * cat.sea_rate_cbm, cat.min_charge_sea) : Math.max(chg * cat.air_rate_kg, cat.min_charge_air);
    $('#t-pcs', el).textContent = pcs; $('#t-cbm', el).textContent = cbm.toFixed(3); $('#t-kg', el).textContent = num(kg, 1);
    $('#t-vol', el).textContent = num(vol, 1); if ($('#t-chg', el)) $('#t-chg', el).textContent = num(chg, 1);
    $('#t-fr', el).textContent = usd(fr);
    return { pcs, cbm, kg };
  };

  tbody.addEventListener('input', calc);
  tbody.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { e.target.closest('tr').remove(); calc(); } });
  $('#add-line', el).onclick = () => addLine();
  $('#cond', el).onclick = (e) => { const x = e.target.closest('button'); if (x) $$('#cond button', el).forEach((y) => y.classList.toggle('on', y === x)); };
  addLine({ pieces: b.est_pieces || 1 });

  $('#save', el).onclick = (e) => {
    const lines = readLines();
    const bad = lines.some((l) => !(l.pieces > 0 && l.length_cm > 0 && l.width_cm > 0 && l.height_cm > 0));
    if (!lines.length || bad) { toast(t('required_fields'), 'err'); return; }
    const tot = calc();
    confirmDialog(`${t('grn_confirm')}\n${tot.pcs} pcs · ${tot.cbm.toFixed(3)} CBM · ${num(tot.kg, 1)} kg`).then((ok) => {
      if (!ok) return;
      busy(e.target.closest('button'), async () => {
        try {
          const condition = $('#cond button.on', el).dataset.v;
          const photos = await uploadPhotos(b);
          const r = await rpc('record_grn', { p_booking: b.id, p_lines: lines, p_condition: condition, p_notes: $('#cond-notes', el).value || null, p_photos: photos });
          toast(`${t('grn_saved')} · ${r.grn_ref}`);
          modal({
            title: r.grn_ref,
            body: `<div class="callout ok">${icon('check')}<div><b>${esc(t('grn_saved'))}</b><br>${r.pieces} pcs · ${num(r.cbm, 3)} CBM · ${num(r.kg, 1)} kg<br>${esc(t('invoice'))} ${esc(r.invoice_ref)}: <b>${usd(r.freight)}</b></div></div>`,
            foot: `<a class="btn" data-close href="#/booking/${b.id}">${esc(t('booking'))}</a><a class="btn primary" data-close href="#/doc/labels/${b.id}">${icon('tag')}${esc(t('print_labels'))}</a>`,
          });
          location.hash = `#/booking/${b.id}`;
        } catch (err) { toast(errText(err), 'err'); }
      });
    });
  };

  async function uploadPhotos(bk) {
    const input = $('#photos', el);
    if (!input || !input.files.length) return [];
    const out = [];
    for (const file of input.files) {
      const path = `${bk.ref}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
      const { error } = await sb.storage.from(photoBucket()).upload(path, file, { upsert: false });
      if (error) { toast(`${t('photos')}: ${errText(error)}`, 'err'); continue; }
      out.push(path);
    }
    return out;
  }
}
