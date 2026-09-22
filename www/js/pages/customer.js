import { t } from '../i18n.js';
import { from, run, can } from '../api.js';
import { icon, esc, usd, fdate, statusBadge, modeTag, route, empty, whatsappLink, $ } from '../ui.js';
import { openCustomerModal } from './customers.js';

export async function render({ el, params, setTitle, rerender }) {
  const c = await run(from('v_customers').select('*').eq('id', params[0]).single());
  const shipments = await run(from('v_shipments').select('*').eq('customer_id', c.id).order('created_at', { ascending: false }).limit(200));
  setTitle(c.name);
  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><div class="muted mono">${esc(c.code)}</div><h1>${esc(c.name)}</h1>${c.company ? `<p>${esc(c.company)}</p>` : ''}</div>
    <div class="row">
      <a class="btn" href="${whatsappLink(c.phone, `Habari ${c.name}, `)}" target="_blank" rel="noopener">${icon('whatsapp')}WhatsApp</a>
      ${can('customer.write') ? `<button class="btn" id="edit">${icon('gear')}${esc(t('edit'))}</button>` : ''}
      ${can('shipment.create') ? `<a class="btn primary" href="#/shipments/new?customer=${c.id}">${icon('plus')}${esc(t('new_shipment'))}</a>` : ''}
    </div>
  </div>
  <div class="split">
    <div class="card">
      <div class="card-h"><h2>${esc(t('shipments'))}</h2><span class="muted">${shipments.length}</span></div>
      ${shipments.length ? `
      <div class="table-wrap cards-m"><table class="t"><thead><tr><th>${esc(t('shipment_no'))}</th><th>${esc(t('route'))}</th><th>${esc(t('status'))}</th><th class="num">${esc(t('balance'))}</th><th class="hide-m">${esc(t('date'))}</th></tr></thead>
      <tbody>${shipments.map((b) => `<tr class="click" data-href="#/shipment/${b.id}"><td class="mono">${esc(b.ref)}</td><td>${modeTag(b.mode)} ${route(b.origin_branch, b.destination_branch)}</td>
        <td>${statusBadge(b.status)}</td><td class="num" style="${b.balance_usd > 0 ? 'color:var(--red);font-weight:700' : ''}">${usd(b.balance_usd)}</td><td class="hide-m">${fdate(b.created_at)}</td></tr>`).join('')}</tbody></table></div>
      <div class="list-cards">${shipments.map((b) => `<a class="lc" href="#/shipment/${b.id}"><div class="top"><span class="mono"><b>${esc(b.ref)}</b></span>${statusBadge(b.status)}</div>
        <div class="sub">${esc(b.mode.toUpperCase())} ${esc(b.origin_branch)} → ${esc(b.destination_branch)} · ${usd(b.balance_usd)}</div></a>`).join('')}</div>` : empty()}
    </div>
    <div class="card">
      <div class="card-h"><h2>${esc(t('details'))}</h2></div>
      <div class="card-b">
        <dl class="kv">
          <dt>${esc(t('balance'))}</dt><dd style="${c.balance_usd > 0 ? 'color:var(--red)' : ''}"><b>${usd(c.balance_usd)}</b></dd>
          <dt>${esc(t('phone'))}</dt><dd><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>${c.phone2 ? ` · ${esc(c.phone2)}` : ''}</dd>
          <dt>${esc(t('email'))}</dt><dd>${esc(c.email || '—')}</dd>
          <dt>${esc(t('tin'))}</dt><dd>${esc(c.tin || '—')}</dd>
          <dt>${esc(t('id_type'))}</dt><dd>${esc([c.id_type, c.id_number].filter(Boolean).join(' · ') || '—')}</dd>
          <dt>${esc(t('address'))}</dt><dd>${esc([c.address, c.city, c.country].filter(Boolean).join(', ') || '—')}</dd>
          <dt>${esc(t('branch'))}</dt><dd>${esc(c.branch_code || '—')}</dd>
          <dt>${esc(t('credit_limit'))}</dt><dd>${usd(c.credit_limit)}</dd>
          <dt>${esc(t('created'))}</dt><dd>${fdate(c.created_at)}</dd>
          ${c.notes ? `<dt>${esc(t('notes'))}</dt><dd>${esc(c.notes)}</dd>` : ''}
        </dl>
      </div>
    </div>
  </div>`;
  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
  const ed = $('#edit', el); if (ed) ed.onclick = () => openCustomerModal(c, () => rerender());
}
