// v4 in the browser: storage, partial packing, staff administration, special access
import { chromium } from 'playwright';
const BASE = 'http://localhost:8787';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
const DESK = { width: 1366, height: 900 }, MOB = { width: 390, height: 844 };
const SH = 'shots-v4/';
const step = (s) => console.log('\n▶', s);
const say = (ok, msg) => { if (!ok) process.exitCode = 1; console.log((ok ? '  ✓ ' : '  ✗ ') + msg); };
const shot = (p, n) => p.screenshot({ path: SH + n + '.png', fullPage: true });
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function as(email, viewport = DESK, lang = 'en') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport === MOB ? 2 : 1 });
  await ctx.addInitScript((l) => { try { localStorage.setItem('hc.lang', l); } catch {} }, lang);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(email + ' pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(email + ' console: ' + m.text()); });
  await p.goto(BASE + '/');
  await p.fill('input[name=email]', email); await p.fill('input[name=password]', 'Pass1234!');
  await p.click('button[type=submit]');
  await p.waitForSelector('#page .page-head, #page .card', { timeout: 10000 });
  await p.waitForTimeout(400);
  return p;
}
const clearModals = (p) => p.evaluate(() => { const r = document.getElementById('modal-root'); if (r) r.innerHTML = ''; });
const go = async (p, hash) => {
  await clearModals(p);
  await p.goto(BASE + '/#/profile'); await p.waitForTimeout(250); await p.goto(BASE + '/' + hash);
  await p.waitForSelector('#page .page-head, #page .card, #page .doc', { timeout: 10000 }); await p.waitForTimeout(700);
};
const toastText = async (p) => { await p.waitForSelector('.toast', { timeout: 6000 }); return p.locator('.toast').last().innerText(); };
const api = (p, fn, args) => p.evaluate(async ([f, a]) => {
  const { rpc } = await import('./js/api.js');
  try { return { ok: true, data: await rpc(f, a) }; } catch (e) { return { ok: false, error: e.message }; }
}, [fn, args]);

// ── a shipment with two kinds of cargo, received into the warehouse ──
step('setting the scene: a shipment of 73 cartons and 10 bags, received');
const admin = await as('admin@hc.test');
const made = await api(admin, 'create_shipment', { p: {
  mode: 'sea', origin_branch: 'DXB', destination_branch: 'DAR',
  sender: { name: 'Mwajuma Hardware', phone: '0754 800 100' },
  receiver: { name: 'Kilimanjaro Builders', phone: '0713 800 200' },
  items: [{ description: 'Floor tiles', category_id: 1, qty: 73, unit: 'CTN' },
          { description: 'Cement mix', category_id: 1, qty: 10, unit: 'BAG' }],
  category_id: 1, cbm: 4, rate: 200 } });
const sid = made.data?.id;
say(!!sid, `shipment ${made.data?.ref || made.error}`);
const items = await admin.evaluate(async (id) => {
  const { from, run } = await import('./js/api.js');
  return run(from('shipment_items').select('id,description').eq('shipment_id', id).order('id'));
}, sid);
const tiles = items.find((i) => i.description === 'Floor tiles').id;

step('the warehouse records the GRN — the goods appear in Storage by themselves');
const wh = await as('warehouse@hc.test');
await go(wh, `#/shipment/${sid}/grn`);
const rowCount = await wh.locator('#lines tbody tr').count();
await wh.fill('#lines tbody tr:first-child [data-k=pieces]', '73');
await wh.fill('#lines tbody tr:first-child [data-k=weight_kg]', '900');
if (rowCount > 1) { await wh.fill('#lines tbody tr:nth-child(2) [data-k=pieces]', '10'); await wh.fill('#lines tbody tr:nth-child(2) [data-k=weight_kg]', '500'); }
await wh.click('#save');
await wh.waitForTimeout(500);
const okBtn = wh.locator('.modal .btn.primary, .modal .btn.danger').first();
if (await okBtn.count()) await okBtn.click();
await wh.waitForTimeout(1200);

await go(wh, '#/storage');
await shot(wh, '01-storage-list');
const listText = await wh.locator('#page').innerText();
say(/Mwajuma|Kilimanjaro/.test(listText), 'the shipment is listed in Storage');
say(/Unpacked/i.test(listText), 'it shows as unpacked');

