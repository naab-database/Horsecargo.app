import { t } from '../i18n.js';
import { rpc, can, errText, state } from '../api.js';
import { icon, esc, usd, num, fdate, modeTag, statusBadge, modal, empty, $, $$, toCSV, downloadCSV } from '../ui.js';
import { companySelect, getCompany, setCompany, accName, signed } from '../acc.js';

const TABS = ['pl', 'bs', 'tb', 'ships'];
const firstOfYear = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);
const IC = ['IC_DUE_FROM', 'IC_DUE_TO'];
const dc = (r) => Number(r.opening) + Number(r.debit) - Number(r.credit);   // closing, debit positive
const mv = (r) => Number(r.debit) - Number(r.credit);                        // period movement
const nm = (r) => accName({ name: r.name, name_sw: r.name_sw });
const key = (r, col) => (r.is_money ? `${r.code}@${col || r.company}` : r.code);
const amt = (v) => `<span style="${v < -0.004 ? 'color:var(--red)' : ''}">${signed(v)}</span>`;

export async function render({ el, setTitle, query }) {
  setTitle(t('acc_reports'));
  if (!can('acc.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  let tab = TABS.includes(query.get('tab')) ? query.get('tab') : 'pl';
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('acc_reports'))}</h1><p>${esc(t('acc_book_ccy'))}</p></div>
    <div class="row">${companySelect()}
      <label class="small muted" id="l1">${esc(t('from'))}</label><input class="input" type="date" id="d1" value="${firstOfYear()}" style="width:auto">
      <label class="small muted">${esc(t('to'))}</label><input class="input" type="date" id="d2" value="${today()}" style="width:auto">
      <button class="btn" id="csv">${icon('download')}${esc(t('export_csv'))}</button></div></div>
  <div class="card">
    <div class="tabs" id="tabs">${TABS.map((k) => `<button data-tab="${k}">${esc(t('acc_tab_' + k))}</button>`).join('')}</div>
    <div id="out"></div>
  </div>`;
  let csv = null;
  const out = $('#out', el);
  const cols = () => { const co = getCompany(); return co ? [co] : [...state.companies.map((c) => c.code), '']; };
  const colName = (c) => c || t('acc_group');
  const tbFor = async (c, d1, d2) => rpc('acc_trial_balance', { p_company: c || null, p_from: d1, p_to: d2 });

  const load = async () => {
    $$('#tabs button', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const d1 = $('#d1', el).value; const d2 = $('#d2', el).value;
    $('#d1', el).style.display = $('#l1', el).style.display = tab === 'bs' ? 'none' : '';
    out.innerHTML = `<div class="boot" style="min-height:30vh"><div class="spinner"></div></div>`;
    try {
      if (tab === 'tb') await trialBalance(d1, d2);
      else if (tab === 'pl') await profitLoss(d1, d2);
      else if (tab === 'bs') await balanceSheet(d2);
      else await ships(d1, d2);
    } catch (err) { out.innerHTML = `<div class="card-b"><div class="callout danger">${icon('alert')}<div>${esc(errText(err))}</div></div></div>`; }
  };

  async function trialBalance(d1, d2) {
    const co = getCompany();
    const rows = (await tbFor(co, d1, d2)).filter((r) => Number(r.opening) || Number(r.debit) || Number(r.credit));
    const tot = rows.reduce((a, r) => { const c = dc(r); a.o += Number(r.opening); a.d += Number(r.debit); a.c += Number(r.credit); a.cd += c > 0 ? c : 0; a.cc += c < 0 ? -c : 0; return a; }, { o: 0, d: 0, c: 0, cd: 0, cc: 0 });
    const ok = Math.abs(tot.cd - tot.cc) < 0.01;
    out.innerHTML = `<div class="card-b"><div class="callout ${ok ? 'ok' : 'danger'}">${icon(ok ? 'check' : 'alert')}<div>${esc(ok ? t('acc_tb_balanced') : t('acc_tb_unbalanced'))} · ${esc(co || t('acc_group'))} · ${fdate(d1)} → ${fdate(d2)}</div></div></div>
      ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('acc_code'))}</th><th>${esc(t('acc_account'))}</th><th class="num hide-m">${esc(t('acc_opening'))}</th><th class="num">${esc(t('acc_debits'))}</th><th class="num">${esc(t('acc_credits'))}</th><th class="num">${esc(t('acc_closing'))} Dr</th><th class="num">${esc(t('acc_closing'))} Cr</th></tr></thead>
      <tbody>${rows.map((r) => { const c = dc(r); return `<tr class="click" data-code="${esc(r.code)}" data-co="${esc(r.company || '')}"><td class="mono">${esc(r.code)}</td><td>${esc(nm(r))}<div class="muted small">${esc(t('at_' + r.type))}</div></td>
        <td class="num hide-m">${signed(Number(r.opening))}</td><td class="num">${usd(r.debit, { bare: true })}</td><td class="num">${usd(r.credit, { bare: true })}</td>
        <td class="num">${c > 0.004 ? usd(c, { bare: true }) : ''}</td><td class="num">${c < -0.004 ? usd(-c, { bare: true }) : ''}</td></tr>`; }).join('')}
        <tr style="font-weight:800;border-top:2px solid var(--line)"><td></td><td>${esc(t('total'))}</td><td class="num hide-m">${signed(tot.o)}</td><td class="num">${usd(tot.d, { bare: true })}</td><td class="num">${usd(tot.c, { bare: true })}</td><td class="num">${usd(tot.cd, { bare: true })}</td><td class="num">${usd(tot.cc, { bare: true })}</td></tr>
      </tbody></table></div>` : empty(t('nothing_here'), 'list')}`;
    csv = () => downloadCSV(`horse-cargo-trial-balance-${co || 'group'}-${d2}.csv`, toCSV(rows.map((r) => ({ ...r, closing: dc(r) })), [
      { label: 'Code', key: 'code' }, { label: 'Account', key: 'name' }, { label: 'Type', key: 'type' }, { label: 'Opening', key: 'opening' },
      { label: 'Debit', key: 'debit' }, { label: 'Credit', key: 'credit' }, { label: 'Closing (Dr+/Cr-)', key: 'closing' }]));
  }

  // generic statement renderer: sections of {title, types, sign, rows}, several company columns
  function statement(sets, sections, totals) {
    const C = sets.length;
    const head = `<tr><th>${esc(t('acc_account'))}</th>${sets.map((s) => `<th class="num">${esc(colName(s.col))}</th>`).join('')}</tr>`;
    const body = sections.map((sec) => {
      if (sec.total) return `<tr style="font-weight:800;background:var(--line-2)"><td>${esc(sec.title)}</td>${sets.map((s, i) => `<td class="num">${amt(sec.total(i))}</td>`).join('')}</tr>`;
      const codes = [...new Set(sets.flatMap((s) => s.rows.filter(sec.filter).filter((r) => Math.abs(sec.value(r)) > 0.004).map((r) => key(r, s.col))))].sort();
      const sub = (i) => sets[i].rows.filter(sec.filter).reduce((a, r) => a + sec.value(r), 0);
      sec.sub = sub;
      const find = (i, k) => sets[i].rows.find((r) => key(r, sets[i].col) === k);
      return `<tr><td colspan="${C + 1}" style="font-weight:700;color:var(--brand);padding-top:14px">${esc(sec.title)}</td></tr>
        ${codes.map((code) => { const any = sets.map((_, i) => find(i, code)).find(Boolean); const co = code.split('@')[1] || ''; return `<tr class="click" data-code="${esc(any.code)}" data-co="${esc(co)}"><td style="padding-left:22px"><span class="mono small muted">${esc(any.code)}</span> ${co && !nm(any).startsWith(co) ? `${esc(co)} · ` : ''}${esc(nm(any))}</td>
          ${sets.map((_, i) => { const r = find(i, code); return `<td class="num">${r ? amt(sec.value(r)) : ''}</td>`; }).join('')}</tr>`; }).join('')}
        ${sec.extra ? sec.extra.map((x) => `<tr><td style="padding-left:22px">${esc(x.title)}</td>${sets.map((_, i) => `<td class="num">${amt(x.value(i))}</td>`).join('')}</tr>`).join('') : ''}
        <tr style="font-weight:700"><td>${esc(t('total'))} ${esc(sec.title.toLowerCase())}</td>${sets.map((_, i) => `<td class="num" style="border-top:1px solid var(--line)">${amt(sub(i) + (sec.extra ? sec.extra.reduce((a, x) => a + x.value(i), 0) : 0))}</td>`).join('')}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="t"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  async function profitLoss(d1, d2) {
    const cs = cols();
    const sets = await Promise.all(cs.map(async (col) => ({ col, rows: await tbFor(col, d1, d2) })));
    const sum = (i, types, f) => sets[i].rows.filter((r) => types.includes(r.type)).reduce((a, r) => a + f(r), 0);
    const rev = (i) => sum(i, ['revenue', 'contra_revenue'], (r) => -mv(r));
    const cos = (i) => sum(i, ['cost_of_sales'], mv);
    const exp = (i) => sum(i, ['expense'], mv);
    const sections = [
      { title: t('acc_revenue'), filter: (r) => r.type === 'revenue', value: (r) => -mv(r) },
      { title: t('acc_sales_discounts'), filter: (r) => r.type === 'contra_revenue', value: (r) => -mv(r) },
      { title: t('acc_net_revenue'), total: rev },
      { title: t('acc_cos'), filter: (r) => r.type === 'cost_of_sales', value: mv },
      { title: t('acc_gross_profit'), total: (i) => rev(i) - cos(i) },
      { title: t('acc_opex'), filter: (r) => r.type === 'expense', value: mv },
      { title: t('acc_net_profit'), total: (i) => rev(i) - cos(i) - exp(i) },
    ];
    const gi = sets.length - 1;
    const margin = rev(gi) ? ((rev(gi) - cos(gi) - exp(gi)) / rev(gi) * 100).toFixed(1) : null;
    out.innerHTML = `<div class="card-b"><div class="grid c4">
        <div class="card kpi" style="box-shadow:none"><div class="k">${esc(t('acc_net_revenue'))}</div><div class="v">${usd(rev(gi))}</div></div>
        <div class="card kpi" style="box-shadow:none"><div class="k">${esc(t('acc_gross_profit'))}</div><div class="v">${amt(rev(gi) - cos(gi))}</div></div>
        <div class="card kpi" style="box-shadow:none"><div class="k">${esc(t('acc_net_profit'))}</div><div class="v">${amt(rev(gi) - cos(gi) - exp(gi))}</div></div>
        <div class="card kpi" style="box-shadow:none"><div class="k">${esc(t('acc_margin'))}</div><div class="v">${margin !== null ? margin + '%' : '—'}</div></div></div>
      <p class="muted small" style="margin:10px 0 0">${fdate(d1)} → ${fdate(d2)} · ${esc(t('acc_pl_hint'))}</p></div>
      ${statement(sets, sections)}`;
    csv = () => downloadCSV(`horse-cargo-pl-${d1}-${d2}.csv`, toCSV(plRows(sets, ['revenue', 'contra_revenue', 'cost_of_sales', 'expense'], mv), csvCols(sets)));
  }

  async function balanceSheet(d2) {
    const cs = cols();
    const sets = await Promise.all(cs.map(async (col) => {
      const rows = await tbFor(col, '1900-01-01', d2);
      return { col, rows: col ? rows : rows.filter((r) => !IC.includes(r.system_key)), icNet: col ? 0 : rows.filter((r) => IC.includes(r.system_key)).reduce((a, r) => a + dc(r), 0) };
    }));
    const sum = (i, types, f) => sets[i].rows.filter((r) => types.includes(r.type)).reduce((a, r) => a + f(r), 0);
    const earnings = (i) => -sum(i, ['revenue', 'contra_revenue', 'cost_of_sales', 'expense'], dc);
    const assets = (i) => sum(i, ['asset'], dc);
    const liab = (i) => -sum(i, ['liability'], dc);
    const equity = (i) => -sum(i, ['equity'], dc) + earnings(i);
    const sections = [
      { title: t('at_asset'), filter: (r) => r.type === 'asset', value: dc },
      { title: t('at_liability'), filter: (r) => r.type === 'liability', value: (r) => -dc(r) },
      { title: t('at_equity'), filter: (r) => r.type === 'equity', value: (r) => -dc(r), extra: [{ title: t('acc_current_earnings'), value: earnings }] },
      { title: t('acc_total_le'), total: (i) => liab(i) + equity(i) },
    ];
    const diffs = sets.map((_, i) => assets(i) - liab(i) - equity(i));
    const ok = diffs.every((d) => Math.abs(d) < 0.01);
    const ic = sets.find((s) => !s.col)?.icNet || 0;
    out.innerHTML = `<div class="card-b stack" style="gap:8px">
      <div class="callout ${ok ? 'ok' : 'danger'}">${icon(ok ? 'check' : 'alert')}<div>${esc(ok ? t('acc_bs_balanced') : t('acc_bs_unbalanced'))} · ${esc(t('acc_as_at'))} ${fdate(d2)}</div></div>
      ${sets.length > 1 ? `<div class="callout ${Math.abs(ic) < 0.01 ? 'info' : 'warn'}">${icon('info')}<div>${esc(t('acc_ic_eliminated'))}${Math.abs(ic) >= 0.01 ? ` — ${esc(t('acc_ic_mismatch'))}: ${usd(ic)}` : ''}</div></div>` : ''}</div>
      ${statement(sets, sections)}`;
    csv = () => downloadCSV(`horse-cargo-balance-sheet-${d2}.csv`, toCSV(plRows(sets, ['asset', 'liability', 'equity'], dc), csvCols(sets)));
  }

  const plRows = (sets, types, f) => {
    const codes = [...new Set(sets.flatMap((s) => s.rows.filter((r) => types.includes(r.type)).map((r) => key(r, s.col))))].sort();
    return codes.map((k) => {
      const any = sets.map((s) => s.rows.find((r) => key(r, s.col) === k)).find(Boolean);
      const co = k.split('@')[1] || '';
      const o = { code: any.code, name: (co && !any.name.startsWith(co) ? co + ' · ' : '') + any.name, type: any.type };
      sets.forEach((s) => { const r = s.rows.find((x) => key(x, s.col) === k); o['c_' + (s.col || 'group')] = r ? f(r) : 0; });
      return o;
    }).filter((o) => sets.some((s) => Math.abs(o['c_' + (s.col || 'group')]) > 0.004));
  };
  const csvCols = (sets) => [{ label: 'Code', key: 'code' }, { label: 'Account', key: 'name' }, { label: 'Type', key: 'type' },
    ...sets.map((s) => ({ label: `${s.col || 'Group'} USD (Dr+/Cr-)`, key: 'c_' + (s.col || 'group') }))];

  async function ships(d1, d2) {
    const co = getCompany();
    const rows = (await rpc('acc_shipments_pnl', { p_from: d1, p_to: d2 })).filter((r) => !co || r.company === co);
    const tot = rows.reduce((a, r) => ({ rev: a.rev + r.revenue, cost: a.cost + r.cost, cbm: a.cbm + Number(r.cbm) }), { rev: 0, cost: 0, cbm: 0 });
    out.innerHTML = `<div class="card-b"><div class="grid c4">
        <div class="card kpi" style="box-shadow:none"><div class="k">${esc(t('shipments'))}</div><div class="v">${rows.length}</div><div class="s">${num(tot.cbm, 1)} CBM</div></div>
        <div class="card kpi" style="box-shadow:none"><div class="k">${esc(t('acc_revenue'))}</div><div class="v">${usd(tot.rev)}</div></div>
        <div class="card kpi" style="box-shadow:none"><div class="k">${esc(t('acc_cos'))}</div><div class="v">${usd(tot.cost)}</div></div>
        <div class="card kpi" style="box-shadow:none"><div class="k">${esc(t('acc_gross_profit'))}</div><div class="v">${amt(tot.rev - tot.cost)}</div></div></div>
      <p class="muted small" style="margin:10px 0 0">${esc(t('acc_ship_pnl_hint'))}</p></div>
      ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('shipment_no'))}</th><th class="hide-m">${esc(t('status'))}</th><th class="num hide-m">${esc(t('measure'))}</th>
        <th class="num">${esc(t('acc_revenue'))}</th><th class="num">${esc(t('acc_cost'))}</th><th class="num">${esc(t('acc_profit'))}</th><th class="num hide-m">%</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="click" data-ship="${r.id}"><td>${modeTag(r.mode)} <b class="mono">${esc(r.ref)}</b><div class="muted small">${esc(r.customer || '')} · ${esc(r.company)} · ${esc(r.origin)}→${esc(r.destination)} · ${fdate(r.created_at)}</div></td>
          <td class="hide-m">${statusBadge(r.status)}</td><td class="num hide-m">${r.mode === 'sea' ? num(r.cbm, 2) : num(r.kg, 1)}</td>
          <td class="num">${usd(r.revenue, { bare: true })}</td><td class="num">${usd(r.cost, { bare: true })}</td><td class="num" style="font-weight:700">${amt(r.profit)}</td>
          <td class="num hide-m">${r.margin_pct ?? '—'}</td></tr>`).join('')}</tbody></table></div>` : empty(t('nothing_here'), 'box')}`;
    csv = () => downloadCSV(`horse-cargo-shipment-pnl-${d1}-${d2}.csv`, toCSV(rows, [
      { label: 'Shipment', key: 'ref' }, { label: 'Customer', key: 'customer' }, { label: 'Mode', key: 'mode' }, { label: 'Company', key: 'company' },
      { label: 'Origin', key: 'origin' }, { label: 'Destination', key: 'destination' }, { label: 'Status', key: 'status' }, { label: 'Created', key: 'created_at' },
      { label: 'CBM', key: 'cbm' }, { label: 'Weight kg', key: 'kg' }, { label: 'Revenue USD', key: 'revenue' }, { label: 'Cost USD', key: 'cost' },
      { label: 'Profit USD', key: 'profit' }, { label: 'Margin %', key: 'margin_pct' }]));
  }

  $('#tabs', el).onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (!b) return; tab = b.dataset.tab; history.replaceState(null, '', `#/acc/reports?tab=${tab}`); load(); };
  $('#company', el).onchange = (e) => { setCompany(e.target.value); load(); };
  $('#d1', el).onchange = load; $('#d2', el).onchange = load;
  $('#csv', el).onclick = () => csv && csv();
  el.addEventListener('click', (e) => {
    const s = e.target.closest('tr[data-ship]'); if (s) return shipmentPnlModal(s.dataset.ship);
    const a = e.target.closest('tr[data-code]'); if (a) { if (a.dataset.co) setCompany(a.dataset.co); location.hash = `#/acc/account/${a.dataset.code}`; }
  });
  await load();
}

