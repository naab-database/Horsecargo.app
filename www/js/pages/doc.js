import { t } from '../i18n.js';
import { from, run, state, branchName, catName, publicTrackUrl } from '../api.js';
import { icon, esc, usd, money, num, fdate, fdatetime, qrSVG, whatsappLink, isNative } from '../ui.js';

// Documents are always printed in English + Kiswahili labels so they work in both offices.
const L = (en, sw) => `${en} <span style="color:#888;font-weight:400">/ ${sw}</span>`;

function header(title, ref, extra = '') {
  const s = state.settings;
  return `<div class="dh">
    <div class="co" style="display:flex;gap:12px;align-items:center"><span class="logo-tile"><img src="img/logo-white.png" alt="Horse Cargo"></span>
      <div><b>${esc(s.company_name)}</b><div>${esc(s.company_address)}</div><div>${esc(s.company_phone)} · ${esc(s.company_email)}</div>
      <div>Dar es Salaam: ${esc(state.branches.find((b) => b.code === 'DAR')?.phone || '')} · Mwanza: ${esc(state.branches.find((b) => b.code === 'MWZ')?.phone || '')}</div></div></div>
    <div class="dt"><h1>${title}</h1><div class="mono" style="font-size:15px;font-weight:700">${esc(ref)}</div>${extra}</div>
  </div>`;
}
const toolbar = (back, share) => `<div class="doc-toolbar"><a class="btn" href="${back}">${icon('arrowLeft')}${esc(t('back'))}</a>
  ${isNative() ? '' : `<button class="btn primary" onclick="window.print()">${icon('print')}${esc(t('print'))}</button>`}${share || ''}</div>`;

export async function render({ el, params, setTitle }) {
  const [type, id] = params;
  const H = { invoice, receipt, grn, labels, release, waybill }[type];
  if (!H) { el.innerHTML = 'Unknown document'; return; }
  await H(el, id, setTitle);
}

async function loadBooking(id) { return run(from('v_shipments').select('*').eq('id', id).single()); }
function parties(b) {
  return `<div class="parties">
    <div><h4>${L('Sender', 'Mtumaji')}</h4><b>${esc(b.sender_name || b.customer_name)}</b>${b.customer_company ? `<div>${esc(b.customer_company)}</div>` : ''}<div>${esc(b.sender_phone || b.customer_phone)}</div>${b.sender_address ? `<div>${esc(b.sender_address)}</div>` : ''}<div class="mono">${esc(b.customer_code)}</div></div>
    <div><h4>${L('Receiver', 'Mpokeaji')}</h4><b>${esc(b.receiver_name)}</b><div>${esc(b.receiver_phone)}</div>${b.receiver_address ? `<div>${esc(b.receiver_address)}</div>` : ''}${b.receiver_tin ? `<div>TIN ${esc(b.receiver_tin)}</div>` : ''}</div>
  </div>
  <table><tbody><tr><td><b>${L('Shipment', 'Shipment')}</b><br><span class="mono">${esc(b.ref)}</span></td><td><b>${L('Mode', 'Njia')}</b><br>${esc(b.mode.toUpperCase())}</td>
    <td><b>${L('Route', 'Safari')}</b><br>${esc(branchName(b.origin_branch))} → ${esc(branchName(b.destination_branch))}</td>
    <td><b>${L('Status', 'Hali')}</b><br>${esc(t('st_' + b.status))}</td></tr></tbody></table>`;
}

