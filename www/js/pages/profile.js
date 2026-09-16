import { t, getLang, setLang } from '../i18n.js';
import { from, run, sb, state, errText, loadSession } from '../api.js';
import { icon, esc, toast, busy, $ } from '../ui.js';

export async function render({ el, setTitle }) {
  setTitle(t('profile'));
  const p = state.profile;
  el.innerHTML = `
  <div class="grid c2" style="max-width:900px">
    <div class="card"><div class="card-h"><h2>${esc(t('profile'))}</h2></div><div class="card-b stack">
      <div class="field"><label>${esc(t('email'))}</label><input class="input" readonly value="${esc(p.email)}"></div>
      <div class="field"><label>${esc(t('full_name'))}</label><input class="input" id="fn" value="${esc(p.full_name)}"></div>
      <div class="field"><label>${esc(t('phone'))}</label><input class="input" id="ph" value="${esc(p.phone)}"></div>
      <div class="kv"><dt>${esc(t('role'))}</dt><dd>${esc(t('r_' + p.role))}</dd><dt>${esc(t('branch'))}</dt><dd>${esc(p.branch_code || '—')}</dd></div>
      <div class="field"><label>${esc(t('language'))}</label><div class="seg"><button data-lang="en" class="${getLang() === 'en' ? 'on' : ''}">English</button><button data-lang="sw" class="${getLang() === 'sw' ? 'on' : ''}">Kiswahili</button></div></div>
      <div><button class="btn primary" id="sp">${icon('check')}${esc(t('save'))}</button></div>
    </div></div>
    <div class="card"><div class="card-h"><h2>${esc(t('change_password'))}</h2></div><div class="card-b stack">
      <div class="field"><label>${esc(t('new_password'))}</label><input class="input" type="password" id="pw" minlength="8" autocomplete="new-password"></div>
      <div><button class="btn" id="spw">${icon('lock')}${esc(t('change_password'))}</button></div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <button class="btn danger" data-logout>${icon('logout')}${esc(t('logout'))}</button>
    </div></div>
  </div>`;
  $('#sp', el).onclick = (e) => busy(e.currentTarget, async () => {
    try { await run(from('profiles').update({ full_name: $('#fn', el).value.trim(), phone: $('#ph', el).value.trim() || null }).eq('id', p.id)); await loadSession(); toast(t('saved')); } catch (err) { toast(errText(err), 'err'); }
  });
  $('#spw', el).onclick = (e) => busy(e.currentTarget, async () => {
    const pw = $('#pw', el).value; if (pw.length < 8) { toast('Min 8', 'err'); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) toast(errText(error), 'err'); else { $('#pw', el).value = ''; toast(t('saved')); }
  });
}
