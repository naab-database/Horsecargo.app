import { chromium } from 'playwright';
const BASE = 'http://localhost:8787';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
const DESK = { width: 1366, height: 860 }, MOB = { width: 400, height: 860 };
const SH = 'shots-acc/';
async function as(email, viewport = DESK, lang = 'en') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport === MOB ? 2 : 1 });
  await ctx.addInitScript((l) => { try { localStorage.setItem('hc.lang', l); } catch {} }, lang);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(email + ' pageerror: ' + e.message));
  p.on('response', async (r) => { if ((r.url().includes('/rest/') || r.url().includes('/auth/')) && r.status() >= 400) console.log('   HTTP', r.status(), r.url().slice(22, 110), (await r.text()).slice(0, 200)); });
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(email + ' console: ' + m.text()); });
  await p.goto(BASE + '/');
  await p.fill('input[name=email]', email); await p.fill('input[name=password]', 'Pass1234!');
  await p.click('button[type=submit]');
  await p.waitForSelector('#page .page-head, #page .card', { timeout: 10000 });
  await p.waitForTimeout(400);
  return p;
}
const go = async (p, hash) => { await p.goto(BASE + '/#/profile'); await p.waitForTimeout(300); await p.goto(BASE + '/' + hash); await p.waitForSelector('#page .page-head, #page .card', { timeout: 10000 }); await p.waitForTimeout(700); };
const toastText = async (p) => { await p.waitForSelector('.toast', { timeout: 6000 }); return p.locator('.toast').last().innerText(); };
const step = (s) => console.log('▶', s);
const shot = (p, n) => p.screenshot({ path: SH + n + '.png', fullPage: true });

step('accountant dashboard');
const acct = await as('accountant@hc.test');
await go(acct, '#/acc');
console.log('  nav acc items:', await acct.locator('.nav a[href^="#/acc"]').count());
console.log('  kpis:', (await acct.locator('.kpi .v').allInnerTexts()).join(' | '));
await shot(acct, '01-acc-dashboard');

