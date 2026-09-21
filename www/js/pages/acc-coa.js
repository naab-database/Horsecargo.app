import { t } from '../i18n.js';
import { rpc, can, errText } from '../api.js';
import { icon, esc, usd, modal, toast, busy, $, toCSV, downloadCSV } from '../ui.js';
import { companySelect, getCompany, setCompany, loadAccounts, accName, TYPES, signed } from '../acc.js';

// natural sign: assets / costs are debit balances, the rest credit balances
export const natural = (type, dc) => (['asset', 'cost_of_sales', 'expense', 'contra_revenue'].includes(type) ? dc : -dc);

export async function render({ el, setTitle, rerender }) {
  setTitle(t('acc_coa'));
  if (!can('acc.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  const co = getCompany();
  const today = new Date().toISOString().slice(0, 10);
  const [tb, all] = await Promise.all([rpc('acc_trial_balance', { p_company: co || null, p_from: '2000-01-01', p_to: today }), loadAccounts(true)]);
  const meta = (code) => all.filter((a) => a.code === code && (!co || a.company_code === co));
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('acc_coa'))}</h1><p>${esc(t('acc_coa_sub'))}</p></div>
    <div class="row">${companySelect()}<input class="input" id="q" placeholder="${esc(t('search'))}" style="width:180px">
    <button class="btn hide-m" id="csv">${icon('download')}${esc(t('export_csv'))}</button>
    ${can('acc.approve') ? `<button class="btn primary" id="new">${icon('plus')}${esc(t('acc_new_account'))}</button>` : ''}</div></div>
  <div class="stack" id="groups">
    ${TYPES.map((ty) => {
      const rows = tb.filter((r) => r.type === ty);
      if (!rows.length) return '';
      const total = rows.reduce((a, r) => a + natural(ty, Number(r.opening) + Number(r.debit) - Number(r.credit)), 0);
      return `<div class="card"><div class="card-h"><h2>${esc(t('at_' + ty))}</h2><b>${signed(total)}</b></div>
        <div class="table-wrap"><table class="t"><tbody>${rows.map((r) => {
          const m = meta(r.code); const inactive = m.length && m.every((a) => !a.active);
          const bal = natural(ty, Number(r.opening) + Number(r.debit) - Number(r.credit));
          return `<tr class="click" data-code="${esc(r.code)}" data-co="${esc(!co && r.company ? r.company : '')}" data-s="${esc((r.code + ' ' + r.name + ' ' + (r.name_sw || '')).toLowerCase())}" style="${inactive ? 'opacity:.5' : ''}">
            <td style="width:70px" class="mono"><b>${esc(r.code)}</b></td>
            <td>${esc(accName({ name: r.name, name_sw: r.name_sw }))}
              ${r.system_key ? `<span class="badge plain" title="${esc(t('acc_system_account'))}">${icon('lock')}</span>` : ''}${r.is_money ? ` <span class="badge plain">${esc(t('acc_money'))}</span>` : ''}${inactive ? ` <span class="badge">${esc(t('inactive'))}</span>` : ''}</td>
            <td class="num" style="${bal < 0 ? 'color:var(--red)' : ''}">${signed(bal)}</td>
            <td class="right" style="width:44px">${can('acc.approve') && !r.system_key && !r.is_money ? `<button class="icon-btn" data-edit="${esc(r.code)}" title="${esc(t('edit'))}">${icon('gear')}</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div></div>`;
    }).join('')}
  </div>`;
  $('#company', el).onchange = (e) => { setCompany(e.target.value); rerender(); };
  $('#q', el).oninput = (e) => { const s = e.target.value.toLowerCase(); el.querySelectorAll('tr[data-s]').forEach((tr) => { tr.style.display = tr.dataset.s.includes(s) ? '' : 'none'; }); };
  $('#csv', el).onclick = () => downloadCSV(`horse-cargo-coa-${co || 'group'}.csv`, toCSV(tb.map((r) => ({ ...r, balance: natural(r.type, Number(r.opening) + Number(r.debit) - Number(r.credit)) })), [
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Name (SW)', key: 'name_sw' }, { label: 'Type', key: 'type' }, { label: 'System key', key: 'system_key' }, { label: 'Balance USD', key: 'balance' }]));
  if ($('#new', el)) $('#new', el).onclick = () => accountModal(null, rerender);
  el.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { e.stopPropagation(); return accountModal(meta(ed.dataset.edit), rerender); }
    const tr = e.target.closest('tr[data-code]'); if (tr) { if (tr.dataset.co) setCompany(tr.dataset.co); location.hash = `#/acc/account/${tr.dataset.code}`; }
  });
}

function accountModal(rows, done) {
  const a = rows?.[0];
  modal({
    title: a ? `${a.code} · ${a.name}` : t('acc_new_account'),
    body: `<form class="form" id="af" novalidate>
      <div class="field"><label class="req">${esc(t('acc_code'))}</label><input class="input mono" name="code" maxlength="4" inputmode="numeric" value="${esc(a?.code || '')}" ${a ? 'readonly' : ''} required></div>
      <div class="field"><label class="req">${esc(t('acc_type'))}</label><select class="input" name="type" ${a ? 'disabled' : ''}>${TYPES.map((ty) => `<option value="${ty}" ${a?.type === ty ? 'selected' : ''}>${esc(t('at_' + ty))}</option>`).join('')}</select></div>
      <div class="field full"><label class="req">${esc(t('name'))}</label><input class="input" name="name" value="${esc(a?.name || '')}" required></div>
      <div class="field full"><label>${esc(t('name_sw'))}</label><input class="input" name="name_sw" value="${esc(a?.name_sw || '')}"></div>
      ${a ? `<div class="field full"><label><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> ${esc(t('active'))}</label></div>` : `<div class="field full muted small">${esc(t('acc_code_hint'))}</div>`}
    </form>`,
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="as">${icon('check')}${esc(t('save'))}</button>`,
    onMount: (m) => {
      m.el.querySelector('#as').onclick = (ev) => busy(ev.currentTarget, async () => {
        const f = m.el.querySelector('#af');
        if (!f.name.value.trim() || !/^\d{4}$/.test(f.code.value)) { toast(t('required_fields'), 'err'); return; }
        try {
          if (a) { for (const r of rows) await rpc('acc_save_account', { p: { id: r.id, name: f.name.value.trim(), name_sw: f.name_sw.value, active: f.active.checked } }); }
          else await rpc('acc_save_account', { p: { code: f.code.value, type: f.type.value, name: f.name.value.trim(), name_sw: f.name_sw.value } });
          await loadAccounts(true);
          m.close(); toast(t('saved')); done();
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}
