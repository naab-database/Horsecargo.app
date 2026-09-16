import { t, getLang } from '../i18n.js';
import { from, run, can, state, errText, estimateFreight, depositFor } from '../api.js';
import { icon, esc, usd, toast, formData, checkRequired, busy, debounce, $, $$ } from '../ui.js';
import { openCustomerModal } from './customers.js';

export async function render({ el, setTitle, query }) {
  setTitle(t('new_booking'));
  if (!can('booking.create')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(errText({ message: 'NOT_ALLOWED:' }))}</div></div>`; return; }

  // edit mode: ?edit=<booking id> (only while awaiting deposit — the database freezes terms after that)
  const editId = query.get('edit');
  const existing = editId ? await run(from('v_bookings').select('*').eq('id', editId).single()) : null;
  let customer = null;
  const preId = existing?.customer_id || query.get('customer');
  if (preId) customer = await run(from('customers').select('*').eq('id', preId).maybeSingle());

  const home = state.profile.branch_code || 'DXB';
  const b = existing || { mode: 'sea', origin_branch: home === 'DXB' ? 'DXB' : home, destination_branch: home === 'DXB' ? 'DAR' : 'DXB', est_pieces: 1, est_cbm: 0, est_kg: 0 };
  const cats = state.categories.filter((c) => c.active);
  const catLabel = (c) => (getLang() === 'sw' && c.name_sw) ? c.name_sw : c.name;
  const brOpts = (sel) => state.branches.map((x) => `<option value="${x.code}" ${sel === x.code ? 'selected' : ''}>${esc(x.code)} · ${esc(x.name)}</option>`).join('');

  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(existing ? `${t('edit_booking')} · ${existing.ref}` : t('new_booking'))}</h1></div></div>
  <form id="bk" novalidate class="split">
    <div class="stack">
      <div class="card">
        <div class="card-h"><h2>1 · ${esc(t('shipper'))}</h2></div>
        <div class="card-b">
          <div id="cust-picked"></div>
          <div id="cust-search-wrap">
            <div class="row" style="flex-wrap:nowrap">
              <div class="search" style="flex:1">${icon('search')}<input class="input" id="cust-q" placeholder="${esc(t('pick_customer'))}" autocomplete="off"></div>
              ${can('customer.write') ? `<button type="button" class="btn" id="cust-new">${icon('plus')}<span class="hide-m">${esc(t('new_customer'))}</span></button>` : ''}
            </div>
            <div id="cust-results" class="stack" style="gap:6px;margin-top:8px"></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h2>2 · ${esc(t('cargo'))}</h2></div>
        <div class="card-b form">
          <div class="field full"><label>${esc(t('mode'))}</label>
            <div class="seg" id="mode-seg"><button type="button" data-v="sea">${icon('ship')}${esc(t('sea'))}</button><button type="button" data-v="air">${icon('plane')}${esc(t('air'))}</button></div>
            <input type="hidden" name="mode" value="${esc(b.mode)}"></div>
          <div class="field"><label class="req">${esc(t('origin'))}</label><select class="input" name="origin_branch" required>${brOpts(b.origin_branch)}</select></div>
          <div class="field"><label class="req">${esc(t('destination'))}</label><select class="input" name="destination_branch" required>${brOpts(b.destination_branch)}</select></div>
          <div class="field full"><label class="req">${esc(t('cargo_category'))}</label><select class="input" name="category_id" required>
            <option value="">—</option>${cats.map((c) => `<option value="${c.id}" ${b.category_id === c.id ? 'selected' : ''}>${esc(catLabel(c))}</option>`).join('')}</select>
            <div id="cat-note" style="margin-top:8px"></div></div>
          <div class="field full"><label class="req">${esc(t('cargo_description'))}</label><textarea class="input" name="description" required placeholder="e.g. 12 cartons household goods, 1 fridge">${esc(b.description)}</textarea></div>
          <div class="field"><label>${esc(t('est_pieces'))}</label><input class="input" type="number" min="1" step="1" name="est_pieces" value="${esc(b.est_pieces)}"></div>
          <div class="field"><label>${esc(t('est_cbm'))}</label><input class="input" type="number" min="0" step="0.01" name="est_cbm" value="${esc(b.est_cbm)}"></div>
          <div class="field"><label>${esc(t('est_kg'))}</label><input class="input" type="number" min="0" step="0.1" name="est_kg" value="${esc(b.est_kg)}"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h2>3 · ${esc(t('consignee'))}</h2><button type="button" class="btn sm ghost" id="same-as">= ${esc(t('customer'))}</button></div>
        <div class="card-b form">
          <div class="field"><label class="req">${esc(t('consignee_name'))}</label><input class="input" name="consignee_name" required value="${esc(b.consignee_name)}"></div>
          <div class="field"><label class="req">${esc(t('consignee_phone'))}</label><input class="input" type="tel" name="consignee_phone" required value="${esc(b.consignee_phone)}"></div>
          <div class="field"><label>${esc(t('consignee_address'))}</label><input class="input" name="consignee_address" value="${esc(b.consignee_address)}"></div>
          <div class="field"><label>${esc(t('consignee_tin'))}</label><input class="input" name="consignee_tin" value="${esc(b.consignee_tin)}"></div>
          <div class="field full"><label>${esc(t('notes'))}</label><textarea class="input" name="notes">${esc(b.notes)}</textarea></div>
        </div>
      </div>
    </div>

    <div class="card" style="position:sticky;top:76px">
      <div class="card-h"><h2>${esc(t('quote'))}</h2></div>
      <div class="card-b stack" style="gap:12px">
        <div class="row" style="justify-content:space-between"><span class="muted">${esc(t('quote'))}</span><b class="num" id="q-quote" style="font-size:20px">$0.00</b></div>
        <div class="row" style="justify-content:space-between"><span class="muted">${esc(t('deposit_required'))} <span id="q-pct"></span></span><b class="num" id="q-dep" style="font-size:20px;color:var(--brand)">$0.00</b></div>
        <div class="callout info">${icon('info')}<div class="small">${esc(t('quote_note'))}</div></div>
        <div class="callout warn">${icon('lock')}<div class="small">${esc(t('gate_deposit'))}</div></div>
        <button class="btn primary" type="submit" id="save" style="min-height:46px">${icon('check')}${esc(existing ? t('save') : t('new_booking'))}</button>
      </div>
    </div>
  </form>`;

  const form = $('#bk', el);
  const setMode = (m) => { form.mode.value = m; $$('#mode-seg button', el).forEach((x) => x.classList.toggle('on', x.dataset.v === m)); calc(); };

  const calc = () => {
    const d = formData(form);
    const cat = state.categories.find((c) => c.id === Number(d.category_id));
    const note = $('#cat-note', el);
    note.innerHTML = cat?.restricted ? `<div class="callout danger">${icon('alert')}<div>${esc(t('restricted_cargo'))}</div></div>`
      : cat?.permit_note ? `<div class="callout warn">${icon('info')}<div><b>${esc(t('permit_needed'))}:</b> ${esc(cat.permit_note)}</div></div>` : '';
    $('#save', el).disabled = !!cat?.restricted;
    const qv = estimateFreight(d.mode, d.category_id, d.est_cbm, d.est_kg);
    $('#q-quote', el).textContent = usd(qv);
    $('#q-dep', el).textContent = usd(depositFor(d.mode, qv));
    $('#q-pct', el).textContent = `(${d.mode === 'sea' ? state.settings.deposit_pct_sea : state.settings.deposit_pct_air}%)`;
  };

  const drawCustomer = () => {
    $('#cust-picked', el).innerHTML = customer ? `<div class="callout ok" style="align-items:center">${icon('user')}<div style="flex:1"><b>${esc(customer.name)}</b>
      <div class="small mono">${esc(customer.code)} · ${esc(customer.phone)}</div></div>${existing && existing.status !== 'pending_deposit' ? '' : `<button type="button" class="btn sm" id="cust-change">${esc(t('edit'))}</button>`}</div>` : '';
    $('#cust-search-wrap', el).classList.toggle('hidden', !!customer);
    const ch = $('#cust-change', el); if (ch) ch.onclick = () => { customer = null; drawCustomer(); $('#cust-q', el).focus(); };
  };

  $('#cust-q', el).addEventListener('input', debounce(async (e) => {
    const s = e.target.value.trim().replace(/[,()]/g, ' ');
    const box = $('#cust-results', el);
    if (s.length < 2) { box.innerHTML = ''; return; }
    const res = await run(from('customers').select('*').or(`name.ilike.*${s}*,phone.ilike.*${s}*,code.ilike.*${s}*,company.ilike.*${s}*`).eq('active', true).limit(8));
    box.innerHTML = res.length ? res.map((c) => `<button type="button" class="btn" style="justify-content:flex-start;text-align:left;height:auto;padding:8px 12px" data-cid="${c.id}">
      <div><b>${esc(c.name)}</b><div class="small muted mono">${esc(c.code)} · ${esc(c.phone)}${c.company ? ' · ' + esc(c.company) : ''}</div></div></button>`).join('')
      : `<div class="muted small">${esc(t('not_found'))}</div>`;
    box.querySelectorAll('[data-cid]').forEach((btn) => { btn.onclick = () => { customer = res.find((c) => c.id === btn.dataset.cid); drawCustomer(); }; });
  }, 250));
  const cn = $('#cust-new', el);
  if (cn) cn.onclick = () => openCustomerModal(null, (row) => { customer = row; drawCustomer(); });
  $('#same-as', el).onclick = () => { if (!customer) return; form.consignee_name.value = customer.name; form.consignee_phone.value = customer.phone; form.consignee_address.value = customer.address || ''; form.consignee_tin.value = customer.tin || ''; };
  $('#mode-seg', el).onclick = (e) => { const x = e.target.closest('button'); if (x) setMode(x.dataset.v); };
  form.addEventListener('input', calc);
  form.addEventListener('change', calc);

  form.onsubmit = (e) => {
    e.preventDefault();
    busy($('#save', el), async () => {
      if (!customer) { toast(t('pick_customer'), 'err'); $('#cust-q', el)?.focus(); return; }
      if (!checkRequired(form)) return;
      const d = formData(form);
      if (d.origin_branch === d.destination_branch) { toast(`${t('origin')} = ${t('destination')}`, 'err'); return; }
      const payload = {
        customer_id: customer.id, mode: d.mode, origin_branch: d.origin_branch, destination_branch: d.destination_branch,
        category_id: Number(d.category_id), description: d.description, est_pieces: d.est_pieces || 1, est_cbm: d.est_cbm || 0, est_kg: d.est_kg || 0,
        consignee_name: d.consignee_name, consignee_phone: d.consignee_phone, consignee_address: d.consignee_address, consignee_tin: d.consignee_tin, notes: d.notes,
      };
      try {
        const row = existing
          ? await run(from('bookings').update(payload).eq('id', existing.id).select().single())
          : await run(from('bookings').insert(payload).select().single());
        toast(`${existing ? t('saved') : t('booking_created')} · ${row.ref}`);
        location.hash = `#/booking/${row.id}`;
      } catch (err) { toast(errText(err), 'err'); }
    });
  };

  drawCustomer();
  setMode(b.mode);
}
