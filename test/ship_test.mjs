import { createClient } from '@supabase/supabase-js';
const as = async (e) => { const c = createClient('http://localhost:8787', 'anon', { auth: { persistSession: false } }); const r = await c.auth.signInWithPassword({ email: e + '@hc.test', password: 'Pass1234!' }); if (r.error) throw r.error; return c; };
const ok = (r, label) => { if (r.error) { console.log('✗', label, r.error.message); process.exitCode = 1; return null; } return r.data; };
const expectErr = (r, label) => console.log(r.error ? '✓ refused' : '✗ NOT refused', label, r.error?.message?.slice(0, 80) || '');
const eq = (a, b, label) => (!isNaN(Number(a)) && !isNaN(Number(b)) ? (Math.abs(Number(a)-Number(b))<0.005 ? console.log('✓', label) : console.log(`✗ (${a} ≠ ${b})`, label)) :  console.log(String(a) === String(b) ? '✓' : `✗ (${a} ≠ ${b})`, label));

const [counter, cashier, wh, ops, rel, acct, fin, admin, mgr] =
  await Promise.all(['counter','cashier','warehouse','ops','release','accountant','finance','admin','admin'].map(as));

// 1 · new customer + sea shipment
const s1 = ok(await counter.rpc('create_shipment', { p: {
  mode: 'sea', origin_branch: 'DXB', destination_branch: 'DAR',
  sender:   { name: 'Mariam Juma Traders', phone: '0754 123 456', email: 'mariam@example.com', address: 'Kariakoo' },
  receiver: { name: 'Hamisi Said', phone: '0713 999 888', address: 'Buguruni' },
  items: [{ description: 'Mobile phones', category_id: 2, qty: 10, unit: 'PCS' },
          { description: 'Chargers', category_id: 2, qty: 40, unit: 'PCS' }],
  category_id: 2, cbm: 1.95, currency: 'TZS' } }), 'create sea shipment');
console.log('  ref:', s1?.ref, '| freight', s1?.freight, '| qty', s1?.qty, '| rate', s1?.rate);
console.log(/^HC-\d{8}_\d{3}$/.test(s1.ref || '') ? '✓ number format' : '✗ number format ' + s1.ref);

// customer auto-registered + phone normalised
const cust = ok(await counter.from('customers').select('*').eq('name', 'Mariam Juma Traders').single(), 'sender saved');
eq(cust.phone, '+255754123456', 'phone normalised');
const recv = ok(await counter.from('customers').select('*').eq('name', 'Hamisi Said').single(), 'receiver saved');

// 2 · same customer again (no duplicate), air mode
const s2 = ok(await counter.rpc('create_shipment', { p: {
  mode: 'air', origin_branch: 'DXB', destination_branch: 'MWZ',
  sender:   { name: 'Mariam Juma Traders', phone: '+255754123456' },
  receiver: { name: 'Asha Omary', phone: '0767111222' },
  items: [{ description: 'Perfumes', category_id: 1, qty: 6, unit: 'CTN' }],
  category_id: 1, weight_kg: 25, currency: 'USD' } }), 'create air shipment');
console.log('  ref:', s2?.ref, '| freight', s2?.freight, '(25kg × rate)', '| rate', s2?.rate);
eq((await counter.from('customers').select('id').eq('phone', '+255754123456')).data.length, 1, 'no duplicate customer');
eq(s1.ref.slice(-3), '001', 'first of the day = 001');
eq(s2.ref.slice(-3), '002', 'second of the day = 002');

// 3 · simultaneous creation → unique numbers
const many = await Promise.all([1,2,3,4].map(() => counter.rpc('create_shipment', { p: {
  mode: 'sea', origin_branch: 'DXB', destination_branch: 'DAR',
  sender: { name: 'Race Test', phone: '0755000111' }, receiver: { name: 'R2', phone: '0755000222' },
  items: [{ description: 'Boxes', category_id: 3, qty: 1 }], category_id: 3, cbm: 0.5 } })));
const refs = many.map((r) => r.data?.ref);
eq(new Set(refs).size, 4, 'simultaneous creates → unique refs (' + refs.join(' ') + ')');

