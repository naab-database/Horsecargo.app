import { t } from '../i18n.js';
import { from, run, can, errText } from '../api.js';
import { icon, esc, usd, money, num, fdate, statusBadge, empty, toCSV, downloadCSV, $, $$ } from '../ui.js';

const firstOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };
const todayStr = () => new Date().toISOString().slice(0, 10);
const endOf = (d) => new Date(new Date(d).getTime() + 86400000).toISOString().slice(0, 10);

export async function render({ el, setTitle }) {
  setTitle(t('reports'));
  if (!can('reports.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(errText({ message: 'NOT_ALLOWED:' }))}</div></div>`; return; }
  let tab = 'collections';
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('reports'))}</h1></div>
    <div class="row"><label class="small muted">${esc(t('from'))}</label><input class="input" type="date" id="d1" value="${firstOfMonth()}" style="width:auto">
    <label class="small muted">${esc(t('to'))}</label><input class="input" type="date" id="d2" value="${todayStr()}" style="width:auto">
    <button class="btn" id="csv">${icon('download')}${esc(t('export_csv'))}</button></div></div>
  <div class="card">
    <div class="tabs" id="tabs">
      <button data-tab="collections" class="on">${esc(t('collections'))}</button>
      <button data-tab="receivables">${esc(t('receivables'))}</button>
      <button data-tab="revenue">${esc(t('revenue'))}</button>
      <button data-tab="volumes">${esc(t('volumes'))}</button>
    </div>
    <div id="out"><div class="boot" style="min-height:30vh"><div class="spinner"></div></div></div>
  </div>`;

  let lastCSV = null;
  const kpis = (items) => `<div class="card-b"><div class="grid c4">${items.map(([k, v]) => `<div class="card kpi" style="box-shadow:none"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('')}</div></div>`;
  const group = (rows, key, val) => rows.reduce((a, r) => { const k = typeof key === 'function' ? key(r) : r[key]; a[k] = (a[k] || 0) + val(r); return a; }, {});

  const load = async () => {
    const d1 = $('#d1', el).value; const d2 = endOf($('#d2', el).value);
    const out = $('#out', el);
    out.innerHTML = `<div class="boot" style="min-height:30vh"><div class="spinner"></div></div>`;

    if (tab === 'collections') {
      const rows = await run(from('v_receipts').select('*').eq('void', false).gte('received_at', d1).lt('received_at', d2).order('received_at', { ascending: false }).limit(5000));
      const sign = (r) => (r.kind === 'refund' ? -1 : 1);
      const tot = rows.reduce((a, r) => a + sign(r) * r.amount_usd, 0);
      const byM = group(rows, 'method', (r) => sign(r) * r.amount_usd);
      const byC = group(rows, 'currency', (r) => sign(r) * r.amount);
      const byB = group(rows, (r) => r.branch_code || '—', (r) => sign(r) * r.amount_usd);
      out.innerHTML = kpis([[t('total'), usd(tot)], [t('count'), rows.length], [t('k_deposit'), usd(rows.filter((r) => r.kind === 'deposit').reduce((a, r) => a + r.amount_usd, 0))], [t('k_payment'), usd(rows.filter((r) => r.kind === 'payment').reduce((a, r) => a + r.amount_usd, 0))]]) + `
        <div class="card-b grid c3" style="padding-top:0">
          <div><h3 style="margin-bottom:8px">${esc(t('by_method'))}</h3><table class="t"><tbody>${Object.entries(byM).map(([k, v]) => `<tr><td>${esc(t('m_' + k))}</td><td class="num">${usd(v)}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</tbody></table></div>
          <div><h3 style="margin-bottom:8px">${esc(t('by_currency'))}</h3><table class="t"><tbody>${Object.entries(byC).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${money(v, k)}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</tbody></table></div>
          <div><h3 style="margin-bottom:8px">${esc(t('branch'))}</h3><table class="t"><tbody>${Object.entries(byB).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${usd(v)}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</tbody></table></div>
        </div>
        ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('receipt'))}</th><th>${esc(t('date'))}</th><th>${esc(t('booking'))}</th><th>${esc(t('customer'))}</th><th>${esc(t('method'))}</th><th class="num">${esc(t('amount'))}</th><th class="num">USD</th><th>${esc(t('by'))}</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.ref)}</td><td class="nowrap">${fdate(r.received_at)}</td><td class="mono"><a href="#/booking/${r.booking_id}">${esc(r.booking_ref)}</a></td><td>${esc(r.customer_name)}</td>
          <td>${esc(t('m_' + r.method))}</td><td class="num nowrap">${money(r.amount, r.currency)}</td><td class="num">${usd(sign(r) * r.amount_usd, { bare: true })}</td><td class="small">${esc(r.received_by_name || '')}</td></tr>`).join('')}</tbody></table></div>` : empty()}`;
      lastCSV = ['collections', toCSV(rows, [{ label: 'Receipt', key: 'ref' }, { label: 'Date', value: (r) => r.received_at.slice(0, 10) }, { label: 'Kind', key: 'kind' }, { label: 'Booking', key: 'booking_ref' },
        { label: 'Customer', key: 'customer_name' }, { label: 'Method', key: 'method' }, { label: 'Reference', key: 'reference' }, { label: 'Currency', key: 'currency' }, { label: 'Amount', key: 'amount' },
        { label: 'FX per USD', key: 'fx_rate' }, { label: 'USD', value: (r) => sign(r) * r.amount_usd }, { label: 'Branch', key: 'branch_code' }, { label: 'Received by', key: 'received_by_name' }])];
    }

    if (tab === 'receivables') {
      const rows = await run(from('v_bookings').select('*').gt('balance_usd', 0).not('status', 'in', '(cancelled,pending_deposit)').order('balance_usd', { ascending: false }).limit(5000));
      const tot = rows.reduce((a, r) => a + r.balance_usd, 0);
      const ageDays = (r) => Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000);
      const buckets = { '0–30': 0, '31–60': 0, '61–90': 0, '90+': 0 };
      rows.forEach((r) => { const a = ageDays(r); buckets[a <= 30 ? '0–30' : a <= 60 ? '31–60' : a <= 90 ? '61–90' : '90+'] += r.balance_usd; });
      out.innerHTML = kpis([[t('outstanding'), usd(tot)], ['0–30', usd(buckets['0–30'])], ['31–90', usd(buckets['31–60'] + buckets['61–90'])], ['90+', usd(buckets['90+'])]]) + (rows.length ? `
        <div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('booking'))}</th><th>${esc(t('customer'))}</th><th>${esc(t('status'))}</th><th class="num">${esc(t('invoice_total'))}</th><th class="num">${esc(t('paid'))}</th><th class="num">${esc(t('balance'))}</th><th class="num">Days</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="click" data-href="#/booking/${r.id}"><td class="mono">${esc(r.ref)}</td><td>${esc(r.customer_name)}<div class="muted small">${esc(r.customer_phone)}</div></td><td>${statusBadge(r.status)}</td>
          <td class="num">${usd(r.invoice_total)}</td><td class="num">${usd(r.paid_usd)}</td><td class="num" style="color:var(--red);font-weight:700">${usd(r.balance_usd)}</td><td class="num">${ageDays(r)}</td></tr>`).join('')}</tbody></table></div>` : empty());
      lastCSV = ['receivables', toCSV(rows, [{ label: 'Booking', key: 'ref' }, { label: 'Customer', key: 'customer_name' }, { label: 'Phone', key: 'customer_phone' }, { label: 'Status', key: 'status' },
        { label: 'Invoice USD', key: 'invoice_total' }, { label: 'Paid USD', key: 'paid_usd' }, { label: 'Balance USD', key: 'balance_usd' }, { label: 'Age days', value: ageDays }])];
    }

    if (tab === 'revenue') {
      const rows = await run(from('v_invoice_lines').select('*').eq('invoice_status', 'issued').gte('issued_at', d1).lt('issued_at', d2).limit(10000));
      const by = group(rows, 'kind', (r) => r.amount);
      const byRoute = group(rows.filter((r) => r.kind !== 'duty'), (r) => `${r.mode.toUpperCase()} ${r.origin_branch}→${r.destination_branch}`, (r) => r.amount);
      out.innerHTML = kpis([[t('freight_revenue'), usd(by.freight || 0)], [t('extra_revenue'), usd(by.extra || 0)], [t('discounts'), usd(by.discount || 0)], [t('duty_recovered'), usd(by.duty || 0)]]) + `
        <div class="card-b" style="padding-top:0"><div class="callout info">${icon('info')}<div class="small">${esc(t('duty_note'))}</div></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('route'))}</th><th class="num">${esc(t('revenue'))} (USD)</th></tr></thead>
        <tbody>${Object.entries(byRoute).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="num">${usd(v)}</td></tr>`).join('') || `<tr><td colspan="2">${empty()}</td></tr>`}</tbody></table></div>`;
      lastCSV = ['revenue', toCSV(rows, [{ label: 'Invoice', key: 'invoice_ref' }, { label: 'Issued', value: (r) => r.issued_at.slice(0, 10) }, { label: 'Booking', key: 'booking_ref' }, { label: 'Customer', key: 'customer_name' },
        { label: 'Kind', key: 'kind' }, { label: 'Description', key: 'description' }, { label: 'Qty', key: 'qty' }, { label: 'Unit', key: 'unit_price' }, { label: 'Amount USD', key: 'amount' }])];
    }

    if (tab === 'volumes') {
      const rows = await run(from('v_bookings').select('*').gte('created_at', d1).lt('created_at', d2).neq('status', 'cancelled').limit(10000));
      const key = (r) => `${r.mode.toUpperCase()} ${r.origin_branch}→${r.destination_branch}`;
      const agg = {};
      rows.forEach((r) => { const k = key(r); agg[k] = agg[k] || { n: 0, cbm: 0, kg: 0, inv: 0 }; agg[k].n++; agg[k].cbm += Number(r.cbm ?? 0); agg[k].kg += Number(r.actual_kg ?? 0); agg[k].inv += Number(r.invoice_total || 0); });
      const tcbm = rows.reduce((a, r) => a + Number(r.cbm ?? 0), 0);
      out.innerHTML = kpis([[t('bookings'), rows.length], ['CBM', num(tcbm, 2)], ['kg', num(rows.reduce((a, r) => a + Number(r.actual_kg ?? 0), 0), 0)], [t('invoice_total'), usd(rows.reduce((a, r) => a + Number(r.invoice_total || 0), 0))]]) + `
        <div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('route'))}</th><th class="num">${esc(t('bookings'))}</th><th class="num">CBM</th><th class="num">kg</th><th class="num">${esc(t('invoice_total'))}</th><th class="num">USD / CBM</th></tr></thead>
        <tbody>${Object.entries(agg).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="num">${v.n}</td><td class="num">${num(v.cbm, 3)}</td><td class="num">${num(v.kg, 0)}</td><td class="num">${usd(v.inv)}</td><td class="num">${v.cbm ? usd(v.inv / v.cbm) : '—'}</td></tr>`).join('') || `<tr><td colspan="6">${empty()}</td></tr>`}</tbody></table></div>`;
      lastCSV = ['volumes', toCSV(Object.entries(agg).map(([k, v]) => ({ route: k, ...v })), [{ label: 'Route', key: 'route' }, { label: 'Bookings', key: 'n' }, { label: 'CBM', key: 'cbm' }, { label: 'KG', key: 'kg' }, { label: 'Invoiced USD', key: 'inv' }])];
    }
  };

  $('#tabs', el).onclick = (e) => { const x = e.target.closest('button'); if (!x) return; tab = x.dataset.tab; $$('#tabs button', el).forEach((y) => y.classList.toggle('on', y === x)); load(); };
  $('#d1', el).onchange = load; $('#d2', el).onchange = load;
  $('#csv', el).onclick = () => { if (lastCSV) downloadCSV(`horse-cargo-${lastCSV[0]}-${$('#d1', el).value}_${$('#d2', el).value}.csv`, lastCSV[1]); };
  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
  await load();
}
