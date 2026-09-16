import { t, getLang } from '../i18n.js';
import { from, run, can, errText, loadReference } from '../api.js';
import { icon, esc, usd, modal, toast, formData, checkRequired, busy, $ } from '../ui.js';

export async function render({ el, setTitle, rerender }) {
  setTitle(t('rates'));
  const rows = await run(from('cargo_categories').select('*').order('name'));
  const edit = can('rates.write');
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('rates'))}</h1><p>${esc(t('rates_sub'))}</p></div>
    ${edit ? `<button class="btn primary" data-act="new">${icon('plus')}${esc(t('new_category'))}</button>` : ''}</div>
  <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('cargo_category'))}</th><th class="num">${esc(t('sea_rate'))}</th><th class="num">${esc(t('min_sea'))}</th>
    <th class="num">${esc(t('air_rate'))}</th><th class="num">${esc(t('min_air'))}</th><th class="hide-m">${esc(t('permit_note'))}</th><th>${esc(t('status'))}</th></tr></thead>
  <tbody>${rows.map((r) => `<tr class="${edit ? 'click' : ''}" data-id="${r.id}" style="${r.active ? '' : 'opacity:.55'}">
    <td><b>${esc(getLang() === 'sw' && r.name_sw ? r.name_sw : r.name)}</b><div class="muted small">${esc(r.description || '')}</div></td>
    <td class="num">${usd(r.sea_rate_cbm)}</td><td class="num">${usd(r.min_charge_sea)}</td><td class="num">${usd(r.air_rate_kg)}</td><td class="num">${usd(r.min_charge_air)}</td>
    <td class="hide-m small">${esc(r.permit_note || '')}</td>
    <td>${r.restricted ? `<span class="badge s-cancelled">${esc(t('restricted'))}</span>` : r.active ? `<span class="badge s-ready">${esc(t('active'))}</span>` : `<span class="badge">${esc(t('inactive'))}</span>`}</td></tr>`).join('')}</tbody></table></div></div>`;

  const open = (r = {}) => modal({
    title: r.id ? r.name : t('new_category'), wide: true,
    body: `<form class="form" id="rf" novalidate>
      <div class="field"><label class="req">${esc(t('name'))}</label><input class="input" name="name" required value="${esc(r.name)}"></div>
      <div class="field"><label>${esc(t('name_sw'))}</label><input class="input" name="name_sw" value="${esc(r.name_sw)}"></div>
      <div class="field full"><label>${esc(t('description'))}</label><input class="input" name="description" value="${esc(r.description)}"></div>
      <div class="field"><label class="req">${esc(t('sea_rate'))}</label><input class="input" type="number" step="0.01" min="0" name="sea_rate_cbm" required value="${esc(r.sea_rate_cbm ?? 0)}"></div>
      <div class="field"><label class="req">${esc(t('min_sea'))}</label><input class="input" type="number" step="0.01" min="0" name="min_charge_sea" required value="${esc(r.min_charge_sea ?? 0)}"></div>
      <div class="field"><label class="req">${esc(t('air_rate'))}</label><input class="input" type="number" step="0.01" min="0" name="air_rate_kg" required value="${esc(r.air_rate_kg ?? 0)}"></div>
      <div class="field"><label class="req">${esc(t('min_air'))}</label><input class="input" type="number" step="0.01" min="0" name="min_charge_air" required value="${esc(r.min_charge_air ?? 0)}"></div>
      <div class="field full"><label>${esc(t('permit_note'))}</label><input class="input" name="permit_note" value="${esc(r.permit_note)}"></div>
      <label class="row small"><input type="checkbox" name="active" ${r.active !== false ? 'checked' : ''}> ${esc(t('active'))}</label>
      <label class="row small"><input type="checkbox" name="restricted" ${r.restricted ? 'checked' : ''}> ${esc(t('restricted'))}</label>
    </form>`,
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="rs">${icon('check')}${esc(t('save'))}</button>`,
    onMount: (m) => {
      m.el.querySelector('#rs').onclick = (e) => busy(e.currentTarget, async () => {
        const f = m.el.querySelector('#rf'); if (!checkRequired(f)) return;
        const d = formData(f);
        try {
          if (r.id) await run(from('cargo_categories').update(d).eq('id', r.id)); else await run(from('cargo_categories').insert(d));
          await loadReference(true); m.close(); toast(t('saved')); rerender();
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
  if (edit) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act=new]')) return open();
      const tr = e.target.closest('tr[data-id]'); if (tr) open(rows.find((x) => String(x.id) === tr.dataset.id));
    });
  }
}