step('the warehouse packs 38 of the 73 cartons');
await wh.locator('[data-pack]').first().click();
await wh.waitForSelector('.pack-t', { timeout: 5000 });
await shot(wh, '02-packing-sheet');
await wh.locator('.pack-t tbody tr').first().locator('.qty').fill('38');
await wh.fill('#pk-notes', 'First lorry, driver Juma');
await wh.click('#pk-save');
const pkToast = await toastText(wh).catch((e) => 'NO TOAST: ' + e.message);
say(/recorded|HC-PK/i.test(pkToast), 'the packing entry is saved — ' + pkToast.replace(/\n/g, ' '));
await wh.waitForTimeout(1200);
await go(wh, '#/storage');
const after1 = await wh.locator('#page').innerText();
say(/Partially packed/i.test(after1), 'the shipment now reads "Partially packed"');
say(/35/.test(after1), '35 cartons are shown as still unpacked');
await shot(wh, '03-partially-packed');

step('a second entry finishes the cartons — both entries are kept');
await go(wh, `#/storage/${sid}`);
await shot(wh, '04-storage-detail');
await wh.click('#pack');
await wh.waitForSelector('.pack-t');
await wh.locator('.pack-t tbody tr').first().locator('.all-btn').click();
await wh.click('#pk-save');
await wh.waitForTimeout(1300);
await go(wh, `#/storage/${sid}`);
const detail = await wh.locator('#page').innerText();
const entryCount = await wh.locator('table.t tbody tr').count();
say(/HC-PK-/.test(detail) && (detail.match(/HC-PK-/g) || []).length >= 2, 'two separate packing entries are on the record');
say(/Fully packed/i.test(detail) && /Partially packed/i.test(detail), 'the tiles are fully packed while the shipment as a whole is not');
await shot(wh, '05-two-entries');

step('the warehouse cannot pack more than is there');
const over = await api(wh, 'record_packing', { p: { shipment_id: sid, lines: [{ item_id: tiles, qty: 1 }] } });
say(!over.ok, 'over-packing is refused: ' + (over.error || '').slice(0, 60));

step('packing is not dispatch');
await go(wh, `#/shipment/${sid}`);
const shipText = await wh.locator('#page').innerText();
say(/Storage/.test(shipText) && /Received in Dubai|Received/i.test(shipText), 'the shipment page shows storage and transport side by side');
await shot(wh, '06-shipment-storage-card');

step('the Packing List page exists and is blank on purpose');
await go(wh, '#/packing-list');
const pl = await wh.locator('#page').innerText();
say(/Packing List/i.test(pl), 'the page is there');
say(/Coming soon/i.test(pl), 'and says plainly that it is not built yet');
await shot(wh, '07-packing-list');

step('the administrator: staff, retired roles and invitations');
await go(admin, '#/users');
await shot(admin, '08-staff');
const staffText = await admin.locator('#page').innerText();
say(/Finance manager/i.test(staffText) && /retired/i.test(staffText), 'the existing Finance Manager is still listed, marked as retired');
await admin.locator('tr[data-id]').first().click();
await admin.waitForSelector('.modal select[name=role]');
const roleOpts = await admin.locator('.modal select[name=role] option').allInnerTexts();
say(!roleOpts.some((o) => /^Viewer$/.test(o.trim())), 'Viewer is not offered as a role: ' + roleOpts.join(', '));
await admin.locator('.modal [data-close]').first().click();
await admin.click('#invite');
await admin.waitForSelector('.modal input[name=email]');
await admin.fill('.modal input[name=email]', 'newstaff@hc.test');
await admin.fill('.modal input[name=full_name]', 'Amina Mfanyakazi');
await admin.selectOption('.modal select[name=role]', 'counter');
await shot(admin, '09-invite');
await admin.click('#iv');
say(/saved|Invitation/i.test(await toastText(admin).catch(() => '')), 'the invitation is created');
await admin.waitForTimeout(900);

