import { t } from '../i18n.js';
import { from, run, rpc, can, state, errText } from '../api.js';
import { icon, esc, usd, toast, busy, $, $$ } from '../ui.js';
import { costAccountOptions, shipmentOptions, fxDefault } from '../acc.js';
import { supplierModal } from './acc-suppliers.js';

export async function render({ el, setTitle, query }) {
  setTitle(t('acc_new_bill'));
  if (!can('acc.write')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  const [suppliers, shipOpts, accOpts] = await Promise.all([
    run(from('suppliers').select('*').eq('active', true).order('name')), shipmentOptions(query.get('shipment') || ''), costAccountOptions(''),
  ]);
  const presetShip = query.get('shipment') || '';
  const home = state.profile.branch_code || 'DXB';
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('acc_new_bill'))}</h1><p>${esc(t('acc_bill_hint'))}</p></div></div>
  <form id="bf" class="split" novalidate>
    <div class="stack">
      <div class="card"><div class="card-b form">
        <div class="field"><label class="req">${esc(t('acc_supplier'))}</label><select class="input" name="supplier_id" required><option value="">—</option>
          ${suppliers.map((s) => `<option value="${s.id}" data-acc="${esc(s.default_account_code || '')}">${esc(s.name)}</option>`).join('')}</select>
          <div class="hint"><a href="javascript:void 0" id="newsup">+ ${esc(t('acc_new_supplier'))}</a></div></div>
        <div class="field"><label>${esc(t('acc_supplier_invoice'))}</label><input class="input" name="supplier_invoice_no"></div>
        <div class="field"><label class="req">${esc(t('branch'))}</label><select class="input" name="branch_code">${state.branches.map((b) => `<option value="${b.code}" ${b.code === home ? 'selected' : ''}>${esc(b.code)} · ${esc(b.name)} (${esc(b.company_code || '')})</option>`).join('')}</select>
          <div class="hint">${esc(t('acc_branch_company_hint'))}</div></div>
        <div class="field"><label class="req">${esc(t('date'))}</label><input class="input" type="date" name="bill_date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>${esc(t('acc_due_date'))}</label><input class="input" type="date" name="due_date"></div>
        <div class="field"><label class="req">${esc(t('currency'))}</label><select class="input" name="currency"><option>USD</option><option>AED</option><option>TZS</option></select></div>
        <div class="field"><label>${esc(t('fx_rate'))}</label><input class="input" type="number" step="0.0001" name="fx_rate" value="1" readonly></div>
        <div class="field full"><label>${esc(t('notes'))}</label><input class="input" name="notes"></div>
      </div></div>
      <div class="card">
        <div class="card-h"><h2>${esc(t('acc_lines'))}</h2><button type="button" class="btn sm" id="add">${icon('plus')}${esc(t('add_line'))}</button></div>
        <div class="card-b" style="padding:10px"><div class="table-wrap"><table class="t" id="lines"><thead><tr>
          <th>${esc(t('acc_account'))}</th><th>${esc(t('description'))}</th><th>${esc(t('acc_link_container'))}</th><th class="num">${esc(t('amount'))}</th><th></th></tr></thead><tbody></tbody></table></div>
          <p class="muted small" style="margin:8px 6px 0">${esc(t('acc_ic_hint'))}</p></div>
      </div>
    </div>
    <div class="card" style="position:sticky;top:76px"><div class="card-h"><h2>${esc(t('total'))}</h2></div>
      <div class="card-b stack" style="gap:10px">
        <div class="row" style="justify-content:space-between"><span class="muted">${esc(t('amount'))}</span><b class="num" id="tt" style="font-size:20px">0</b></div>
        <div class="row" style="justify-content:space-between"><span class="muted">USD</span><b class="num" id="tu">$0.00</b></div>
        <div class="callout info">${icon('info')}<div class="small">Dr ${esc(t('acc_cost_accounts'))} · Cr ${esc(t('acc_payable'))}</div></div>
        <button class="btn primary" type="submit" style="min-height:46px">${icon('check')}${esc(t('save'))}</button>
      </div></div>
  </form>`;
  const f = $('#bf', el); const tb = $('#lines tbody', el);
  const addLine = (v = {}) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><select class="input sm" data-k="account_code" style="min-width:210px">${accOpts}</select></td>
      <td><input class="input sm" data-k="description" style="min-width:160px" value="${esc(v.description || '')}"></td>
      <td><select class="input sm" data-k="shipment_id" style="min-width:150px">${shipOpts}</select></td>
      <td><input class="input sm num" type="number" step="0.01" min="0" data-k="amount" style="width:120px" inputmode="decimal"></td>
      <td><button type="button" class="icon-btn" data-rm>${icon('trash')}</button></td>`;
    tb.appendChild(tr);
    if (v.account_code) tr.querySelector('[data-k=account_code]').value = v.account_code;
    tr.querySelector('[data-k=shipment_id]').value = v.shipment_id ?? presetShip;
    calc();
  };
  const read = () => $$('tr', tb).map((tr) => { const o = {}; tr.querySelectorAll('[data-k]').forEach((i) => { o[i.dataset.k] = i.value; }); return o; });
  const calc = () => {
    const tot = read().reduce((a, l) => a + Number(l.amount || 0), 0);
    $('#tt', el).textContent = `${f.currency.value} ${tot.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    $('#tu', el).textContent = usd(tot / Number(f.fx_rate.value || 1));
  };
  f.currency.onchange = () => { f.fx_rate.value = fxDefault(f.currency.value); f.fx_rate.readOnly = f.currency.value === 'USD'; calc(); };
  f.supplier_id.onchange = () => { const acc = f.supplier_id.selectedOptions[0]?.dataset.acc; if (acc) $$('[data-k=account_code]', tb).forEach((s) => { if (!s.dataset.touched) s.value = acc; }); };
  $('#newsup', el).onclick = () => supplierModal(null, (sp) => {
    if (!sp) return;
    f.supplier_id.insertAdjacentHTML('beforeend', `<option value="${sp.id}" data-acc="${esc(sp.default_account_code || '')}">${esc(sp.name)}</option>`);
    f.supplier_id.value = sp.id; f.supplier_id.onchange();
  });
  tb.addEventListener('change', (e) => { if (e.target.dataset.k === 'account_code') e.target.dataset.touched = '1'; });
  tb.addEventListener('input', calc); f.fx_rate.oninput = calc;
  tb.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { e.target.closest('tr').remove(); calc(); } });
  $('#add', el).onclick = () => addLine();
  addLine();
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector('button[type=submit]'), async () => {
      const lines = read().filter((l) => Number(l.amount) > 0);
      if (!f.supplier_id.value || !lines.length) { toast(t('required_fields'), 'err'); return; }
      try {
        const r = await rpc('acc_create_bill', { p: {
          supplier_id: f.supplier_id.value, supplier_invoice_no: f.supplier_invoice_no.value, branch_code: f.branch_code.value,
          bill_date: f.bill_date.value, due_date: f.due_date.value, currency: f.currency.value, fx_rate: Number(f.fx_rate.value), notes: f.notes.value,
          lines: lines.map((l) => ({ ...l, amount: Number(l.amount) })) } });
        toast(`${t('saved')} · ${r.ref}`);
        location.hash = `#/acc/bill/${r.id}`;
      } catch (err) { toast(errText(err), 'err'); }
    });
  };
}