export function pnlBody(p) {
  const unit = p.shipment.mode === 'air' ? 'kg' : 'CBM';
  const qty = p.shipment.mode === 'air' ? p.shipment.weight_kg : p.shipment.cbm;
  return `<div class="money" style="margin-bottom:12px">
      <div><div class="k">${esc(t('acc_revenue'))}</div><div class="v">${usd(p.revenue)}</div></div>
      <div><div class="k">${esc(t('acc_cost'))}</div><div class="v">${usd(p.cost)}</div></div>
      <div><div class="k">${esc(t('acc_profit'))}</div><div class="v ${p.profit < 0 ? 'due' : 'ok'}">${usd(p.profit)}</div></div>
      <div><div class="k">${esc(t('acc_margin'))}</div><div class="v">${p.margin_pct ?? '—'}%</div></div></div>
    <p class="muted small">${esc(t('measure'))}: ${num(qty, unit === 'CBM' ? 3 : 1)} ${unit} · ${esc(p.shipment.origin)}→${esc(p.shipment.destination)}</p>
    <h3 style="margin:16px 0 6px;font-size:14px">${esc(t('acc_revenue'))}</h3>
    ${p.revenue_lines.length ? `<div class="table-wrap"><table class="t"><tbody>${p.revenue_lines.map((c) => `<tr>
      <td class="nowrap small">${fdate(c.date)}</td><td><span class="mono small">${esc(c.code)}</span> ${esc(c.account)}<div class="muted small">${esc(c.description || '')}</div></td>
      <td class="num">${usd(c.amount, { bare: true })}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted small">—</p>`}
    <h3 style="margin:16px 0 6px;font-size:14px">${esc(t('acc_cost_lines'))}</h3>
    ${p.cost_lines.length ? `<div class="table-wrap"><table class="t"><tbody>${p.cost_lines.map((c) => `<tr>
      <td class="nowrap small">${fdate(c.date)}</td><td><span class="mono small">${esc(c.code)}</span> ${esc(c.account)}<div class="muted small">${esc(c.description || '')} · ${esc(c.journal)}</div></td>
      <td class="num">${usd(c.amount, { bare: true })}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted small">${esc(t('acc_no_costs'))}</p>`}`;
}

export async function shipmentPnlModal(id) {
  try {
    const p = await rpc('acc_shipment_pnl', { p_shipment: id });
    modal({
      title: `${t('acc_shipment_pnl')} · ${p.shipment.ref}`, wide: true, body: pnlBody(p),
      foot: `<button class="btn" data-close>${esc(t('close'))}</button>${can('acc.write') ? `<a class="btn" data-close href="#/acc/expenses?new=1&shipment=${p.shipment.id}">${icon('plus')}${esc(t('acc_new_expense'))}</a><a class="btn primary" data-close href="#/acc/bills/new?shipment=${p.shipment.id}">${icon('plus')}${esc(t('acc_add_cost'))}</a>` : ''}
        <a class="btn" data-close href="#/shipment/${p.shipment.id}">${icon('box')}${esc(t('open'))}</a>`,
    });
  } catch (err) { const { toast } = await import('../ui.js'); toast(errText(err), 'err'); }
}
