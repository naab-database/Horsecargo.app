// Shared helpers for the accounting pages
import { t, getLang } from './i18n.js';
import { from, run, state } from './api.js';
import { esc, usd } from './ui.js';

export const TYPES = ['asset', 'liability', 'equity', 'revenue', 'contra_revenue', 'cost_of_sales', 'expense'];
export const COST_TYPES = ['cost_of_sales', 'expense', 'asset', 'liability'];
const BLOCKED_KEYS = ['AR', 'AP', 'IC_DUE_FROM', 'IC_DUE_TO', 'CUST_DEP', 'RETAINED', 'OPENING'];

export function getCompany() {
  try { return localStorage.getItem('hc.company') ?? ''; } catch { return ''; }
}
export function setCompany(c) {
  try { localStorage.setItem('hc.company', c); } catch { /* ignore */ }
}
export const companyName = (code) => state.companies.find((c) => c.code === code)?.name || code || t('acc_consolidated');

export function companySelect(id = 'company', value = getCompany(), allowAll = true) {
  return `<select class="input" id="${id}" style="width:auto">
    ${allowAll ? `<option value="" ${value === '' ? 'selected' : ''}>${esc(t('acc_consolidated'))}</option>` : ''}
    ${state.companies.map((c) => `<option value="${c.code}" ${value === c.code ? 'selected' : ''}>${esc(c.code)} · ${esc(c.name)}</option>`).join('')}
  </select>`;
}

let accountsCache = null;
export async function loadAccounts(force = false) {
  if (!accountsCache || force) accountsCache = await run(from('accounts').select('*').order('code'));
  return accountsCache;
}
export const accName = (a) => (getLang() === 'sw' && a.name_sw) ? a.name_sw : a.name;

// options for cost lines (bills / expenses), unique by code (same code exists in both companies)
export async function costAccountOptions(company, selected = '') {
  const all = await loadAccounts();
  const rows = all.filter((a) => a.active && !a.is_money && COST_TYPES.includes(a.type) && !BLOCKED_KEYS.includes(a.system_key)
    && (!company || a.company_code === company));
  const seen = new Set(); const groups = {};
  for (const a of rows) {
    if (seen.has(a.code)) continue; seen.add(a.code);
    (groups[a.type] = groups[a.type] || []).push(a);
  }
  return ['cost_of_sales', 'expense', 'liability', 'asset'].filter((g) => groups[g]).map((g) =>
    `<optgroup label="${esc(t('at_' + g))}">${groups[g].map((a) => `<option value="${a.code}" ${selected === a.code ? 'selected' : ''}>${a.code} · ${esc(accName(a))}</option>`).join('')}</optgroup>`).join('');
}

let moneyCache = null;
export async function loadMoneyAccounts(force = false) {
  if (!moneyCache || force) moneyCache = await run(from('money_accounts').select('*').eq('active', true).order('company_code').order('name'));
  return moneyCache;
}
export function moneyOptions(list, selected = '', company = '') {
  return list.filter((m) => !company || m.company_code === company)
    .map((m) => `<option value="${m.id}" ${selected === m.id ? 'selected' : ''} data-currency="${m.currency}" data-company="${m.company_code}">${esc(m.company_code)} · ${esc(m.name)}</option>`).join('');
}

export function fxDefault(cur) {
  const s = state.settings || {};
  return cur === 'AED' ? s.fx_aed : cur === 'TZS' ? s.fx_tzs : 1;
}

export function signed(n) {
  const v = Number(n || 0);
  return v < 0 ? `(${usd(-v)})` : usd(v);
}

export const sourceLabel = (s) => t('src_' + s);

// shipments & bookings pickers for linking costs
export async function shipmentOptions(selected = '') {
  const rows = await run(from('v_shipments').select('id,ref,customer_name,status,origin_branch,destination_branch').order('created_at', { ascending: false }).limit(300));
  return `<option value="">—</option>` + rows.map((s) => `<option value="${s.id}" ${selected === s.id ? 'selected' : ''}>${esc(s.ref)} · ${esc(s.customer_name)} · ${esc(s.origin_branch)}→${esc(s.destination_branch)}</option>`).join('');
}
