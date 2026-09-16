import { t, tr } from '../i18n.js';
import { rpc, state, can } from '../api.js';
import { icon, esc, usd, num, ago } from '../ui.js';

const PIPE = [
  ['pending_deposit', '#e8a317'], ['booked', '#2463b8'], ['received', '#1f6f95'], ['loaded', '#6a48b8'],
  ['in_transit', '#4b43b8'], ['arrived', '#16777a'], ['clearing', '#a2561a'], ['ready', '#1d8a55'],
];

export async function render({ el, setTitle }) {
  setTitle(t('dashboard'));
  const d = await rpc('dashboard_stats');
  const bs = d.by_status || {}; const sh = d.shipments || {};
  const first = (state.profile.full_name || '').split(' ')[0];
  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>${esc(t('good_morning'))}${first ? ', ' + esc(first) : ''}</h1><p>${esc(t('dash_sub'))}</p></div>
    <div class="row">
      ${can('booking.create') ? `<a class="btn primary" href="#/bookings/new">${icon('plus')}${esc(t('new_booking'))}</a>` : ''}
      <a class="btn" href="#/scan">${icon('scan')}${esc(t('scan'))}</a>
    </div>
  </div>
  <div class="stack">
    <div class="grid c4">
      <div class="card kpi"><div class="k">${esc(t('in_warehouse'))}</div><div class="v">${num(d.cbm_in_warehouse, 2)} <small style="font-size:13px">CBM</small></div><div class="s">${bs.received || 0} ${esc(t('bookings').toLowerCase())}</div></div>
      <div class="card kpi ${Number(d.outstanding_usd) > 0 ? 'alert' : ''}"><div class="k">${esc(t('outstanding'))}</div><div class="v">${usd(d.outstanding_usd)}</div><div class="s">${esc(t('awaiting_payment'))}</div></div>
      <div class="card kpi"><div class="k">${esc(t('collected_today'))}</div><div class="v">${usd(d.collected_today_usd)}</div><div class="s">USD equiv.</div></div>
      <div class="card kpi"><div class="k">${esc(t('collected_month'))}</div><div class="v">${usd(d.collected_month_usd)}</div><div class="s">USD equiv.</div></div>
    </div>

    <div class="card">
      <div class="card-h"><h2>${esc(t('cargo_pipeline'))}</h2><a class="small" href="#/bookings">${esc(t('view'))} →</a></div>
      <div class="card-b"><div class="pipeline">
        ${PIPE.map(([s, c]) => `<a class="pipe" href="#/bookings?status=${s}"><span class="bar" style="background:${c}"></span><div class="n">${bs[s] || 0}</div><div class="l">${esc(t('st_' + s))}</div></a>`).join('')}
      </div></div>
    </div>

    <div class="split">
      <div class="card">
        <div class="card-h"><h2>${esc(t('recent_activity'))}</h2></div>
        <div class="card-b">
          ${(d.recent_events || []).length ? `<ul class="timeline">${d.recent_events.map((e) => `
            <li><div class="tt"><a class="mono" href="#/scan?ref=${encodeURIComponent(e.booking_ref)}">${esc(e.booking_ref)}</a> · ${esc(tr(e.title))}</div>
            ${e.note ? `<div class="tn">${esc(tr(e.note))}</div>` : ''}<div class="tm">${esc(e.location || '')} · ${esc(ago(e.created_at))}</div></li>`).join('')}</ul>`
            : `<div class="empty">${icon('clock')}<div>${esc(t('nothing_here'))}</div></div>`}
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-h"><h2>${esc(t('shipments'))}</h2><a class="small" href="#/shipments">${esc(t('view'))} →</a></div>
          <div class="card-b grid c2" style="gap:10px">
            <a class="pipe" href="#/shipments?status=open"><span class="bar" style="background:#2463b8"></span><div class="n">${sh.open || 0}</div><div class="l">${esc(t('containers_loading'))}</div></a>
            <a class="pipe" href="#/shipments?status=departed"><span class="bar" style="background:#4b43b8"></span><div class="n">${sh.departed || 0}</div><div class="l">${esc(t('containers_at_sea'))}</div></a>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h2>${esc(t('quick_actions'))}</h2></div>
          <div class="card-b stack" style="gap:8px">
            ${can('booking.create') ? `<a class="btn" style="justify-content:flex-start" href="#/bookings/new">${icon('box')}${esc(t('new_booking'))}</a>` : ''}
            ${can('customer.write') ? `<a class="btn" style="justify-content:flex-start" href="#/customers?new=1">${icon('users')}${esc(t('new_customer'))}</a>` : ''}
            ${can('shipment.write') ? `<a class="btn" style="justify-content:flex-start" href="#/shipments?new=1">${icon('container')}${esc(t('new_container'))}</a>` : ''}
            <a class="btn" style="justify-content:flex-start" href="track.html" target="_blank" rel="noopener">${icon('search')}${esc(t('track_cargo'))}</a>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}
