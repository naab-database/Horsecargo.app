import { t } from '../i18n.js';
import { from, run, rpc, can, errText } from '../api.js';
import { icon, esc, usd, money, fdate, modal, toast, confirmDialog, busy, empty, $ } from '../ui.js';
import { loadMoneyAccounts, moneyOptions, sourceLabel } from '../acc.js';
import { billBadge } from './acc-bills.js';

export async function render({ el, params, setTitle, rerender }) {
  const b = await run(from('v_bills').select('*').eq('id', params[0]).single());
  const [lines, pays, jls] = await Promise.all([
    run(from('v_bill_lines').select('*').eq('bill_id', b.id).order('id')),
    run(from('v_bill_payments').select('*').eq('bill_id', b.id).order('created_at')),
    run(from('v_journal_lines').select('*').in('source_id', [b.id]).order('id')),
  ]);
  const payIds = pays.map((p) => p.id);
  const payJls = payIds.length ? await run(from('v_journal_lines').select('*').in('source_id', payIds).order('id')) : [];
  setTitle(b.ref);
  const open = ['open', 'part_paid'].includes(b.status);
  el.innerHTML = `
  <div class="page-head">
    <div class="grow"><div class="row" style="gap:8px">${billBadge(b.status)}<span class="muted">${esc(b.company_code)} · ${esc(b.branch_code)}</span></div>
      <h1 class="mono" style="margin-top:4px">${esc(b.ref)}</h1><p>${esc(b.supplier_name)}${b.supplier_invoice_no ? ' · #' + esc(b.supplier_invoice_no) : ''}</p></div>
    <div class="row">
      ${open && can('acc.write') ? `<button class="btn primary" data-act="pay">${icon('money')}${esc(t('acc_pay_bill'))}</button>` : ''}
      ${b.status !== 'void' && can('acc.approve') && !pays.some((p) => !p.void) ? `<button class="btn danger" data-act="void">${icon('x')}${esc(t('void'))}</button>` : ''}
    </div>
  </div>
  ${b.status === 'void' ? `<div class="callout danger" style="margin-bottom:14px">${icon('x')}<div>${esc(t('voided'))}: ${esc(b.void_reason || '')}</div></div>` : ''}
  <div class="stack">
    <div class="card"><div class="money">
      <div><div class="k">${esc(t('total'))}</div><div class="v">${money(b.total_txn, b.currency)}</div></div>
      <div><div class="k">USD</div><div class="v">${usd(b.total_usd)}</div></div>
      <div><div class="k">${esc(t('paid'))}</div><div class="v ok">${usd(b.paid_usd)}</div></div>
      <div><div class="k">${esc(t('balance'))}</div><div class="v ${b.balance_usd > 0.009 && b.status !== 'void' ? 'due' : 'ok'}">${usd(b.status === 'void' ? 0 : b.balance_usd)}</div></div>
    </div></div>
    <div class="split">
      <div class="stack">
        <div class="card"><div class="card-h"><h2>${esc(t('acc_lines'))}</h2><span class="muted small">${fdate(b.bill_date)}${b.due_date ? ' → ' + fdate(b.due_date) : ''}</span></div>
          <div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('acc_account'))}</th><th>${esc(t('description'))}</th><th>${esc(t('shipment_no'))}</th><th class="num">${esc(t('amount'))}</th><th class="num">USD</th></tr></thead>
          <tbody>${lines.map((l) => `<tr><td class="mono">${esc(l.account_code)}</td><td>${esc(l.description)}</td>
            <td>${l.shipment_id ? `<a class="mono" href="#/shipment/${l.shipment_id}">${esc(l.shipment_ref)}</a>` : l.shipment_id ? `<a class="mono" href="#/shipment/${l.shipment_id}">${esc(l.shipment_ref)}</a>` : '—'}</td>
            <td class="num nowrap">${money(l.amount_txn, b.currency)}</td><td class="num">${usd(l.amount_usd, { bare: true })}</td></tr>`).join('')}</tbody></table></div></div>
        <div class="card"><div class="card-h"><h2>${esc(t('acc_payments'))}</h2></div>
          ${pays.length ? `<div class="table-wrap"><table class="t"><tbody>${pays.map((p) => `<tr style="${p.void ? 'opacity:.5;text-decoration:line-through' : ''}">
            <td><b class="mono">${esc(p.ref)}</b><div class="muted small">${fdate(p.paid_on)} · ${esc(p.money_account_name)}${p.reference ? ' · ' + esc(p.reference) : ''}</div></td>
            <td class="num nowrap">${money(p.amount_txn, b.currency)}</td><td class="num">${usd(p.amount_usd)}</td>
            <td class="right">${!p.void && can('acc.approve') ? `<button class="icon-btn" data-act="voidpay" data-id="${p.id}" title="${esc(t('void'))}">${icon('trash')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty(t('no_payments'), 'money')}
        </div>
      </div>
      <div class="card"><div class="card-h"><h2>${esc(t('acc_ledger_postings'))}</h2></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('acc_account'))}</th><th class="num">Dr</th><th class="num">Cr</th></tr></thead>
        <tbody>${[...jls, ...payJls].map((l) => `<tr><td><span class="mono small">${esc(l.company_code)} ${esc(l.account_code)}</span> ${esc(l.account_name)}<div class="muted small">${esc(l.journal_ref)} · ${esc(sourceLabel(l.source))}</div></td>
          <td class="num">${l.debit ? usd(l.debit, { bare: true }) : ''}</td><td class="num">${l.credit ? usd(l.credit, { bare: true }) : ''}</td></tr>`).join('')}</tbody></table></div></div>
    </div>
  </div>`;

  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'pay') {
      const accs = await loadMoneyAccounts();
      modal({
        title: `${t('acc_pay_bill')} · ${b.ref}`,
        body: `<form class="form" id="pf" novalidate>
          <div class="field full"><label class="req">${esc(t('acc_paid_from'))}</label><select class="input" name="acc">${moneyOptions(accs, '', b.company_code)}</select></div>
          <div class="field"><label class="req">${esc(t('amount'))} (${esc(b.currency)})</label><input class="input" type="number" step="0.01" name="amount" value="${(b.balance_usd * b.fx_rate).toFixed(2)}"></div>
          <div class="field"><label>${esc(t('date'))}</label><input class="input" type="date" name="date" value="${new Date().toISOString().slice(0, 10)}"></div>
          <div class="field full"><label>${esc(t('txn_ref'))}</label><input class="input" name="ref"></div></form>`,
        foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="ps">${icon('check')}${esc(t('save'))}</button>`,
        onMount: (m) => {
          m.el.querySelector('#ps').onclick = (ev) => busy(ev.currentTarget, async () => {
            const f = m.el.querySelector('#pf');
            try { await rpc('acc_pay_bill', { p_bill: b.id, p_account: f.acc.value, p_amount: Number(f.amount.value), p_date: f.date.value, p_reference: f.ref.value || null }); m.close(); toast(t('saved')); rerender(); } catch (err) { toast(errText(err), 'err'); }
          });
        },
      });
    }
    if (a.dataset.act === 'void') {
      const reason = await confirmDialog(`${t('void')} ${b.ref}?`, { danger: true, withReason: true, okText: t('void') });
      if (!reason) return;
      try { await rpc('acc_void_bill', { p_bill: b.id, p_reason: reason }); toast(t('saved')); rerender(); } catch (err) { toast(errText(err), 'err'); }
    }
    if (a.dataset.act === 'voidpay') {
      const reason = await confirmDialog(`${t('void')}?`, { danger: true, withReason: true, okText: t('void') });
      if (!reason) return;
      try { await rpc('acc_void_bill_payment', { p_payment: a.dataset.id, p_reason: reason }); toast(t('saved')); rerender(); } catch (err) { toast(errText(err), 'err'); }
    }
  });
}