// 4 · charges
ok(await counter.rpc('add_charge', { p_shipment: s1.id, p_charge_type: 'packing',  p_description: 'Wrapping', p_qty: 1, p_unit_price: 10, p_currency: 'USD' }), 'charge packing');
ok(await counter.rpc('add_charge', { p_shipment: s1.id, p_charge_type: 'handling', p_description: 'Loading',  p_qty: 1, p_unit_price: 5, p_currency: 'USD' }), 'charge handling');
const ch = ok(await counter.rpc('add_charge', { p_shipment: s1.id, p_charge_type: 'duty', p_description: 'Import duty', p_qty: 1, p_unit_price: 310, p_currency: 'USD' }), 'charge duty');
expectErr(await counter.rpc('add_charge', { p_shipment: s1.id, p_charge_type: 'discount', p_description: 'x', p_qty: 1, p_unit_price: 10, p_currency: 'USD' }), 'counter gives discount');
ok(await mgr.rpc('add_charge', { p_shipment: s1.id, p_charge_type: 'discount', p_description: 'Loyalty', p_qty: 1, p_unit_price: 10, p_currency: 'USD' }), 'manager discount');
let v1 = ok(await counter.from('v_shipments').select('*').eq('id', s1.id).single(), 'v_shipments');
eq(v1.invoice_total, (s1.freight + 10 + 5 + 310 - 10).toFixed(2), 'grand total after charges');
eq(v1.payment_status, 'unpaid', 'payment status unpaid');

// 5 · edit: change CBM → freight recalculated
ok(await mgr.rpc('update_shipment', { p: { id: s1.id, cbm: 3.0, edit_reason: 're-measured' } }), 'edit cbm');
v1 = ok(await counter.from('v_shipments').select('*').eq('id', s1.id).single(), 'v_shipments 2');
console.log('  new freight', v1.quoted_amount, '| total', v1.invoice_total);
eq(v1.cbm, 3, 'cbm updated');
eq(v1.ref, s1.ref, 'shipment number unchanged after edit');

// 6 · status flow + history
for (const st of ['packed', 'dispatched', 'in_transit', 'in_customs', 'arrived']) {
  ok(await ops.rpc('set_shipment_status', { p_shipment: s1.id, p_status: st, p_note: null }), 'status → ' + st);
}
expectErr(await ops.rpc('set_shipment_status', { p_shipment: s1.id, p_status: 'arrived' }), 'same status twice');
const ev = ok(await ops.from('v_events').select('*').eq('shipment_id', s1.id).order('created_at'), 'events');
console.log('  history:', ev.map((e) => e.status).filter(Boolean).join(' → '));
eq(ev.filter((e) => e.prev_status).length, 5, 'previous status recorded');

// 7 · GRN
const grn = ok(await wh.rpc('record_grn', { p_shipment: s1.id, p_lines: [
  { pieces: 10, length_cm: 50, width_cm: 40, height_cm: 45, weight_kg: 120 },
  { pieces: 40, length_cm: 30, width_cm: 20, height_cm: 15, weight_kg: 60 }] }), 'GRN');
console.log('  grn', grn?.grn_ref, 'cbm', grn?.cbm, 'kg', grn?.kg);
expectErr(await wh.rpc('record_grn', { p_shipment: s1.id, p_lines: [{ pieces: 1, length_cm: 1, width_cm: 1, height_cm: 1, weight_kg: 1 }] }), 'second GRN');

// 8 · partial payment
const money = ok(await acct.from('money_accounts').select('*'), 'money accounts');
const M = (n) => money.find((m) => m.name === n)?.id;
ok(await cashier.rpc('record_payment', { p_shipment: s1.id, p_amount: 200, p_currency: 'USD', p_method: 'cash', p_account: M('Cash — Dubai (USD)') }), 'payment 200');
v1 = ok(await counter.from('v_shipments').select('*').eq('id', s1.id).single(), 'v_shipments 3');
eq(v1.paid_usd, 200, 'paid 200');
eq(v1.payment_status, 'part_paid', 'part paid');
eq(v1.balance_usd, (v1.invoice_total - 200).toFixed(2), 'balance correct');

// 9 · delivery with balance outstanding (no settlement gate any more)
const d = ok(await rel.rpc('deliver_shipment', { p_shipment: s1.id, p_name: 'Hamisi Said', p_phone: '0713999888' }), 'deliver with balance');
console.log('  delivery', d?.ref, 'balance at handover', d?.balance_usd);
eq((await counter.from('shipments').select('status').eq('id', s1.id).single()).data.status, 'delivered', 'status delivered');
expectErr(await rel.rpc('deliver_shipment', { p_shipment: s1.id, p_name: 'x', p_phone: '1' }), 'deliver twice');

