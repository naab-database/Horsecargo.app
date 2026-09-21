import { t } from '../i18n.js';
import { from, run, can, errText } from '../api.js';
import { icon, esc, modal, toast, busy, empty, $, toCSV, downloadCSV } from '../ui.js';
import { costAccountOptions } from '../acc.js';

export const SUP_KINDS = ['shipping_line', 'airline', 'clearing_agent', 'transport', 'port', 'government', 'landlord', 'utility', 'staff', 'other'];

export async function render({ el, setTitle, query }) {
  setTitle(t('acc_suppliers'));
  if (!can('acc.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('acc_suppliers'))}</h1><p>${esc(t('acc_suppliers_sub'))}</p></div>
    <div class="row"><input class="input" id="q" placeholder="${esc(t('search'))}" style="width:200px"><button class="btn hide-m" id="csv">${icon('download')}${esc(t('export_csv'))}</button>
    ${can('acc.write') ? `<button class="btn primary" id="new">${icon('plus')}${esc(t('acc_new_supplier'))}</button>` : ''}</div></div>
  <div class="card" id="list"></div>`;
  let rows = []; let bal = {};
  const load = async () => {
    const [s, b] = await Promise.all([
      run(from('suppliers').select('*').order('name')),
      run(from('v_bills').select('supplier_id,balance_usd,status').in('status', ['open', 'part_paid'])),
    ]);
    rows = s; bal = {};
    b.forEach((x) => { bal[x.supplier_id] = (bal[x.supplier_id] || 0) + Number(x.balance_usd); });
    draw();
  };
  const draw = () => {
    const q = $('#q', el).value.toLowerCase();
    const list = rows.filter((s) => !q || `${s.code} ${s.name} ${s.phone || ''} ${s.tin || ''}`.toLowerCase().includes(q));
    $('#list', el).innerHTML = list.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('name'))}</th><th class="hide-m">${esc(t('acc_kind'))}</th><th class="hide-m">${esc(t('phone'))}</th><th class="hide-m">TIN</th><th class="num">${esc(t('acc_payable'))}</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr style="${s.active ? '' : 'opacity:.5'}"><td><b>${esc(s.name)}</b><div class="muted small mono">${esc(s.code)}${s.default_account_code ? ' · ' + esc(s.default_account_code) : ''}</div></td>
        <td class="hide-m">${esc(t('sk_' + s.kind))}</td><td class="hide-m">${esc(s.phone || '—')}</td><td class="hide-m mono">${esc(s.tin || '—')}</td>
        <td class="num" style="${bal[s.id] > 0 ? 'color:var(--red);font-weight:700' : ''}">${bal[s.id] ? '$' + bal[s.id].toFixed(2) : '—'}</td>
        <td class="right nowrap">${bal[s.id] ? `<a class="btn sm" href="#/acc/bills?status=open">${esc(t('acc_bills'))}</a>` : ''}
          ${can('acc.write') ? `<button class="icon-btn" data-edit="${s.id}" title="${esc(t('edit'))}">${icon('gear')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty(t('nothing_here'), 'truck');
  };
  $('#q', el).oninput = draw;
  $('#csv', el).onclick = () => downloadCSV('horse-cargo-suppliers.csv', toCSV(rows.map((s) => ({ ...s, payable: bal[s.id] || 0 })), [
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Kind', key: 'kind' }, { label: 'Phone', key: 'phone' }, { label: 'Email', key: 'email' },
    { label: 'TIN', key: 'tin' }, { label: 'Default account', key: 'default_account_code' }, { label: 'Payable USD', key: 'payable' }, { label: 'Active', key: 'active' }]));
  if ($('#new', el)) $('#new', el).onclick = () => supplierModal(null, load);
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) supplierModal(rows.find((s) => s.id === b.dataset.edit), load); });
  await load();
  if (query.get('new') === '1' && can('acc.write')) supplierModal(null, load);
}

export async function supplierModal(s, done) {
  const accOpts = await costAccountOptions('', s?.default_account_code || '');
  modal({
    title: s ? s.name : t('acc_new_supplier'),
    body: `<form class="form" id="sf" novalidate>
      <div class="field full"><label class="req">${esc(t('name'))}</label><input class="input" name="name" value="${esc(s?.name || '')}" required></div>
      <div class="field"><label>${esc(t('acc_kind'))}</label><select class="input" name="kind">${SUP_KINDS.map((k) => `<option value="${k}" ${(s?.kind || 'other') === k ? 'selected' : ''}>${esc(t('sk_' + k))}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(t('acc_default_account'))}</label><select class="input" name="default_account_code"><option value="">—</option>${accOpts}</select></div>
      <div class="field"><label>${esc(t('phone'))}</label><input class="input" name="phone" type="tel" value="${esc(s?.phone || '')}"></div>
      <div class="field"><label>${esc(t('email'))}</label><input class="input" name="email" type="email" value="${esc(s?.email || '')}"></div>
      <div class="field"><label>TIN</label><input class="input" name="tin" value="${esc(s?.tin || '')}"></div>
      <div class="field"><label>${esc(t('address'))}</label><input class="input" name="address" value="${esc(s?.address || '')}"></div>
      <div class="field full"><label>${esc(t('notes'))}</label><textarea class="input" name="notes" rows="2">${esc(s?.notes || '')}</textarea></div>
      ${s ? `<div class="field full"><label><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> ${esc(t('active'))}</label></div>` : ''}
    </form>`,
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="ss">${icon('check')}${esc(t('save'))}</button>`,
    onMount: (m) => {
      m.el.querySelector('#ss').onclick = (ev) => busy(ev.currentTarget, async () => {
        const f = m.el.querySelector('#sf');
        if (!f.name.value.trim()) { toast(t('required_fields'), 'err'); return; }
        const row = { name: f.name.value.trim(), kind: f.kind.value, default_account_code: f.default_account_code.value || null, phone: f.phone.value || null,
          email: f.email.value || null, tin: f.tin.value || null, address: f.address.value || null, notes: f.notes.value || null };
        if (s) row.active = f.active.checked;
        try {
          const saved = s ? await run(from('suppliers').update(row).eq('id', s.id).select().single()) : await run(from('suppliers').insert(row).select().single());
          m.close(); toast(t('saved')); done && done(saved);
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}
