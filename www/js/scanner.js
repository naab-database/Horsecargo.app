import { t } from './i18n.js';
import { modal, icon, esc } from './ui.js';

let loading = null;
function loadLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  if (!loading) loading = new Promise((ok, bad) => {
    const s = document.createElement('script'); s.src = 'vendor/html5-qrcode.min.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s);
  });
  return loading;
}

// Extract a Horse Cargo booking reference from any scanned text (plain ref or tracking URL)
export function refFromText(text) {
  const m = String(text || '').toUpperCase().match(/HC-BK-\d{4}-\d{4,}/);
  return m ? m[0] : null;
}

// Starts the camera inside `container`; calls onCode(text) for each distinct decode. Returns stop().
export async function startCamera(container, onCode) {
  await loadLib();
  const id = container.id || (container.id = 'scan-' + Math.random().toString(36).slice(2));
  const qr = new window.Html5Qrcode(id, { verbose: false });
  let last = ''; let lastAt = 0;
  await qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
    (text) => { const now = Date.now(); if (text === last && now - lastAt < 2500) return; last = text; lastAt = now; if (navigator.vibrate) navigator.vibrate(60); onCode(text); },
    () => {});
  return async () => { try { if (qr.isScanning) await qr.stop(); qr.clear(); } catch { /* ignore */ } };
}

// Modal scanner for "scan to load" style flows. onCode returns true to keep scanning.
export function scanModal(title, onCode) {
  let stop = null;
  const m = modal({
    title,
    body: `<div id="scanner"></div><div class="muted small" style="margin-top:10px;text-align:center">${esc(t('scan_sub'))}</div><div id="scan-log" class="stack" style="gap:6px;margin-top:10px"></div>`,
    foot: `<button class="btn" data-close>${esc(t('close'))}</button>`,
    onMount: async (mm) => {
      try {
        stop = await startCamera(mm.el.querySelector('#scanner'), async (text) => {
          const log = mm.el.querySelector('#scan-log');
          const res = await onCode(text);
          log.insertAdjacentHTML('afterbegin', `<div class="callout ${res && res.ok ? 'ok' : 'danger'}">${icon(res && res.ok ? 'check' : 'alert')}<div>${esc(res?.msg || text)}</div></div>`);
        });
      } catch (e) {
        mm.el.querySelector('#scanner').outerHTML = `<div class="callout danger">${icon('camera')}<div>${esc(t('camera_error'))}</div></div>`;
      }
    },
  });
  const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); stop && stop(); } });
  obs.observe(document.getElementById('modal-root'), { childList: true });
  return m;
}