step('accountant: supplier bill linked to a shipment (TZ branch → AE shipment = intercompany)');
// make sure there is at least one shipment to attach costs to (created by a counter user)
const setup = await as('counter@hc.test');
const shipId = await setup.evaluate(async () => {
  const { from, rpc } = await import('./js/api.js');
  const { data } = await from('shipments').select('id').limit(1);
  if (data && data.length) return data[0].id;
  const r = await rpc('create_shipment', { p: { mode: 'sea', origin_branch: 'DXB', destination_branch: 'DAR',
    sender: { name: 'Accounting Test Ltd', phone: '0754010203' }, receiver: { name: 'Receiver', phone: '0754010204' },
    items: [{ description: 'Test cargo', category_id: 3, qty: 5 }], category_id: 3, cbm: 2.5 } });
  return r.id;
});
await go(acct, `#/acc/bills/new?shipment=${shipId}`);
await acct.click('#newsup');
await acct.fill('#sf [name=name]', 'Dar Port Transporters');
await acct.selectOption('#sf [name=kind]', 'transport');
await acct.selectOption('#sf [name=default_account_code]', '5400');
await acct.click('#ss'); await acct.waitForSelector('#sf', { state: 'detached' });
await acct.fill('#bf [name=supplier_invoice_no]', 'DPT-311');
await acct.selectOption('#bf [name=branch_code]', 'DAR');
await acct.selectOption('#bf [name=currency]', 'TZS');
await acct.fill('#lines [data-k=description]', 'Truck port → Kariakoo');
await acct.fill('#lines [data-k=amount]', '390000');
await shot(acct, '02-bill-new');
await acct.click('#bf button[type=submit]');
await acct.waitForURL(/#\/acc\/bill\//, { timeout: 8000 }); await acct.waitForSelector('#page h1.mono'); await acct.waitForTimeout(600);
console.log('  bill:', await acct.locator('#page h1').innerText(), '| postings rows:', await acct.locator('#page .card:has-text("Ledger postings") tbody tr').count());
step('accountant pays bill');
await acct.click('[data-act=pay]');
await acct.selectOption('#pf [name=acc]', { label: 'TZ · Bank — TZS' });
await acct.click('#ps'); console.log('  toast:', await toastText(acct));
await acct.waitForTimeout(800);
console.log('  status badge:', await acct.locator('#page .page-head .badge').first().innerText());
await shot(acct, '03-bill-paid');

step('accountant: expense from list modal');
await go(acct, '#/acc/expenses?new=1');
await acct.waitForSelector('#xf');
await acct.selectOption('#xf [name=money]', { label: 'AE · Cash — Dubai (AED)' });
await acct.waitForTimeout(300);
await acct.selectOption('#xf [name=account]', '6500').catch(async () => { await acct.selectOption('#xf [name=account]', { index: 3 }); });
await acct.fill('#xf [name=description]', 'Office internet Dubai');
await acct.fill('#xf [name=amount]', '367');
await shot(acct, '04-expense-modal');
await acct.click('#xs'); console.log('  toast:', await toastText(acct));
await acct.waitForTimeout(600);
console.log('  expense rows:', await acct.locator('#list tbody tr').count());

step('accountant: manual journal (bank the day\'s cash)');
await go(acct, '#/acc/journals?new=1');
await acct.waitForSelector('#jf');
await acct.selectOption('#jco', 'TZ');
await acct.fill('#jf [name=memo]', 'Bank the cash of Dar es Salaam');
const rows = acct.locator('#jlines tr');
await rows.nth(0).locator('.acc').selectOption({ label: /Bank — TZS/ }).catch(async () => {
  const v = await rows.nth(0).locator('.acc option', { hasText: 'Bank — TZS' }).first().getAttribute('value'); await rows.nth(0).locator('.acc').selectOption(v); });
const cashV = await rows.nth(1).locator('.acc option', { hasText: 'Cash — Dar es Salaam (TZS)' }).first().getAttribute('value');
await rows.nth(1).locator('.acc').selectOption(cashV);
await rows.nth(0).locator('.dr').fill('150');
await rows.nth(1).locator('.cr').fill('140');
console.log('  diff shown:', await acct.locator('#jdiff').innerText());
await acct.click('#js'); console.log('  unbalanced toast:', await toastText(acct));
await rows.nth(1).locator('.cr').fill('150');
await shot(acct, '05-journal-modal');
await acct.click('#js'); console.log('  toast:', await toastText(acct));
await acct.waitForTimeout(600);
await acct.click('#chips .chip[data-v=draft]'); await acct.waitForTimeout(500);
console.log('  drafts:', await acct.locator('#list tbody tr').count());
await acct.locator('#list tbody tr').first().click(); await acct.waitForSelector('.modal');
console.log('  accountant sees approve btn:', await acct.locator('.modal [data-a=approve]').count());
await acct.keyboard.press('Escape');

step('finance manager approves + reports');
const fin = await as('finance@hc.test');
await go(fin, '#/acc/journals?status=draft');
await fin.locator('#list tbody tr').first().click(); await fin.waitForSelector('.modal [data-a=approve]');
await shot(fin, '06-journal-approve');
await fin.click('.modal [data-a=approve]'); console.log('  toast:', await toastText(fin));

for (const tab of ['pl', 'bs', 'tb', 'ships']) {
  await go(fin, `#/acc/reports?tab=${tab}`);
  await fin.waitForSelector('#out .table-wrap, #out .empty', { timeout: 8000 });
  const call = await fin.locator('#out .callout').allInnerTexts();
  console.log(`  ${tab}:`, call.join(' / ').replace(/\s+/g, ' ').slice(0, 160), '| rows', await fin.locator('#out tbody tr').count());
  await shot(fin, `07-report-${tab}`);
}
await go(fin, '#/acc/reports?tab=ships');
await fin.waitForSelector('#out tr[data-ship]', { timeout: 8000 });
await fin.locator('#out tr[data-ship]').first().click(); await fin.waitForSelector('.modal');
await shot(fin, '08-shipment-pnl-modal');
await fin.keyboard.press('Escape');

step('finance: company switch AE on reports bs');
await go(fin, '#/acc/reports?tab=bs');
await fin.selectOption('#company', 'AE'); await fin.waitForTimeout(900);
console.log('  AE bs:', (await fin.locator('#out .callout').allInnerTexts()).join(' / '));
await fin.selectOption('#company', ''); await fin.waitForTimeout(500);

step('finance: CoA, account ledger, money, suppliers');
await go(fin, '#/acc/coa'); await shot(fin, '09-coa');
await fin.click('#new'); await fin.fill('#af [name=code]', '6450'); await fin.selectOption('#af [name=type]', 'expense');
await fin.fill('#af [name=name]', 'Security services'); await fin.fill('#af [name=name_sw]', 'Huduma za ulinzi');
await fin.click('#as'); console.log('  toast:', await toastText(fin)); await fin.waitForTimeout(600);
console.log('  6450 present:', await fin.locator('tr[data-code="6450"]').count());
await go(fin, '#/acc/account/1300'); console.log('  AR ledger rows:', await fin.locator('#out tbody tr').count(), '|', (await fin.locator('#out .money .v').allInnerTexts()).join(' '));
await shot(fin, '10-account-ledger');
await go(fin, '#/acc/money'); await shot(fin, '11-money');
await fin.click('#new'); await fin.selectOption('#mf [name=branch]', 'MWZ'); await fin.fill('#mf [name=name]', 'Bank — CRDB Mwanza'); await fin.selectOption('#mf [name=kind]', 'bank'); await fin.selectOption('#mf [name=currency]', 'TZS');
await fin.click('#ms'); console.log('  toast:', await toastText(fin)); await fin.waitForTimeout(700);
console.log('  money rows:', await fin.locator('#page tbody tr').count());
await go(fin, '#/acc/suppliers'); await shot(fin, '12-suppliers');
console.log('  supplier rows:', await fin.locator('#list tbody tr').count());

step('finance: shipment page P&L card');
await go(fin, `#/shipment/${shipId}`);
await fin.waitForSelector('#pnl .money', { timeout: 8000 });
console.log('  pnl:', (await fin.locator('#pnl .money .v').allInnerTexts()).join(' | '));
await shot(fin, '13-shipment-pnl');

step('cashier: payment modal Paid into; no accounting nav');
const cash = await as('cashier@hc.test');
console.log('  cashier acc nav:', await cash.locator('.nav a[href^="#/acc"]').count());
const bkId = await cash.evaluate(async () => { const { from } = await import('./js/api.js'); const { data } = await from('v_shipments').select('id,status').neq('status', 'delivered').neq('status', 'cancelled').limit(1); return data[0]?.id; });
if (bkId) {
  await go(cash, `#/shipment/${bkId}`);
  await cash.click('[data-act=pay]'); await cash.waitForSelector('#pay-form [name=account]'); await cash.waitForTimeout(500);
  console.log('  paid-into options:', (await cash.locator('#pay-form [name=account] option').allInnerTexts()).join(' | '));
  await shot(cash, '14-payment-paid-into');
}
await cash.goto(BASE + '/#/acc'); await cash.reload(); await cash.waitForSelector('#page .callout'); console.log('  cashier /acc:', (await cash.locator('#page').innerText()).slice(0, 80));

step('mobile Swahili accountant');
const mob = await as('accountant@hc.test', MOB, 'sw');
await go(mob, '#/acc'); await shot(mob, '15-m-sw-dashboard');
await go(mob, '#/acc/reports?tab=containers'); await mob.waitForSelector('#out .table-wrap, #out .empty'); await shot(mob, '16-m-sw-containers');
await go(mob, '#/more'); await shot(mob, '17-m-sw-more');

console.log('\nERRORS:', errors.length ? errors : 'none');
await browser.close();
