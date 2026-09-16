import { t } from '../i18n.js';
import { state } from '../api.js';
import { icon, esc } from '../ui.js';
import { navItems } from '../app.js';

export async function render({ el, setTitle }) {
  setTitle(t('more'));
  const p = state.profile;
  el.innerHTML = `
  <div class="card" style="margin-bottom:14px"><a class="lc" href="#/profile" style="display:flex;gap:12px;align-items:center">
    <span style="width:42px;height:42px;border-radius:50%;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:700">${esc((p.full_name || p.email || '?').slice(0, 1).toUpperCase())}</span>
    <div><b>${esc(p.full_name || p.email)}</b><div class="sub">${esc(t('r_' + p.role))}${p.branch_code ? ' · ' + esc(p.branch_code) : ''}</div></div></a></div>
  <div class="card">${navItems().filter((i) => !i.sep).map((i) => `<a class="lc row" style="gap:12px" href="${i.href}"><span style="width:22px;display:inline-grid">${icon(i.ic)}</span><span>${esc(t(i.key))}</span></a>`).join('')}
    <a class="lc row" style="gap:12px" href="#/profile"><span style="width:22px;display:inline-grid">${icon('user')}</span>${esc(t('profile'))}</a>
    <a class="lc row" style="gap:12px" href="track.html" target="_blank" rel="noopener"><span style="width:22px;display:inline-grid">${icon('search')}</span>${esc(t('track_cargo'))}</a>
    <button class="lc row btn ghost" style="gap:12px;width:100%;justify-content:flex-start;border-radius:0;color:var(--red)" data-logout><span style="width:22px;display:inline-grid">${icon('logout')}</span>${esc(t('logout'))}</button>
  </div>`;
}
