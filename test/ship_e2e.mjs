import { chromium } from 'playwright';
const BASE = 'http://localhost:8787';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
const DESK = { width: 1366, height: 900 }, MOB = { width: 400, height: 860 };
const SH = 'shots-v2/';
async function as(email, viewport = DESK, lang = 'en') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport === MOB ? 2 : 1 });
  await ctx.addInitScript((l) => { try { localStorage.setItem('hc.lang', l); } catch {} }, lang);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(email + ' pageerror: ' + e.message));
  p.on('response', async (r) => { if ((r.url().includes('/rest/') || r.url().includes('/auth/')) && r.status() >= 400) console.log('   HTTP', r.status(), r.url().slice(22, 110), (await r.text()).slice(0, 180)); });
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(email + ' console: ' + m.text()); });
  await p.goto(BASE + '/');
  await p.fill('input[name=email]', email); await p.fill('input[name=password]', 'Pass1234!');
  await p.click('button[type=submit]');
  await p.waitForSelector('#page .page-head, #page .card', { timeout: 10000 });
  await p.waitForTimeout(400);
  return p;
}
const go = async (p, hash) => { await p.goto(BASE + '/#/profile'); await p.waitForTimeout(250); await p.goto(BASE + '/' + hash);
  await p.waitForSelector('#page .page-head, #page .card, #page .doc, #page .labels', { timeout: 10000 }); await p.waitForTimeout(600); };
const toastText = async (p) => { await p.waitForSelector('.toast', { timeout: 6000 }); return p.locator('.toast').last().innerText(); };
const step = (s) => console.log('▶', s);
const shot = (p, n) => p.screenshot({ path: SH + n + '.png', fullPage: true });

