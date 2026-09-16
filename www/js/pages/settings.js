import { t } from '../i18n.js';
import { from, run, can, state, errText, loadReference } from '../api.js';
import { icon, esc, toast, formData, busy, $ } from '../ui.js';

export async function render({ el, setTitle }) {
  setTitle(t('settings'));
  await loadReference(true);
  const s = state.settings; const ro = can('settings.write') ? '' : 'readonly disabled';
  const f = (k, type = 'text', step = '') => `<div class="field"><label>${esc(t(k))}</label><input class="input" name="${k}" type="${type}" ${step ? `step="${step}"` : ''} value="${esc(s[k])}" ${ro}></div>`;
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('settings'))}</h1></div>
    ${can('settings.write') ? `<button class="btn primary" id="save">${icon('check')}${esc(t('save'))}</button>` : ''}</div>
  <form id="sf" class="stack" novalidate>
    <div class="card"><div class="card-h"><h2>${esc(t('company_info'))}</h2></div><div class="card-b form">
      <div class="field"><label>${esc(t('company'))}</label><input class="input" name="company_name" value="${esc(s.company_name)}" ${ro}></div>
      <div class="field"><label>${esc(t('phone'))}</label><input class="input" name="company_phone" value="${esc(s.company_phone)}" ${ro}></div>
      <div class="field"><label>${esc(t('email'))}</label><input class="input" name="company_email" value="${esc(s.company_email)}" ${ro}></div>
      <div class="field"><label>${esc(t('address'))}</label><input class="input" name="company_address" value="${esc(s.company_address)}" ${ro}></div>
      <div class="field full"><label>${esc(t('invoice_terms'))}</label><textarea class="input" name="invoice_terms" ${ro}>${esc(s.invoice_terms)}</textarea></div>
    </div></div>
    <div class="card"><div class="card-h"><h2>${esc(t('commercial_rules'))}</h2></div><div class="card-b form">
      ${f('deposit_pct_sea', 'number', '1')}${f('deposit_pct_air', 'number', '1')}${f('min_cbm_sea', 'number', '0.01')}${f('air_volumetric_divisor', 'number', '1')}
      ${f('fx_aed', 'number', '0.0001')}${f('fx_tzs', 'number', '0.01')}${f('free_storage_days', 'number', '1')}${f('storage_rate_per_day', 'number', '0.01')}
    </div></div>
    <div class="card"><div class="card-h"><h2>${esc(t('branches'))}</h2></div><div class="card-b tight"><table class="t"><tbody>
      ${state.branches.map((b) => `<tr><td class="mono"><b>${esc(b.code)}</b></td><td>${esc(b.name)}<div class="muted small">${esc(b.address || '')}</div></td><td>${esc(b.country)}</td><td>${esc(b.currency)}</td><td>${esc(b.phone || '')}</td></tr>`).join('')}
    </tbody></table></div></div>
  </form>`;
  const sv = $('#save', el);
  if (sv) sv.onclick = () => busy(sv, async () => {
    const d = formData($('#sf', el)); d.updated_at = new Date().toISOString();
    try { await run(from('settings').update(d).eq('id', 1)); await loadReference(true); toast(t('saved')); } catch (err) { toast(errText(err), 'err'); }
  });
}
