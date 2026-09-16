import { t } from '../i18n.js';
import { from, run, can, errText } from '../api.js';
import { icon, esc, fdatetime, empty } from '../ui.js';

export async function render({ el, setTitle }) {
  setTitle(t('audit'));
  if (!can('audit.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(errText({ message: 'NOT_ALLOWED:' }))}</div></div>`; return; }
  const rows = await run(from('v_audit').select('*').order('at', { ascending: false }).limit(300));
  el.innerHTML = `<div class="page-head"><div class="grow"><h1>${esc(t('audit'))}</h1></div></div>
  <div class="card">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('date'))}</th><th>${esc(t('by'))}</th><th>${esc(t('actions'))}</th><th>${esc(t('details'))}</th></tr></thead>
  <tbody>${rows.map((r) => `<tr><td class="nowrap small">${fdatetime(r.at)}</td><td>${esc(r.user_name || '—')}</td><td><span class="badge plain mono">${esc(r.action)}</span></td>
    <td class="small mono" style="max-width:520px;overflow-wrap:anywhere">${esc(Object.entries(r.details || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '))}</td></tr>`).join('')}</tbody></table></div>` : empty()}</div>`;
}
