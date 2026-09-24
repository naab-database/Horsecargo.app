import { createClient } from '@supabase/supabase-js';
const as = async (e) => { const c = createClient('http://localhost:8787', 'anon', { auth: { persistSession: false } }); const r = await c.auth.signInWithPassword({ email: e + '@hc.test', password: 'Pass1234!' }); if (r.error) throw r.error; return c; };
const anon = createClient('http://localhost:8787', 'anon', { auth: { persistSession: false } });
const ok = (r, label) => { if (r.error) { console.log('✗', label, r.error.message); process.exitCode = 1; return null; } return r.data; };
const expectErr = (r, label) => console.log(r.error ? '✓ refused' : '✗ NOT refused', label, r.error?.message?.slice(0, 90) || '');
const eq = (a, b, label) => console.log(Math.abs(Number(a) - Number(b)) < 0.005 || String(a) === String(b) ? '✓' : `✗ (${a} ≠ ${b})`, `${label}`);

const [counter, cashier, wh, mgr, fin] = await Promise.all(['counter','cashier','warehouse','admin','finance'].map(as));

console.log('— 1 · TZS billing (USD rates, customer pays TZS) —');
const s1 = ok(await mgr.rpc('create_shipment', { p: {
  mode: 'air', origin_branch: 'DXB', destination_branch: 'DAR',
  sender: { name: 'Zawadi Traders', phone: '0754 111 222' }, receiver: { name: 'Baraka Mushi', phone: '0713 444 555' },
  items: [{ description: 'Spare parts', category_id: 1, qty: 4, unit: 'CTN' }],
  category_id: 1, weight_kg: 10, rate: 5, rate_note: 'agreed' } }), 'create air shipment');
console.log('  ', s1?.ref, '| currency', s1?.currency, '| fx', s1?.fx_rate, '| USD', s1?.total, '| TZS', s1?.total_txn);
eq(s1.currency, 'TZS', 'default billing currency is TZS');
eq(s1.total, 50, 'freight USD 50 (10 kg × USD 5)');
eq(s1.total_txn, 130000, 'freight TZS 130,000 (1 USD = 2,600 TZS)');

console.log('— 2 · charges: USD converted once, TZS never re-converted —');
ok(await counter.rpc('add_charge', { p_shipment: s1.id, p_charge_type: 'packing', p_description: 'Wrap', p_qty: 1, p_unit_price: 10, p_currency: 'USD' }), 'USD charge');
const ch2 = ok(await counter.rpc('add_charge', { p_shipment: s1.id, p_charge_type: 'delivery', p_description: 'Boda', p_qty: 1, p_unit_price: 20000, p_currency: 'TZS' }), 'TZS charge');
console.log('  TZS charge stored:', ch2?.amount_txn, 'TZS =', ch2?.amount_usd, 'USD');
eq(ch2.amount_txn, 20000, 'TZS charge stays 20,000');
eq(ch2.amount_usd, 7.69, 'TZS charge is 7.69 USD in the ledger');
let v = ok(await counter.from('v_shipments').select('*').eq('id', s1.id).single(), 'view');
eq(v.invoice_total_txn, 130000 + 26000 + 20000, 'invoice total TZS 176,000');
eq(v.invoice_total, 50 + 10 + 7.69, 'invoice total USD 67.69');

console.log('— 3 · partial payment & balance —');
const pay = ok(await cashier.rpc('record_payment', { p_shipment: s1.id, p_amount: 100000, p_currency: 'TZS', p_method: 'mobile_money' }), 'pay TZS 100,000');
console.log('  paid', pay?.amount, pay?.currency, '@', pay?.fx_rate, '→ balance TZS', pay?.balance_txn);
eq(pay.fx_rate, 2600, 'payment uses the invoice rate (no second conversion)');
eq(pay.balance_txn, 76000, 'balance TZS 76,000');
expectErr(await cashier.rpc('record_payment', { p_shipment: s1.id, p_amount: 100000, p_currency: 'TZS', p_method: 'mobile_money' }), 'duplicate payment');
v = ok(await counter.from('v_shipments').select('*').eq('id', s1.id).single(), 'view2');
eq(v.payment_status, 'part_paid', 'part paid');

console.log('— 4 · changing the default rate does not touch issued invoices —');
ok(await mgr.from('settings').update({ fx_tzs: 2750 }).eq('id', 1), 'change default fx to 2750');
v = ok(await counter.from('v_shipments').select('*').eq('id', s1.id).single(), 'view3');
eq(v.invoice_fx, 2600, 'issued invoice keeps 2,600');
eq(v.invoice_total_txn, 176000, 'issued invoice total unchanged');
const s2 = ok(await mgr.rpc('create_shipment', { p: { mode: 'air', origin_branch: 'DXB', destination_branch: 'DAR',
  sender: { name: 'Zawadi Traders', phone: '0754111222' }, receiver: { name: 'B', phone: '0713444555' },
  items: [{ description: 'Parts', category_id: 1, qty: 1 }], category_id: 1, weight_kg: 10, rate: 5 } }), 'new shipment after fx change');
eq(s2.fx_rate, 2750, 'new shipment uses the new rate');
eq(s2.total_txn, 137500, 'new shipment TZS 137,500');
ok(await mgr.from('settings').update({ fx_tzs: 2600 }).eq('id', 1), 'restore fx');

console.log('— 5 · GRN without dimensions —');
const g1 = ok(await wh.rpc('record_grn', { p_shipment: s1.id, p_lines: [
  { pieces: 4, weight_kg: 10 }] }), 'GRN with no dimensions');
