import { t } from '../i18n.js';
import { icon, esc } from '../ui.js';

// Packing List — reserved. The nav item and page exist so the module can be
// filled in later without moving anything around; nothing is wired to it yet.
export async function render({ el, setTitle }) {
  setTitle(t('packing_list'));
  el.innerHTML = `
  <div class="page-head"><div class="grow">
    <h1>${esc(t('packing_list'))}</h1><p>${esc(t('packing_list_sub'))}</p>
  </div></div>
  <div class="card"><div class="card-b" style="text-align:center;padding:56px 20px">
    <div style="opacity:.35">${icon('clipboard')}</div>
    <h2 style="margin:12px 0 6px">${esc(t('coming_soon'))}</h2>
    <p class="muted" style="max-width:420px;margin:0 auto">${esc(t('packing_list_placeholder'))}</p>
  </div></div>`;
}