step('lending the Cashier’s payment permission to a logistics officer');
await go(admin, '#/users');
await admin.locator('[data-tab=access]').click();
await admin.waitForTimeout(400);
await admin.click('#grant');
await admin.waitForSelector('.modal select[name=user_id]');
const opsId = await admin.evaluate(async () => {
  const { from, run } = await import('./js/api.js');
  const r = await run(from('profiles').select('id').eq('email', 'ops@hc.test').single());
  return r.id;
});
await admin.selectOption('.modal select[name=user_id]', opsId);
await admin.selectOption('.modal select[name=permission]', 'payment.record');
await admin.selectOption('.modal select[name=hours]', '24');
await admin.fill('.modal input[name=reason]', 'Cashier on leave until Friday');
await shot(admin, '10-grant');
await admin.click('#gs');
say(/granted/i.test(await toastText(admin).catch(() => '')), 'the permission is lent for a day');
await admin.waitForTimeout(900);
await go(admin, '#/users?tab=access');
await admin.locator('[data-tab=access]').click();
await admin.waitForTimeout(400);
await shot(admin, '11-access-list');
const accText = await admin.locator('#page').innerText();
say(/Cashier on leave/i.test(accText) && /Record customer payments/i.test(accText), 'the reason and the permission are both on the list');

step('the logistics officer can now take a payment — and only that');
const ops = await as('ops@hc.test');
await go(ops, `#/shipment/${sid}`);
const opsText = await ops.locator('#page').innerText();
say(/Record payment|Payment/i.test(opsText), 'the payment action is now visible to them');
const paid = await api(ops, 'record_payment', { p_shipment: sid, p_amount: 50000, p_currency: 'TZS', p_method: 'cash' });
say(paid.ok, 'the payment goes through: ' + (paid.data?.ref || paid.data?.receipt_no || JSON.stringify(paid.data)?.slice(0, 70) || paid.error));
const notAllowed = await api(ops, 'grant_permission', { p_user: opsId, p_permission: 'acc.write' });
say(!notAllowed.ok, 'they still cannot hand out permissions themselves');
await shot(ops, '12-ops-payment');

step('the administrator ends the access — it stops at once');
await go(admin, '#/users?tab=access');
await admin.locator('[data-tab=access]').click();
await admin.waitForTimeout(400);
await admin.locator('[data-revoke]').first().click();
await admin.waitForSelector('#cf-reason');
await admin.fill('#cf-reason', 'Cashier is back');
await admin.click('#cf-ok');
say(/ended|revoked/i.test(await toastText(admin).catch(() => '')), 'the access is ended');
await admin.waitForTimeout(900);
const ops2 = await as('ops@hc.test');
const blocked = await api(ops2, 'record_payment', { p_shipment: sid, p_amount: 1000, p_currency: 'TZS', p_method: 'cash' });
say(!blocked.ok, 'their next payment attempt is refused: ' + (blocked.error || '').slice(0, 50));

step('the Accountant takes payments as the Cashier would');
const acct = await as('accountant@hc.test');
await go(acct, `#/shipment/${sid}`);
const acctPaid = await api(acct, 'record_payment', { p_shipment: sid, p_amount: 25000, p_currency: 'TZS', p_method: 'mobile_money' });
say(acctPaid.ok, 'the accountant records a payment: ' + (acctPaid.data?.ref || acctPaid.data?.receipt_no || JSON.stringify(acctPaid.data)?.slice(0, 70) || acctPaid.error));
await go(acct, `#/shipment/${sid}`);
say(/Receipt|HC-RCT/i.test(await acct.locator('#page').innerText()), 'the receipt shows on the shipment');
await shot(acct, '13-accountant-payment');

step('on a phone');
const mob = await as('warehouse@hc.test', MOB, 'sw');
for (const [name, hash] of [['storage', '#/storage'], ['detail', `#/storage/${sid}`], ['packing-list', '#/packing-list']]) {
  await go(mob, hash);
  const o = await overflow(mob);
  say(o <= 1, `${name}: no sideways scrolling (overflow ${o}px)`);
  await shot(mob, `14-m-${name}`);
}
await go(mob, '#/storage');
const packBtn = mob.locator('[data-pack]').first();
if (await packBtn.count()) {
  await packBtn.click();
  await mob.waitForSelector('.pack-t', { timeout: 5000 });
  say((await overflow(mob)) <= 1, 'the packing sheet fits the phone screen');
  await shot(mob, '15-m-packing-sheet');
}

const mobAdmin = await as('admin@hc.test', MOB);
await go(mobAdmin, '#/users');
say((await overflow(mobAdmin)) <= 1, 'the staff page fits the phone screen');
await shot(mobAdmin, '16-m-staff');

console.log('\nERRORS:', errors.length ? errors : 'none');
if (errors.length) process.exitCode = 1;
await browser.close();