async function invoice(el, id, setTitle) {
  const b = await loadBooking(id);
  const inv = await run(from('invoices').select('*').eq('shipment_id', id).eq('status', 'issued').single());
  const lines = await run(from('invoice_lines').select('*').eq('invoice_id', inv.id).order('id'));
  setTitle(inv.ref);
  const bal = Number(b.balance_usd);
  el.innerHTML = toolbar(`#/shipment/${id}`, `<a class="btn" target="_blank" rel="noopener" href="${whatsappLink(b.customer_phone, `Horse Cargo — ${t('invoice')} ${inv.ref}\n${t('shipment')}: ${b.ref}\n${t('total')}: ${usd(inv.total)}\n${t('paid')}: ${usd(b.paid_usd)}\n${t('balance')}: ${usd(bal)}`)}">${icon('whatsapp')}${esc(t('share_whatsapp'))}</a>`) + `
  <div class="doc">
    ${header(L('INVOICE', 'ANKARA'), inv.ref, `<div>${fdate(inv.issued_at)}</div>`)}
    ${parties(b)}
    <p><b>${L('Cargo', 'Mzigo')}:</b> ${esc(b.description)} · ${num(b.pieces, 0)} pcs · ${num(b.cbm, 3)} CBM · ${num(b.actual_kg, 1)} kg${b.mode === 'air' ? ` · ${num(b.chargeable_kg, 1)} chargeable kg` : ''}</p>
    <table><thead><tr><th>${L('Description', 'Maelezo')}</th><th class="num">${L('Qty', 'Idadi')}</th><th class="num">${L('Rate', 'Bei')}</th><th class="num">USD</th></tr></thead>
    <tbody>${lines.map((l) => `<tr><td>${esc(l.description)}${l.kind === 'duty' && !/at cost/i.test(l.description) ? ' <i>(at cost / gharama halisi)</i>' : ''}</td><td class="num">${num(l.qty, 3)}</td><td class="num">${usd(l.unit_price, { bare: true })}</td><td class="num">${usd(l.amount, { bare: true })}</td></tr>`).join('')}
      <tr class="tot"><td colspan="3">${L('TOTAL', 'JUMLA')}</td><td class="num">${usd(inv.total)}</td></tr>
      <tr><td colspan="3">${L('Paid', 'Imelipwa')}</td><td class="num">${usd(b.paid_usd)}</td></tr>
      <tr class="tot"><td colspan="3">${L('BALANCE DUE', 'SALIO LINALODAIWA')}</td><td class="num">${usd(bal)}</td></tr>
      ${inv.currency && inv.currency !== 'USD' ? `<tr class="tot"><td colspan="3">${L('BALANCE DUE', 'SALIO LINALODAIWA')} · ${esc(inv.currency)} @ ${num(inv.fx_rate, 4)}</td><td class="num">${money(bal * Number(inv.fx_rate || 1), inv.currency)}</td></tr>` : ''}</tbody></table>
    ${bal <= 0.009 ? `<div class="stamp" style="color:#1d8a55">PAID · IMELIPWA</div>` : ''}
    <div class="foot">${esc(state.settings.invoice_terms || '')}<br>Exchange rates on the day of payment apply for AED / TZS. · ${esc(publicTrackUrl(b.ref))}</div>
  </div>`;
}

async function receipt(el, id, setTitle) {
  const r = await run(from('v_receipts').select('*').eq('id', id).single());
  const b = await loadBooking(r.shipment_id);
  setTitle(r.ref);
  el.innerHTML = toolbar(`#/shipment/${b.id}`, `<a class="btn" target="_blank" rel="noopener" href="${whatsappLink(b.customer_phone, `Horse Cargo — ${t('receipt')} ${r.ref}\n${t('shipment')}: ${b.ref}\n${t('amount')}: ${money(r.amount, r.currency)}\n${t('balance')}: ${usd(b.balance_usd)}`)}">${icon('whatsapp')}${esc(t('share_whatsapp'))}</a>`) + `
  <div class="doc" style="max-width:620px">
    ${header(L('RECEIPT', 'RISITI'), r.ref, `<div>${fdatetime(r.received_at)}</div>`)}
    ${r.void ? `<div class="stamp" style="color:#c8352e;margin-bottom:10px">VOID · IMEBATILISHWA</div>` : ''}
    <table><tbody>
      <tr><td>${L('Received from', 'Imepokelewa kutoka')}</td><td><b>${esc(b.customer_name)}</b> <span class="mono">(${esc(b.customer_code)})</span></td></tr>
      <tr><td>${L('Booking', 'Booking')}</td><td class="mono">${esc(b.ref)} · ${esc(b.origin_branch)} → ${esc(b.destination_branch)}</td></tr>
      <tr><td>${L('For', 'Kwa ajili ya')}</td><td>Freight & charges / Nauli na gharama</td></tr>
      <tr><td>${L('Method', 'Njia')}</td><td>${esc(t('m_' + r.method))}${r.reference ? ` · ${esc(r.reference)}` : ''}</td></tr>
      <tr class="tot"><td>${L('AMOUNT', 'KIASI')}</td><td style="font-size:18px">${money(r.amount, r.currency)}</td></tr>
      ${r.currency !== 'USD' ? `<tr><td>USD equivalent</td><td>${usd(r.amount_usd)} <span style="color:#777">(@ ${num(r.fx_rate, 4)} ${esc(r.currency)}/USD)</span></td></tr>` : ''}
      <tr><td>${L('Balance after payment', 'Salio baada ya malipo')}</td><td><b>${usd(b.balance_usd)}</b></td></tr>
    </tbody></table>
    <div class="sig"><div>${L('Received by', 'Imepokelewa na')}: ${esc(r.received_by_name || '')}</div><div>${L('Customer signature', 'Sahihi ya mteja')}</div></div>
    <div class="foot">${esc(publicTrackUrl(b.ref))}</div>
  </div>`;
}

