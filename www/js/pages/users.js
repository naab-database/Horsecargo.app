import { t } from '../i18n.js';
import { from, run, isAdmin, state, errText } from '../api.js';
import { icon, esc, fdate, modal, toast, formData, busy } from '../ui.js';

const ROLES = ['admin', 'manager', 'counter', 'warehouse', 'cashier', 'operations', 'release_officer', 'accountant', 'finance_manager', 'viewer'];

export async function render({ el, setTitle, rerender }) {
  setTitle(t('users'));
  if (!isAdmin()) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(errText({ message: 'NOT_ALLOWED:' }))}</div></div>`; return; }
  const rows = await run(from('profiles').select('*').order('active', { ascending: true }).order('created_at', { ascending: false }));
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('users'))}</h1><p>${esc(t('users_sub'))}</p></div></div>
  <div class="stack">
  <div class="callout info">${icon('shield')}<div class="small">${esc(t('segregation_note'))}</div></div>
  <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('name'))}</th><th>${esc(t('role'))}</th><th>${esc(t('branch'))}</th><th>${esc(t('status'))}</th><th class="hide-m">${esc(t('created'))}</th></tr></thead>
  <tbody>${rows.map((u) => `<tr class="click" data-id="${u.id}"><td><b>${esc(u.full_name || '—')}</b><div class="muted small">${esc(u.email)}</div></td>
    <td>${esc(t('r_' + u.role))}</td><td>${esc(u.branch_code || '—')}</td>
    <td>${u.active ? `<span class="badge s-ready">${esc(t('active'))}</span>` : `<span class="badge s-pending_deposit">${esc(t('inactive'))}</span>`}</td>
    <td class="hide-m">${fdate(u.created_at)}</td></tr>`).join('')}</tbody></table></div></div></div>`;

  el.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const u = rows.find((x) => x.id === tr.dataset.id);
    const self = u.id === state.profile.id;
    modal({
      title: u.full_name || u.email,
      body: `<form class="form" id="uf" novalidate>
        <div class="field full"><label>${esc(t('email'))}</label><input class="input" readonly value="${esc(u.email)}"></div>
        <div class="field"><label>${esc(t('full_name'))}</label><input class="input" name="full_name" value="${esc(u.full_name)}"></div>
        <div class="field"><label>${esc(t('phone'))}</label><input class="input" name="phone" value="${esc(u.phone)}"></div>
        <div class="field"><label>${esc(t('role'))}</label><select class="input" name="role" ${self ? 'disabled' : ''}>${ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${esc(t('r_' + r))}</option>`).join('')}</select></div>
        <div class="field"><label>${esc(t('branch'))}</label><select class="input" name="branch_code"><option value="">—</option>${state.branches.map((b) => `<option value="${b.code}" ${u.branch_code === b.code ? 'selected' : ''}>${esc(b.code)} · ${esc(b.name)}</option>`).join('')}</select></div>
        <label class="row small full"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${self ? 'disabled' : ''}> ${esc(t('active'))}</label>
      </form>`,
      foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="us">${icon('check')}${esc(t('save'))}</button>`,
      onMount: (m) => {
        m.el.querySelector('#us').onclick = (ev) => busy(ev.currentTarget, async () => {
          const d = formData(m.el.querySelector('#uf'));
          if (self) { delete d.role; delete d.active; }
          try { await run(from('profiles').update(d).eq('id', u.id)); m.close(); toast(t('saved')); rerender(); } catch (err) { toast(errText(err), 'err'); }
        });
      },
    });
  });
}