console.log('  ', g1?.grn_ref, 'pieces', g1?.pieces, 'cbm', g1?.cbm, 'kg', g1?.kg);
const gl = ok(await wh.from('grn_lines').select('*').eq('grn_id', g1.grn_id), 'grn lines');
eq(gl[0].length_cm, null, 'length stays empty (not fabricated)');
eq(gl[0].cbm, 0, 'no CBM invented');
v = ok(await counter.from('v_shipments').select('*').eq('id', s1.id).single(), 'view4');
eq(v.weight_kg, 10, 'declared weight kept');

console.log('— 6 · GRN with a manually typed CBM —');
const s3 = ok(await counter.rpc('create_shipment', { p: { mode: 'sea', origin_branch: 'DXB', destination_branch: 'MWZ',
  sender: { name: 'Manual CBM Co', phone: '0755777888' }, receiver: { name: 'R', phone: '0755777999' },
  items: [{ description: 'Furniture', category_id: 3, qty: 3 }], category_id: 3, cbm: 2 } }), 'sea shipment');
const g2 = ok(await wh.rpc('record_grn', { p_shipment: s3.id, p_lines: [
  { pieces: 3, cbm: 1.85, weight_kg: 210 },
  { pieces: 2, length_cm: 100, width_cm: 50, height_cm: 40, weight_kg: 60 }] }), 'GRN manual + calculated');
const gl2 = ok(await wh.from('grn_lines').select('*').eq('grn_id', g2.grn_id).order('id'), 'grn lines 2');
eq(gl2[0].cbm, 1.85, 'manual CBM kept exactly');
eq(gl2[0].cbm_source, 'manual', 'marked as manual');
eq(gl2[1].cbm, 0.4, 'calculated CBM from dimensions (2 × 100×50×40)');
eq(gl2[1].cbm_source, 'dimensions', 'marked as calculated');
eq(g2.cbm, 2.25, 'GRN total CBM 2.25');

console.log('— 7 · document QR, verification & approval —');
const inv = ok(await counter.from('invoices').select('id,ref').eq('shipment_id', s1.id).single(), 'invoice');
const doc = ok(await counter.rpc('doc_register', { p_type: 'invoice', p_doc_id: inv.id }), 'register invoice document');
console.log('  token', doc?.token?.slice(0, 10) + '…', '| status', doc?.status, '| version', doc?.version);
eq(doc.status, 'pending', 'starts as pending approval');
const pub = ok(await anon.rpc('verify_document', { p_token: doc.token }), 'anon verification');
console.log('  public sees:', JSON.stringify({ t: pub.document_type, no: pub.document_no, ship: pub.shipment_ref, st: pub.status }));
eq(pub.found, true, 'verification page finds the document');
eq(pub.document_no, inv.ref, 'shows the document number');
console.log(pub.total === undefined && pub.customer === undefined ? '✓' : '✗', 'no money or customer details exposed');
expectErr(await counter.rpc('approve_document', { p_token: doc.token, p_approve: true }), 'counter approves');
expectErr(await anon.rpc('approve_document', { p_token: doc.token, p_approve: true }), 'anonymous approves');
ok(await fin.rpc('approve_document', { p_token: doc.token, p_approve: true, p_note: 'checked' }), 'finance manager approves');
const pub2 = ok(await anon.rpc('verify_document', { p_token: doc.token }), 'verify after approval');
eq(pub2.status, 'approved', 'shows approved');
console.log('  approved by:', pub2.approved_by, '| at', String(pub2.approved_at).slice(0, 16));
const shipBefore = ok(await counter.from('v_shipments').select('status,payment_status').eq('id', s1.id).single(), 'ship');
console.log('  approval did not touch shipment/payment status:', shipBefore.status, '/', shipBefore.payment_status);

console.log('— 8 · a material edit invalidates the approval —');
ok(await counter.rpc('add_charge', { p_shipment: s1.id, p_charge_type: 'storage', p_description: '3 days', p_qty: 1, p_unit_price: 5000, p_currency: 'TZS' }), 'add charge after approval');
const pub3 = ok(await anon.rpc('verify_document', { p_token: doc.token }), 'verify after edit');
eq(pub3.status, 'pending', 'approval invalidated → pending again');
eq(pub3.version, 2, 'version bumped to 2');
const hist = ok(await fin.from('v_document_approvals').select('*').order('acted_at'), 'approval history');
console.log('  history:', hist.map((h) => `${h.action} v${h.version}`).join(' → '));
console.log('— 9 · unknown / invalid token —');
const bad = ok(await anon.rpc('verify_document', { p_token: 'deadbeef' }), 'unknown token');
eq(bad.found, false, 'unknown token reports not found');

console.log('— 10 · accounting still balances —');
const today = new Date().toISOString().slice(0, 10);
for (const co of ['AE', 'TZ', null]) {
  const tb = ok(await fin.rpc('acc_trial_balance', { p_company: co, p_from: '2000-01-01', p_to: today }), 'TB');
  const dr = tb.reduce((a, r) => a + Number(r.debit), 0), cr = tb.reduce((a, r) => a + Number(r.credit), 0);
  console.log(`  TB ${co || 'ALL'}: Dr ${dr.toFixed(2)} Cr ${cr.toFixed(2)}`, Math.abs(dr - cr) < 0.01 ? '✓' : '✗ UNBALANCED');
}