async function grn(el, id, setTitle) {
  const b = await loadBooking(id);
  const g = await run(from('grns').select('*').eq('shipment_id', id).single());
  const lines = await run(from('grn_lines').select('*').eq('grn_id', g.id).order('id'));
  const who = await run(from('profiles').select('full_name').eq('id', g.received_by).maybeSingle());
  setTitle(g.ref);
  el.innerHTML = toolbar(`#/shipment/${id}`) + `
  <div class="doc">
    ${header(L('WAREHOUSE RECEIPT', 'RISITI YA GHALA'), g.ref, `<div>${fdatetime(g.received_at)}</div><div>${esc(branchName(g.branch_code))}</div>`)}
    ${parties(b)}
    <p><b>${L('Cargo', 'Mzigo')}:</b> ${esc(b.description)} · ${esc(catName(b) || '')}</p>
    <table><thead><tr><th class="num">#</th><th class="num">${L('Pcs', 'Vipande')}</th><th class="num">L × W × H (cm)</th><th>${L('Packing', 'Ufungaji')}</th><th class="num">kg</th><th class="num">CBM</th></tr></thead>
    <tbody>${lines.map((l, i) => `<tr><td class="num">${i + 1}</td><td class="num">${l.pieces}</td><td class="num">${num(l.length_cm, 1)} × ${num(l.width_cm, 1)} × ${num(l.height_cm, 1)}</td><td>${esc(l.packaging || '')}</td><td class="num">${num(l.weight_kg, 1)}</td><td class="num">${num(l.cbm, 4)}</td></tr>`).join('')}
    <tr class="tot"><td></td><td class="num">${g.pieces}</td><td></td><td></td><td class="num">${num(g.total_kg, 1)}</td><td class="num">${num(g.total_cbm, 3)}</td></tr></tbody></table>
    <p>${L('Volumetric kg', 'Kg za ujazo')}: ${num(g.volumetric_kg, 1)} · ${L('Chargeable kg', 'Kg za kulipia')}: ${num(g.chargeable_kg, 1)} · ${L('Condition', 'Hali')}: <b>${esc(g.condition.toUpperCase())}</b>${g.condition_notes ? ` — ${esc(g.condition_notes)}` : ''}</p>
    <p style="font-size:12px;color:#555">The measured figures above are the basis of the invoice. / Vipimo hivi ndivyo msingi wa ankara.</p>
    <div class="sig"><div>${L('Measured by', 'Imepimwa na')}: ${esc(who?.full_name || '')}</div><div>${L('Delivered by (customer)', 'Imeletwa na (mteja)')}</div></div>
  </div>`;
}

async function labels(el, id, setTitle) {
  const b = await loadBooking(id);
  setTitle(`${t('print_labels')} · ${b.ref}`);
  const n = b.pieces || b.est_pieces || 1;
  const qr = qrSVG(b.ref, 3);
  const cap = Math.min(n, 400);
  el.innerHTML = toolbar(`#/shipment/${id}`) + `
  <p class="no-print muted small" style="text-align:center">${n} ${esc(t('pieces').toLowerCase())}${n > cap ? ` (first ${cap})` : ''}</p>
  <div class="labels">${Array.from({ length: cap }, (_, i) => `
    <div class="label"><div>
      <div class="l1">HORSE CARGO</div>
      <div class="l2">${esc(b.ref)}</div>
      <div class="l3">${esc(branchName(b.destination_branch).toUpperCase())} · ${esc(b.mode.toUpperCase())}</div>
      <div class="l4">PIECE ${i + 1} OF ${n}</div>
      <div style="font-size:11px;margin-top:2px">${esc(b.receiver_name)} · ${esc(b.receiver_phone)}</div>
    </div><div class="qr">${qr}</div></div>`).join('')}</div>`;
}