// 10 · cancel
const s3 = many[0].data;
ok(await mgr.rpc('cancel_shipment', { p_shipment: s3.id, p_reason: 'customer withdrew' }), 'cancel');
eq((await counter.from('invoices').select('status').eq('shipment_id', s3.id).single()).data.status, 'void', 'invoice voided on cancel');

// 11 · refusals
await counter.from('shipments').update({ ref: 'HC-HACK', status: 'received_dubai' }).eq('id', s1.id);
eq((await counter.from('shipments').select('ref,status').eq('id', s1.id).single()).data.ref, s1.ref, 'direct table write cannot change the number');
expectErr(await counter.rpc('create_shipment', { p: { mode: 'sea', origin_branch: 'DXB', destination_branch: 'DAR',
  sender: { name: 'A', phone: '0755000111' }, receiver: { name: 'B', phone: '0755000222' }, items: [], category_id: 3, cbm: 1 } }), 'no items');
expectErr(await counter.rpc('create_shipment', { p: { mode: 'air', origin_branch: 'DXB', destination_branch: 'DAR',
  sender: { name: 'A', phone: '0755000111' }, receiver: { name: 'B', phone: '0755000222' },
  items: [{ description: 'x', category_id: 1, qty: 1 }], category_id: 1 } }), 'air without weight');
expectErr(await counter.rpc('create_shipment', { p: { mode: 'sea', origin_branch: 'DXB', destination_branch: 'DAR',
  sender: { name: 'A', phone: '0755000111' }, receiver: { name: 'B', phone: '0755000222' },
  items: [{ description: 'x', category_id: 3, qty: 1 }], category_id: 3, cbm: 1, rate: 999 } }), 'counter overrides rate');
const ovr = ok(await mgr.rpc('create_shipment', { p: { mode: 'sea', origin_branch: 'DXB', destination_branch: 'DAR',
  sender: { name: 'A', phone: '0755000111' }, receiver: { name: 'B', phone: '0755000222' },
  items: [{ description: 'x', category_id: 3, qty: 1 }], category_id: 3, cbm: 2, rate: 300, rate_note: 'agreed with client' } }), 'manager rate override');
eq(ovr?.freight, 600, 'override price 2 × 300');

// 12 · public tracking
const pub = createClient('http://localhost:8787', 'anon', { auth: { persistSession: false } });
const tr = ok(await pub.rpc('track_shipment', { p_ref: s1.ref }), 'public track');
console.log('  track:', tr?.status_label, '| receiver', tr?.receiver, '| events', tr?.events?.length);

// 13 · accounting still balances
const today = new Date().toISOString().slice(0, 10);
for (const co of ['AE', 'TZ', null]) {
  const tb = ok(await fin.rpc('acc_trial_balance', { p_company: co, p_from: '2000-01-01', p_to: today }), 'TB ' + co);
  const dr = tb.reduce((a, r) => a + Number(r.debit), 0), cr = tb.reduce((a, r) => a + Number(r.credit), 0);
  const ar = tb.find((r) => r.system_key === 'AR');
  console.log(`  TB ${co || 'ALL'}: Dr ${dr.toFixed(2)} Cr ${cr.toFixed(2)}`, Math.abs(dr - cr) < 0.01 ? '✓ balanced' : '✗ UNBALANCED',
    '| AR', ar ? (Number(ar.debit) - Number(ar.credit)).toFixed(2) : 0);
}
const pnl = ok(await fin.rpc('acc_shipment_pnl', { p_shipment: s1.id }), 'shipment P&L');
console.log('  P&L', s1.ref, 'revenue', pnl?.revenue, 'cost', pnl?.cost, 'profit', pnl?.profit);
const list = ok(await fin.rpc('acc_shipments_pnl', { p_from: '2000-01-01', p_to: today }), 'shipments P&L list');
console.log('  shipments in P&L list:', list?.length);
const dash = ok(await counter.rpc('dashboard_stats', {}), 'dashboard');
console.log('  dashboard by_status:', JSON.stringify(dash?.by_status), '| today', dash?.shipments_today);
