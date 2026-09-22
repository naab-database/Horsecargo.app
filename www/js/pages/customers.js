import { t } from '../i18n.js';
import { from, run, can, state, errText } from '../api.js';
import { icon, esc, usd, modal, toast, formData, checkRequired, busy, debounce, empty, $ } from '../ui.js';

const PAGE = 30;

export function customerForm(c = {}) {
  const br = state.branches.map((b) => `<option value="${b.code}" ${c.branch_code === b.code ? 'selected' : ''}>${esc(b.code)} · ${esc(b.name)}</option>`).join('');
  return `<form class="form" id="cust-form" novalidate>
    <div class="field"><label class="req">${esc(t('name'))}</label><input class="input" name="name" required value="${esc(c.name)}"></div>
    <div class="field"><label>${esc(t('company'))}</label><input class="input" name="company" value="${esc(c.company)}"></div>
    <div class="field"><label class="req">${esc(t('phone'))}</label><input class="input" name="phone" type="tel" required value="${esc(c.phone)}" placeholder="+255…"></div>
    <div class="field"><label>${esc(t('phone2'))}</label><input class="input" name="phone2" type="tel" value="${esc(c.phone2)}"></div>
    <div class="field"><label>${esc(t('email'))}</label><input class="input" name="email" type="email" value="${esc(c.email)}"></div>
    <div class="field"><label>${esc(t('tin'))}</label><input class="input" name="tin" value="${esc(c.tin)}"></div>
    <div class="field"><label>${esc(t('id_type'))}</label><select class="input" name="id_type">
      ${['', 'NIDA', 'Passport', 'Emirates ID', 'Driving licence', 'Voter ID'].map((x) => `<option ${c.id_type === x ? 'selected' : ''} value="${x}">${x || '—'}</option>`).join('')}</select></div>
    <div class="field"><label>${esc(t('id_number'))}</label><input class="input" name="id_number" value="${esc(c.id_number)}"></div>
    <div class="field"><label>${esc(t('city'))}</label><input class="input" name="city" value="${esc(c.city)}"></div>
    <div class="field"><label>${esc(t('country'))}</label><input class="input" name="country" value="${esc(c.country)}"></div>
    <div class="field"><label>${esc(t('branch'))}</label><select class="input" name="branch_code"><option value="">—</option>${br}</select></div>
    <div class="field"><label>${esc(t('credit_limit'))}</label><input class="input" name="credit_limit" type="number" min="0" step="0.01" value="${esc(c.credit_limit ?? 0)}"></div>
    <div class="field full"><label>${esc(t('address'))}</label><input class="input" name="address" value="${esc(c.address)}"></div>
    <div class="field full"><label>${esc(t('notes'))}</label><textarea class="input" name="notes">${esc(c.notes)}</textarea></div>
  </form>`;
}

export function openCustomerModal(c = null, onSaved) {
  modal({
    title: c ? `${t('edit')} · ${c.code}` : t('new_customer'), wide: true,
    body: customerForm(c || { branch_code: state.profile.branch_code }),
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="cust-save">${icon('check')}${esc(t('save'))}</button>`,
    onMount: (m) => {
      m.el.querySelector('#cust-save').onclick = (e) => busy(e.currentTarget, async () => {
        const f = m.el.querySelector('#cust-form');
        if (!checkRequired(f)) return;
        const data = formData(f);
        data.credit_limit = data.credit_limit || 0;
        try {
          const row = c
            ? await run(from('customers').update(data).eq('id', c.id).select().single())
            : await run(from('customers').insert(data).select().single());
          toast(`${t('customer_saved')} · ${row.code}`);
          m.close();
          onSaved && onSaved(row);
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}

export async function render({ el, setTitle, query }) {
  setTitle(t('customers'));
  let q = ''; let offset = 0; let rows = [];
  el.innerHTML = `
    <div class="page-head">
      <div class="grow"><h1>${esc(t('customers'))}</h1></div>
      ${can('customer.write') ? `<button class="btn primary" id="new-cust">${icon('plus')}${esc(t('new_customer'))}</button>` : ''}
    </div>
    <div class="card">
      <div class="card-h"><div class="search" style="flex:1;max-width:420px">${icon('search')}<input class="input" id="q" placeholder="${esc(t('search_ph'))}"></div></div>
      <div id="list"></div>
      <div class="card-b hidden" id="more-wrap" style="text-align:center"><button class="btn" id="more">${esc(t('load_more'))}</button></div>
    </div>`;

  const draw = (count) => {
    const list = $('#list', el);
    if (!rows.length) { list.innerHTML = empty(t('nothing_here'), 'users'); $('#more-wrap', el).classList.add('hidden'); return; }
    list.innerHTML = `
      <div class="table-wrap cards-m"><table class="t"><thead><tr>
        <th>${esc(t('customer_code'))}</th><th>${esc(t('name'))}</th><th>${esc(t('phone'))}</th><th class="hide-m">${esc(t('city'))}</th>
        <th class="num">${esc(t('shipments_count'))}</th><th class="num">${esc(t('balance'))}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="click" data-href="#/customer/${r.id}">
        <td class="mono">${esc(r.code)}</td><td><b>${esc(r.name)}</b>${r.company ? `<div class="muted small">${esc(r.company)}</div>` : ''}</td>
        <td class="nowrap">${esc(r.phone)}</td><td class="hide-m">${esc(r.city || '—')}</td>
        <td class="num">${r.shipment_count}</td><td class="num" style="${r.balance_usd > 0 ? 'color:var(--red);font-weight:700' : ''}">${usd(r.balance_usd)}</td></tr>`).join('')}</tbody></table></div>
      <div class="list-cards">${rows.map((r) => `<a class="lc" href="#/customer/${r.id}"><div class="top"><b>${esc(r.name)}</b>
        <span class="num" style="${r.balance_usd > 0 ? 'color:var(--red);font-weight:700' : ''}">${usd(r.balance_usd)}</span></div>
        <div class="sub mono">${esc(r.code)} · ${esc(r.phone)}</div></a>`).join('')}</div>`;
    $('#more-wrap', el).classList.toggle('hidden', rows.length >= count);
  };

  const load = async (reset = true) => {
    if (reset) { offset = 0; rows = []; }
    let b = from('v_customers').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + PAGE - 1);
    if (q) { const s = q.replace(/[,()]/g, ' '); b = b.or(`name.ilike.*${s}*,phone.ilike.*${s}*,code.ilike.*${s}*,company.ilike.*${s}*`); }
    const { data, count } = await run(b);
    rows = rows.concat(data); offset += data.length;
    draw(count);
  };

  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
  $('#q', el).addEventListener('input', debounce((e) => { q = e.target.value.trim(); load(); }, 300));
  $('#more', el).onclick = () => load(false);
  const nb = $('#new-cust', el);
  if (nb) nb.onclick = () => openCustomerModal(null, (row) => { location.hash = `#/customer/${row.id}`; });
  await load();
  if (query.get('new') && nb) nb.click();
}