async function release(el, id, setTitle) {
  const b = await loadBooking(id);
  const r = await run(from('v_releases').select('*').eq('shipment_id', id).single());
  setTitle(r.ref);
  el.innerHTML = toolbar(`#/shipment/${id}`) + `
  <div class="doc">
    ${header(L('RELEASE NOTE', 'HATI YA MAKABIDHIANO'), r.ref, `<div>${fdatetime(r.released_at)}</div><div>${esc(branchName(b.destination_branch))}</div>`)}
    ${parties(b)}
    <table><tbody>
      <tr><td>${L('Cargo', 'Mzigo')}</td><td>${esc(b.description)} · <b>${num(b.pieces, 0)} pcs</b> · ${num(b.cbm, 3)} CBM · ${num(b.actual_kg, 1)} kg</td></tr>
      <tr><td>${L('Collected by', 'Amechukua')}</td><td><b>${esc(r.released_to_name)}</b> · ${esc(r.released_to_phone)}${r.id_number ? ` · ${esc(r.id_type || 'ID')} ${esc(r.id_number)}` : ''}</td></tr>
      <tr><td>${L('Balance at release', 'Salio wakati wa kukabidhi')}</td><td><b>${usd(r.balance_at_release)}</b>${r.override_reason ? ` — override: ${esc(r.override_reason)}` : ''}</td></tr>
      <tr><td>${L('Released by', 'Amekabidhi')}</td><td>${esc(r.released_by_name || '')}</td></tr>
      ${r.notes ? `<tr><td>${L('Notes', 'Maelezo')}</td><td>${esc(r.notes)}</td></tr>` : ''}
    </tbody></table>
    <p style="font-size:12px">I confirm I have received the cargo above in good order and condition, pieces counted. / Nimethibitisha kupokea mzigo huu ukiwa katika hali nzuri na vipande vimehesabiwa.</p>
    <div class="sig"><div>${L('Collector signature', 'Sahihi ya aliyechukua')}</div><div>${L('Horse Cargo officer', 'Afisa wa Horse Cargo')}</div></div>
  </div>`;
}

async function waybill(el, id, setTitle) {
  const b = await loadBooking(id);
  const items = await run(from('v_shipment_items').select('*').eq('shipment_id', id).order('id'));
  setTitle(`${t('waybill')} · ${b.ref}`);
  el.innerHTML = toolbar(`#/shipment/${id}`) + `
  <div class="doc">
    ${header(L('SHIPMENT CONFIRMATION', 'UTHIBITISHO WA SHIPMENT'), b.ref, `<div>${fdate(b.created_at)}</div>`)}
    <div style="display:grid;grid-template-columns:1fr 130px;gap:16px;align-items:start">
      <div>${parties(b)}</div><div class="qr-box">${qrSVG(publicTrackUrl(b.ref))}</div></div>
    <table><thead><tr><th>${L('Cargo', 'Mzigo')}</th><th>${L('Category', 'Aina')}</th><th class="num">${L('Qty', 'Idadi')}</th></tr></thead>
      <tbody>${items.map((i) => `<tr><td>${esc(i.description)}</td><td>${esc(i.category_name || '')}</td><td class="num">${num(i.qty, 2)} ${esc(i.unit)}</td></tr>`).join('')}</tbody></table>
    <table><tbody>
      <tr><td>${L('Chargeable', 'Kinachotozwa')}</td><td>${b.mode === 'sea' ? `${num(b.cbm, 3)} CBM` : `${num(b.weight_kg || b.actual_kg, 1)} kg`} × USD ${num(b.rate_used, 2)}</td></tr>
      <tr><td>${L('Freight', 'Nauli')}</td><td>${usd(b.quoted_amount)}</td></tr>
      <tr><td>${L('Invoice total', 'Jumla ya ankara')}</td><td><b>${usd(b.invoice_total)}</b>${b.invoice_currency && b.invoice_currency !== 'USD' ? ` · ${money(b.invoice_total * Number(b.invoice_fx || 1), b.invoice_currency)}` : ''}</td></tr>
      <tr><td>${L('Paid / Balance', 'Imelipwa / Deni')}</td><td>${usd(b.paid_usd)} / <b>${usd(b.balance_usd)}</b></td></tr>
    </tbody></table>
    <p style="font-size:12px">Mark every carton: <b>HORSE CARGO / ${esc(b.ref)} / ${esc(branchName(b.destination_branch).toUpperCase())} / PIECE n OF N</b>.<br>
    Andika kila katoni: HORSE CARGO / ${esc(b.ref)} / ${esc(branchName(b.destination_branch).toUpperCase())} / KIPANDE n KATI YA N.</p>
    <div class="foot">${L('Track', 'Fuatilia')}: ${esc(publicTrackUrl(b.ref))}</div>
  </div>`;
}
