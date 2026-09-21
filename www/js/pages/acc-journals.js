import { t } from '../i18n.js';
import { from, run, rpc, can, errText, state } from '../api.js';
import { icon, esc, usd, fdate, fdatetime, modal, toast, confirmDialog, busy, empty, $, $$, toCSV, downloadCSV } from '../ui.js';
import { companySelect, getCompany, setCompany, loadAccounts, accName, sourceLabel, TYPES } from '../acc.js';

const ST = ['', 'draft', 'posted', 'rejected'];
const SOURCES = ['', 'manual', 'receipt', 'invoice_line', 'deposit_apply', 'bill', 'bill_payment', 'expense', 'reversal', 'adjustment'];
export const jBadge = (j) => j.status === 'draft' ? `<span class="badge s-pending_deposit">${esc(t('js_draft'))}</span>`
  : j.status === 'rejected' ? `<span class="badge s-cancelled">${esc(t('js_rejected'))}</span>`
  : j.reversed ? `<span class="badge s-cancelled">${esc(t('js_reversed'))}</span>` : `<span class="badge s-ready">${esc(t('js_posted'))}</span>`;

export async function render({ el, setTitle, query }) {
  setTitle(t('acc_journals'));
  if (!can('acc.read')) { el.innerHTML = `<div class="callout danger">${icon('lock')}<div>${esc(t('not_allowed'))}</div></div>`; return; }
  let status = query.get('status') || '';
  el.innerHTML = `
  <div class="page-head"><div class="grow"><h1>${esc(t('acc_journals'))}</h1><p>${esc(t('acc_journals_sub'))}</p></div>
    <div class="row">${companySelect()}
      <select class="input" id="src" style="width:auto">${SOURCES.map((s) => `<option value="${s}">${esc(s ? sourceLabel(s) : t('acc_all_sources'))}</option>`).join('')}</select>
      <button class="btn hide-m" id="csv">${icon('download')}${esc(t('export_csv'))}</button>
      ${can('acc.write') ? `<button class="btn primary" id="new">${icon('plus')}${esc(t('acc_new_journal'))}</button>` : ''}</div></div>
  <div class="card">
    <div class="card-b" style="border-bottom:1px solid var(--line-2)"><div class="chips" id="chips">${ST.map((s) => `<button class="chip" data-v="${s}">${esc(s ? t('js_' + s) : t('all'))}</button>`).join('')}</div></div>
    <div id="list"></div>
  </div>`;
  let rows = [];
  const load = async () => {
    $$('#chips .chip', el).forEach((c) => c.classList.toggle('on', c.dataset.v === status));
    let q = from('v_journals').select('*').order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(300);
    const co = getCompany(); if (co) q = q.eq('company_code', co);
    if (status) q = q.eq('status', status);
    const src = $('#src', el).value; if (src) q = q.eq('source', src);
    rows = await run(q);
    $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>${esc(t('reference'))}</th><th>${esc(t('acc_narration'))}</th><th class="hide-m">${esc(t('acc_source'))}</th><th>${esc(t('status'))}</th><th class="num">USD</th></tr></thead>
      <tbody>${rows.map((j) => `<tr class="click" data-id="${j.id}"><td><b class="mono">${esc(j.ref)}</b><div class="muted small">${fdate(j.entry_date)} · ${esc(j.company_code)}</div></td>
        <td>${esc(j.memo || '')}<div class="muted small">${[j.booking_ref, j.container_no || j.shipment_ref].filter(Boolean).map(esc).join(' · ')}</div></td>
        <td class="hide-m">${esc(sourceLabel(j.source))}</td><td>${jBadge(j)}</td><td class="num">${usd(j.total_usd, { bare: true })}</td></tr>`).join('')}</tbody></table></div>`
      : empty(t('nothing_here'), 'list');
  };
  $('#chips', el).onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; status = c.dataset.v; load(); };
  $('#company', el).onchange = (e) => { setCompany(e.target.value); load(); };
  $('#src', el).onchange = load;
  $('#csv', el).onclick = async () => {
    const ids = rows.map((r) => r.id);
    const lines = ids.length ? await run(from('v_journal_lines').select('*').in('journal_id', ids.slice(0, 300)).order('id')) : [];
    downloadCSV('horse-cargo-journal-lines.csv', toCSV(lines, [
      { label: 'Journal', key: 'journal_ref' }, { label: 'Date', key: 'entry_date' }, { label: 'Company', key: 'company_code' }, { label: 'Source', key: 'source' },
      { label: 'Status', key: 'journal_status' }, { label: 'Account', key: 'account_code' }, { label: 'Account name', key: 'account_name' },
      { label: 'Debit USD', key: 'debit' }, { label: 'Credit USD', key: 'credit' }, { label: 'Currency', key: 'currency' }, { label: 'Amount (txn)', key: 'amount_txn' },
      { label: 'FX', key: 'fx_rate' }, { label: 'Branch', key: 'branch_code' }, { label: 'Booking', key: 'booking_ref' }, { label: 'Container', key: 'container_no' },
      { label: 'Customer', key: 'customer_name' }, { label: 'Supplier', key: 'supplier_name' }, { label: 'Description', key: 'description' }, { label: 'Memo', key: 'memo' }]));
  };
  if ($('#new', el)) $('#new', el).onclick = () => journalModal(load);
  el.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) journalDetail(tr.dataset.id, load); });
  await load();
  if (query.get('new') === '1' && can('acc.write')) journalModal(load);
  if (query.get('id')) journalDetail(query.get('id'), load);
}

export async function journalDetail(id, done) {
  const [j, lines] = await Promise.all([
    run(from('v_journals').select('*').eq('id', id).single()),
    run(from('v_journal_lines').select('*').eq('journal_id', id).order('id')),
  ]);
  const dr = lines.reduce((a, l) => a + Number(l.debit), 0); const cr = lines.reduce((a, l) => a + Number(l.credit), 0);
  const acts = [];
  if (j.status === 'draft' && can('acc.approve')) {
    acts.push(`<button class="btn danger" data-a="reject">${icon('x')}${esc(t('acc_reject'))}</button>`);
    acts.push(`<button class="btn primary" data-a="approve">${icon('check')}${esc(t('acc_approve'))}</button>`);
  }
  if (j.status === 'posted' && j.source === 'manual' && !j.reversed && can('acc.approve')) acts.push(`<button class="btn danger" data-a="reverse">${icon('x')}${esc(t('acc_reverse'))}</button>`);
  modal({
    title: j.ref, wide: true,
    body: `<div class="row" style="gap:8px;margin-bottom:10px">${jBadge(j)}<span class="muted">${esc(j.company_code)} · ${fdate(j.entry_date)} · ${esc(sourceLabel(j.source))}</span></div>
      <p style="margin:0 0 12px">${esc(j.memo || '')}</p>
      ${j.reversal_of_ref ? `<div class="callout info" style="margin-bottom:10px">${icon('info')}<div>${esc(t('acc_reversal_of'))} <b class="mono">${esc(j.reversal_of_ref)}</b></div></div>` : ''}
      <div class="table-wrap"><table class="t"><thead><tr><th>${esc(t('acc_account'))}</th><th>${esc(t('description'))}</th><th class="num">Dr</th><th class="num">Cr</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td><span class="mono small">${esc(l.account_code)}</span> ${esc(l.account_name)}${l.counterparty_company ? ` <span class="badge">IC ${esc(l.counterparty_company)}</span>` : ''}</td>
        <td class="small">${esc(l.description || '')}<div class="muted">${[l.branch_code, l.booking_ref, l.container_no, l.customer_name, l.supplier_name, l.currency !== 'USD' ? `${l.currency} ${Number(l.amount_txn).toLocaleString()} @ ${l.fx_rate}` : ''].filter(Boolean).map(esc).join(' · ')}</div></td>
        <td class="num">${Number(l.debit) ? usd(l.debit, { bare: true }) : ''}</td><td class="num">${Number(l.credit) ? usd(l.credit, { bare: true }) : ''}</td></tr>`).join('')}
        <tr style="font-weight:700"><td colspan="2">${esc(t('total'))}</td><td class="num">${usd(dr, { bare: true })}</td><td class="num">${usd(cr, { bare: true })}</td></tr></tbody></table></div>
      <p class="muted small" style="margin-top:10px">${esc(t('acc_prepared_by'))}: ${esc(j.created_by_name || t('acc_system'))} · ${fdatetime(j.created_at)}${j.approved_by_name ? ` — ${esc(t('acc_approved_by'))}: ${esc(j.approved_by_name)} · ${fdatetime(j.approved_at)}` : ''}</p>`,
    foot: `<button class="btn" data-close>${esc(t('close'))}</button>${acts.join('')}`,
    onMount: (m) => {
      m.el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]'); if (!b) return;
        try {
          if (b.dataset.a === 'approve') await busy(b, () => rpc('acc_approve_journal', { p_journal: j.id, p_approve: true, p_reason: null }));
          if (b.dataset.a === 'reject') {
            const reason = await confirmDialog(`${t('acc_reject')} ${j.ref}?`, { danger: true, withReason: true, okText: t('acc_reject') });
            if (!reason) return;
            await rpc('acc_approve_journal', { p_journal: j.id, p_approve: false, p_reason: reason });
          }
          if (b.dataset.a === 'reverse') {
            const reason = await confirmDialog(`${t('acc_reverse')} ${j.ref}?`, { danger: true, withReason: true, okText: t('acc_reverse') });
            if (!reason) return;
            await rpc('acc_reverse_journal', { p_journal: j.id, p_reason: reason });
          }
          m.close(); toast(t('saved')); done && done();
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}

export async function journalModal(done) {
  const all = await loadAccounts();
  const co0 = getCompany() || state.companies[0]?.code;
  const lineRow = () => `<tr class="jl">
    <td style="min-width:220px"><select class="input acc"></select></td>
    <td><input class="input desc" placeholder="${esc(t('description'))}"></td>
    <td style="width:120px"><input class="input dr" type="number" step="0.01" min="0" inputmode="decimal"></td>
    <td style="width:120px"><input class="input cr" type="number" step="0.01" min="0" inputmode="decimal"></td>
    <td style="width:40px"><button type="button" class="icon-btn rm">${icon('trash')}</button></td></tr>`;
  modal({
    title: t('acc_new_journal'), wide: true,
    body: `<form class="form" id="jf" novalidate>
      <div class="field"><label class="req">${esc(t('company'))}</label>${companySelect('jco', co0, false)}</div>
      <div class="field"><label>${esc(t('date'))}</label><input class="input" type="date" name="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field full"><label class="req">${esc(t('acc_narration'))}</label><input class="input" name="memo" required></div>
    </form>
    <div class="table-wrap" style="margin-top:12px"><table class="t"><thead><tr><th>${esc(t('acc_account'))}</th><th>${esc(t('description'))}</th><th class="num">Dr USD</th><th class="num">Cr USD</th><th></th></tr></thead>
      <tbody id="jlines">${lineRow()}${lineRow()}</tbody>
      <tfoot><tr><td><button type="button" class="btn sm" id="addl">${icon('plus')}${esc(t('add_line'))}</button></td><td class="right muted" id="jdiff"></td>
        <td class="num" id="jdr"></td><td class="num" id="jcr"></td><td></td></tr></tfoot></table></div>
    <div class="callout info" style="margin-top:12px">${icon('info')}<div>${esc(t('acc_journal_hint'))}</div></div>`,
    foot: `<button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="js">${icon('check')}${esc(t('acc_submit_approval'))}</button>`,
    onMount: (m) => {
      const q = (s) => m.el.querySelector(s);
      const opts = () => {
        const co = q('#jco').value;
        return TYPES.map((ty) => {
          const list = all.filter((a) => a.company_code === co && a.active && a.type === ty);
          return list.length ? `<optgroup label="${esc(t('at_' + ty))}">${list.map((a) => `<option value="${a.id}">${a.code} · ${esc(accName(a))}</option>`).join('')}</optgroup>` : '';
        }).join('');
      };
      const fill = (sel) => { const v = sel.value; sel.innerHTML = `<option value="">—</option>` + opts(); if ([...sel.options].some((o) => o.value === v)) sel.value = v; };
      const tot = () => {
        let dr = 0, cr = 0;
        m.el.querySelectorAll('.jl').forEach((r) => { dr += Number(r.querySelector('.dr').value || 0); cr += Number(r.querySelector('.cr').value || 0); });
        q('#jdr').textContent = usd(dr, { bare: true }); q('#jcr').textContent = usd(cr, { bare: true });
        const d = Math.round((dr - cr) * 100) / 100;
        q('#jdiff').innerHTML = d ? `<span style="color:var(--red);font-weight:700">${esc(t('acc_difference'))}: ${usd(d, { bare: true })}</span>` : (dr ? `<span style="color:var(--green);font-weight:700">✓ ${esc(t('acc_balanced'))}</span>` : '');
        return { dr, cr, d };
      };
      m.el.querySelectorAll('.acc').forEach(fill);
      q('#jco').onchange = () => m.el.querySelectorAll('.acc').forEach(fill);
      q('#addl').onclick = () => { q('#jlines').insertAdjacentHTML('beforeend', lineRow()); fill(q('#jlines').lastElementChild.querySelector('.acc')); };
      q('#jlines').addEventListener('click', (e) => { if (e.target.closest('.rm') && m.el.querySelectorAll('.jl').length > 2) { e.target.closest('tr').remove(); tot(); } });
      q('#jlines').addEventListener('input', (e) => {
        const r = e.target.closest('tr');
        if (e.target.classList.contains('dr') && e.target.value) r.querySelector('.cr').value = '';
        if (e.target.classList.contains('cr') && e.target.value) r.querySelector('.dr').value = '';
        tot();
      });
      q('#js').onclick = (ev) => busy(ev.currentTarget, async () => {
        const f = q('#jf');
        const { dr, d } = tot();
        if (!f.memo.value.trim()) { toast(t('required_fields'), 'err'); return; }
        if (d || !dr) { toast(t('acc_not_balanced'), 'err'); return; }
        const lines = [...m.el.querySelectorAll('.jl')].map((r) => ({
          account_id: r.querySelector('.acc').value, description: r.querySelector('.desc').value || null,
          debit: Number(r.querySelector('.dr').value || 0), credit: Number(r.querySelector('.cr').value || 0),
        })).filter((l) => l.debit || l.credit);
        if (lines.some((l) => !l.account_id)) { toast(t('required_fields'), 'err'); return; }
        try {
          const r = await rpc('acc_create_journal', { p: { company_code: q('#jco').value, entry_date: f.date.value, memo: f.memo.value.trim(), lines } });
          m.close(); toast(`${t('acc_sent_for_approval')} · ${r.ref}`); done && done();
        } catch (err) { toast(errText(err), 'err'); }
      });
    },
  });
}
