import { t } from '../i18n.js';
import { from, run } from '../api.js';
import { icon, esc, toast, $ } from '../ui.js';
import { startCamera, refFromText } from '../scanner.js';

async function openRef(raw) {
  const ref = refFromText(raw) || String(raw || '').trim().toUpperCase();
  if (!ref) return false;
  const b = await run(from('shipments').select('id').ilike('ref', ref).maybeSingle());
  if (!b) { toast(`${t('not_found')}: ${ref}`, 'err'); return false; }
  location.hash = `#/shipment/${b.id}`;
  return true;
}

export async function render({ el, setTitle, query }) {
  setTitle(t('scan'));
  if (query.get('ref')) { if (await openRef(query.get('ref'))) return; }
  let stop = null;
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('scan_title'))}</h1><p>${esc(t('scan_sub'))}</p></div></div>
  <div class="card" style="max-width:560px;margin:0 auto">
    <div class="card-b stack">
      <div id="cam-wrap" class="hidden"><div id="scanner"></div></div>
      <button class="btn accent" id="cam" style="min-height:52px">${icon('camera')}${esc(t('start_camera'))}</button>
      <div class="muted small" style="text-align:center">${esc(t('or_type'))}</div>
      <form class="row" id="manual" style="flex-wrap:nowrap">
        <input class="input mono" name="ref" placeholder="HC-BK-2609-0001" autocapitalize="characters" style="flex:1">
        <button class="btn primary" type="submit">${esc(t('open'))}</button>
      </form>
    </div>
  </div>`;
  const camBtn = $('#cam', el);
  camBtn.onclick = async () => {
    if (stop) { await stop(); stop = null; $('#cam-wrap', el).classList.add('hidden'); camBtn.innerHTML = `${icon('camera')}${esc(t('start_camera'))}`; return; }
    $('#cam-wrap', el).classList.remove('hidden');
    try {
      stop = await startCamera($('#scanner', el), async (text) => { if (await openRef(text)) { await stop?.(); stop = null; } });
      camBtn.innerHTML = `${icon('x')}${esc(t('stop_camera'))}`;
    } catch (e) {
      $('#cam-wrap', el).classList.add('hidden');
      toast(t('camera_error'), 'err');
    }
  };
  $('#manual', el).onsubmit = (e) => { e.preventDefault(); openRef(e.target.ref.value); };
  if (query.get('auto') === '1') camBtn.click();
  return () => { if (stop) stop(); };
}