step('counter creates a shipment through the wizard');
const counter = await as('counter@hc.test');
await go(counter, '#/shipments/new');
// step 1 · sender & receiver
await counter.fill('[data-f="sender.name"]', 'Neema Mushi');
await counter.fill('[data-f="sender.phone"]', '0754 908 111');
await counter.fill('[data-f="sender.address"]', 'Deira, Dubai');
await counter.fill('[data-f="receiver.name"]', 'Juma Bakari');
await counter.fill('[data-f="receiver.phone"]', '0713 222 333');
await counter.fill('[data-f="receiver.address"]', 'Mwanza mjini');
await shot(counter, '01-wizard-parties');
await counter.click('#next');
// step 2 · method
await counter.waitForSelector('[data-mode]');
await counter.click('[data-mode="sea"]');
await counter.click('[data-dest="MWZ"]');
await shot(counter, '02-wizard-method');
await counter.click('#next');
// step 3 · items
await counter.waitForSelector('[data-it="0.description"]');
await counter.fill('[data-it="0.description"]', 'Mobile phones');
await counter.fill('[data-it="0.qty"]', '10');
await counter.click('#add-item');
await counter.fill('[data-it="1.description"]', 'Shoes');
await counter.fill('[data-it="1.qty"]', '24');
await counter.selectOption('[data-it="1.unit"]', 'CTN');
await shot(counter, '03-wizard-items');
await counter.click('#next');
// step 4 · measure
await counter.waitForSelector('[data-f="cbm"]');
await counter.fill('[data-f="cbm"]', '2.4');
await counter.fill('[data-f="weight_kg"]', '310');
await counter.waitForTimeout(200);
console.log('  chargeable:', (await counter.locator('#sum').innerText()).replace(/\s+/g, ' ').slice(0, 80));
await counter.click('#next');
// step 5 · price
await counter.waitForSelector('.calc');
console.log('  price step:', (await counter.locator('.calc').innerText()).replace(/\s+/g, ' '));
await shot(counter, '04-wizard-price');
await counter.click('#next');
// step 6 · charges
await counter.waitForSelector('#add-ch');
await counter.click('#add-ch');
await counter.selectOption('[data-ch="0.charge_type"]', 'packing');
await counter.fill('[data-ch="0.amount"]', '15');
await counter.selectOption('[data-ch="0.currency"]', 'USD');
await counter.click('#add-ch');
await counter.selectOption('[data-ch="1.charge_type"]', 'delivery');
await counter.fill('[data-ch="1.description"]', 'Door delivery Mwanza');
await counter.fill('[data-ch="1.amount"]', '40');
await counter.selectOption('[data-ch="1.currency"]', 'USD');
await counter.waitForTimeout(150);
console.log('  charges total:', (await counter.locator('#sum').innerText()).replace(/\s+/g, ' '));
await shot(counter, '05-wizard-charges');
await counter.click('#next');
// step 7 · currency
await counter.waitForSelector('[data-cur]');
await counter.click('[data-cur="TZS"]');
await counter.waitForTimeout(200);
await shot(counter, '06-wizard-currency');
await counter.click('#next');
// step 8 · review
await counter.waitForSelector('.callout.ok');
await shot(counter, '07-wizard-review');
await counter.click('#next');
await counter.waitForURL(/#\/shipment\/[0-9a-f-]{36}$/, { timeout: 10000 });
await counter.waitForSelector('#page h1.mono');
const ref = await counter.locator('#page h1.mono').innerText();
console.log('  created:', ref);
await counter.waitForTimeout(700);
await shot(counter, '08-shipment-detail');
const url = counter.url(); const sid = url.split('/').pop();

step('customer was auto-registered');
await go(counter, '#/customers');
console.log('  Neema found:', await counter.locator('td:has-text("Neema Mushi")').count() > 0);
await counter.click('tr:has-text("Neema Mushi")');
await counter.waitForSelector('#page .page-head');
await counter.waitForTimeout(500);
console.log('  customer page shipments:', await counter.locator('#page tbody tr, #page .lc').count());
await shot(counter, '09-customer');

step('wizard reuses the existing customer');
await go(counter, '#/shipments/new');
await counter.fill('[data-find="sender"]', 'Neema Mushi');
await counter.waitForSelector('.cust-hits .hit', { timeout: 6000 });
await shot(counter, '10-customer-search');
await counter.click('.cust-hits .hit');
await counter.waitForTimeout(300);
console.log('  sender prefilled:', await counter.inputValue('[data-f="sender.name"]'), '|', await counter.inputValue('[data-f="sender.phone"]'));

step('operations updates the status');
const ops = await as('ops@hc.test');
await go(ops, `#/shipment/${sid}`);
await ops.click('.sbtn[data-status="packed"]'); console.log('  toast:', await toastText(ops));
await ops.waitForTimeout(900);
await ops.click('.sbtn[data-status="dispatched"]'); await toastText(ops); await ops.waitForTimeout(900);
console.log('  status now:', await ops.locator('#page .page-head .badge').first().innerText());
await shot(ops, '11-status-updated');

step('warehouse records the GRN');
const wh = await as('warehouse@hc.test');
await go(wh, `#/shipment/${sid}/grn`);
await wh.fill('#lines tbody tr:first-child [data-k=pieces]', '10');
await wh.fill('#lines tbody tr:first-child [data-k=length_cm]', '50');
await wh.fill('#lines tbody tr:first-child [data-k=width_cm]', '40');
await wh.fill('#lines tbody tr:first-child [data-k=height_cm]', '45');
await wh.fill('#lines tbody tr:first-child [data-k=weight_kg]', '280');
await wh.waitForTimeout(200);
await shot(wh, '12-grn');
await wh.click('#save');
await wh.waitForSelector('.confirm-ok, .modal', { timeout: 5000 }).catch(() => {});
const okBtn = wh.locator('.modal .btn.primary, .modal .btn.danger').first();
if (await okBtn.count()) await okBtn.click();
console.log('  grn toast:', await toastText(wh).catch(() => 'n/a'));
await wh.waitForTimeout(900);

step('cashier records a payment');
const cash = await as('cashier@hc.test');
await go(cash, `#/shipment/${sid}`);
await cash.click('[data-act=pay]');
await cash.waitForSelector('#pay-form');
await cash.waitForTimeout(400);
console.log('  currency preset:', await cash.inputValue('#pay-form [name=currency]'), '| amount', await cash.inputValue('#pay-form [name=amount]'));
await cash.fill('#pay-form [name=amount]', '200000');
await cash.selectOption('#pay-form [name=method]', 'mobile_money');
await shot(cash, '13-payment');
await cash.click('#pay-save');
console.log('  toast:', await toastText(cash));
await cash.waitForTimeout(900);
await cash.keyboard.press('Escape');
console.log('  payment badge:', await cash.locator('#page .page-head .badge').nth(1).innerText());

step('manager adds a charge and edits the shipment');
const admin = await as('admin@hc.test');
await go(admin, `#/shipment/${sid}`);
await admin.click('[data-act=charge]');
await admin.waitForSelector('#cf');
await admin.selectOption('#cf [name=charge_type]', 'storage');
await admin.fill('#cf [name=unit_price]', '25');
await admin.fill('#cf [name=description]', '5 days storage');
await admin.click('#cs'); console.log('  toast:', await toastText(admin));
await admin.waitForTimeout(800);
await go(admin, `#/shipment/${sid}/edit`);
await admin.click('.wiz-step[data-i="3"]').catch(() => {});
for (let i = 0; i < 3; i++) { await admin.click('#next'); await admin.waitForTimeout(250); }
await admin.waitForSelector('[data-f="cbm"]');
await admin.fill('[data-f="cbm"]', '3.1');
await admin.click('#next'); await admin.waitForTimeout(300);
await admin.click('#next'); await admin.waitForTimeout(300);
await admin.click('#next');
console.log('  edit toast:', await toastText(admin));
await admin.waitForTimeout(900);
await shot(admin, '14-after-edit');
const totals = await admin.locator('#page .kpi .v').allInnerTexts();
console.log('  KPIs after edit:', totals.join(' | '));

step('release officer delivers');
await go(ops, `#/shipment/${sid}`);
for (const st of ['in_transit', 'in_customs', 'arrived']) {
  await ops.click(`.sbtn[data-status="${st}"]`); await toastText(ops); await ops.waitForTimeout(900);
}
const rel = await as('release@hc.test');
await go(rel, `#/shipment/${sid}`);
console.log('  release officer sees status buttons:', await rel.locator('.sbtn[data-status]').count());
await rel.click('[data-act=deliver]');
await rel.waitForSelector('#df');
await shot(rel, '15-deliver');
await rel.click('#ds'); console.log('  toast:', await toastText(rel));
await rel.waitForTimeout(900);
console.log('  final status:', await rel.locator('#page .page-head .badge').first().innerText());
await shot(rel, '16-delivered');

step('documents');
await go(admin, `#/doc/invoice/${sid}`); await shot(admin, '17-invoice');
console.log('  invoice rows:', await admin.locator('.doc table tbody tr').count());
await go(admin, `#/doc/waybill/${sid}`); await shot(admin, '18-waybill');
await go(admin, `#/doc/label/${sid}`).catch(() => {});
await go(admin, `#/doc/labels/${sid}`).catch(() => {});

step('lists, dashboard, reports');
await go(admin, '#/shipments'); await shot(admin, '19-list');
console.log('  list rows:', await admin.locator('#list tbody tr').count());
await admin.click('#chips .chip[data-v="delivered"]'); await admin.waitForTimeout(600);
console.log('  delivered filter:', await admin.locator('#list tbody tr').count());
await go(admin, '#/'); await shot(admin, '20-dashboard');
console.log('  dashboard KPIs:', (await admin.locator('.kpi .v').allInnerTexts()).join(' | '));
await go(admin, '#/reports'); await admin.waitForTimeout(800); await shot(admin, '21-reports');

step('accounting: shipment profit');
const fin = await as('finance@hc.test');
await go(fin, '#/acc/reports?tab=ships');
await fin.waitForSelector('#out .table-wrap, #out .empty');
console.log('  shipment P&L rows:', await fin.locator('#out tbody tr').count());
await shot(fin, '22-acc-shipment-pnl');
await fin.locator('#out tr[data-ship]').first().click();
await fin.waitForSelector('.modal');
await shot(fin, '23-acc-pnl-modal');
await fin.keyboard.press('Escape');
await go(fin, '#/acc/reports?tab=bs'); await fin.waitForTimeout(800);
console.log('  balance sheet:', (await fin.locator('#out .callout').allInnerTexts()).join(' / ').slice(0, 90));
await go(fin, `#/shipment/${sid}`);
await fin.waitForSelector('#pnl .money', { timeout: 8000 });
console.log('  P&L card:', (await fin.locator('#pnl .money .v').allInnerTexts()).join(' | '));

step('mobile · Swahili');
const mob = await as('counter@hc.test', MOB, 'sw');
await go(mob, '#/shipments/new'); await shot(mob, '24-m-wizard');
await mob.click('#next').catch(() => {});
await go(mob, '#/shipments'); await shot(mob, '25-m-list');
await go(mob, `#/shipment/${sid}`); await shot(mob, '26-m-detail');

step('public tracking');
const pub = await browser.newPage();
await pub.goto(`${BASE}/track.html?ref=${encodeURIComponent(ref)}`);
await pub.waitForTimeout(1500);
await shot(pub, '27-track');
console.log('  track text:', (await pub.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 180));

console.log('\nERRORS:', errors.length ? errors : 'none');
await browser.close();
