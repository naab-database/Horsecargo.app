import { t, getLang } from './i18n.js';

const cfg = window.HC_CONFIG || {};
export const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_URL.includes('YOUR-PROJECT'));
export const sb = configured
  ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'hc.auth' } })
  : null;

export const state = { user: null, profile: null, settings: null, branches: [], categories: [] };

// ───────── error translation (server refusals → readable text) ─────────
const SW = {
  NOT_ALLOWED: 'Cheo chako hakiruhusu kitendo hiki.',
  DEPOSIT_GATE: 'Kizuizi cha amana: booking hii haina amana — mzigo hauwezi kupokelewa.',
  SEGREGATION: 'Mgawanyo wa majukumu: mtu mwingine lazima afanye hatua hii.',
};
export function errText(e) {
  let m = (e && (e.message || e.error_description || e.msg)) || String(e);
  const code = (m.match(/^([A-Z_]+):/) || [])[1];
  if (m.includes('Invalid login credentials')) return getLang() === 'sw' ? 'Barua pepe au nenosiri si sahihi.' : 'Wrong email or password.';
  if (m.includes('Failed to fetch') || m.includes('NetworkError')) return getLang() === 'sw' ? 'Hakuna mtandao. Jaribu tena.' : 'No connection. Please try again.';
  if (code === 'NOT_ALLOWED') return getLang() === 'sw' ? SW.NOT_ALLOWED : 'Your role is not allowed to do this.';
  if (code === 'SETTLEMENT_GATE') {
    const amt = (m.match(/USD ([\d.]+)/) || [])[1];
    return getLang() === 'sw' ? `Kizuizi cha malipo: deni la USD ${amt} bado halijalipwa — mzigo haukabidhiwi.` : m.replace(/^[A-Z_]+:\s*/, 'Settlement gate: ');
  }
  if (code && getLang() === 'sw' && SW[code]) return SW[code];
  if (m.includes('permission denied')) return getLang() === 'sw' ? SW.NOT_ALLOWED : 'Your role is not allowed to do this.';
  return m.replace(/^[A-Z_]+:\s*/, '');
}
export function errCode(e) { return ((e?.message || '').match(/^([A-Z_]+):/) || [])[1] || null; }

// ───────── thin query helpers ─────────
export async function run(builder) {
  const { data, error, count } = await builder;
  if (error) throw error;
  return count !== undefined && count !== null ? { data, count } : data;
}
export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}
export const from = (table) => sb.from(table);

// ───────── session / cached reference data ─────────
export async function loadSession() {
  const { data } = await sb.auth.getSession();
  state.user = data.session?.user || null;
  if (!state.user) { state.profile = null; return null; }
  const { data: p, error } = await sb.from('profiles').select('*').eq('id', state.user.id).maybeSingle();
  if (error) throw error;
  state.profile = p;
  return p;
}
export async function loadReference(force = false) {
  if (state.settings && !force) return;
  const [s, b, c] = await Promise.all([
    run(sb.from('settings').select('*').eq('id', 1).maybeSingle()),
    run(sb.from('branches').select('*').order('code')),
    run(sb.from('cargo_categories').select('*').order('name')),
  ]);
  state.settings = s; state.branches = b || []; state.categories = c || [];
}
export const branchName = (code) => state.branches.find((b) => b.code === code)?.name || code || '—';
export const catName = (row) => (getLang() === 'sw' && row.category_name_sw) ? row.category_name_sw : row.category_name;

// ───────── permissions (mirror of has_role() in the database) ─────────
const PERMS = {
  'customer.write': ['manager', 'counter', 'cashier'],
  'booking.create': ['manager', 'counter'],
  'booking.edit': ['manager', 'counter'],
  'booking.cancel': ['manager'],
  'payment.record': ['cashier', 'manager'],
  'payment.void': ['manager'],
  'grn.record': ['warehouse', 'manager'],
  'invoice.line': ['manager', 'counter', 'operations'],
  'invoice.discount': ['manager'],
  'invoice.remove': ['manager'],
  'shipment.write': ['manager', 'operations'],
  'shipment.load': ['operations', 'warehouse', 'manager'],
  'shipment.status': ['operations', 'manager'],
  'booking.status': ['operations', 'manager'],
  'tracking.note': ['operations', 'manager', 'counter', 'warehouse'],
  'release': ['release_officer', 'manager'],
  'rates.write': ['manager'],
  'settings.write': ['manager'],
  'audit.read': ['manager'],
  'reports.read': ['manager', 'cashier', 'operations'],
  'users.manage': [],
};
export function can(action) {
  const r = state.profile?.role;
  if (!r || !state.profile?.active) return false;
  if (r === 'admin') return true;
  return (PERMS[action] || []).includes(r);
}
export const isAdmin = () => state.profile?.role === 'admin' && state.profile?.active;

// ───────── pricing preview (server is authoritative) ─────────
export function estimateFreight(mode, catId, cbm, kg) {
  const s = state.settings; const c = state.categories.find((x) => x.id === Number(catId));
  if (!s || !c) return 0;
  if (mode === 'sea') return Math.max(Math.max(Number(cbm || 0), Number(s.min_cbm_sea)) * c.sea_rate_cbm, c.min_charge_sea);
  const vol = Number(cbm || 0) * 1e6 / Number(s.air_volumetric_divisor);
  return Math.max(Math.max(Number(kg || 0), vol) * c.air_rate_kg, c.min_charge_air);
}
export function depositFor(mode, quote) {
  const s = state.settings; if (!s) return 0;
  return Math.round(quote * (mode === 'sea' ? s.deposit_pct_sea : s.deposit_pct_air)) / 100;
}

export function publicTrackUrl(ref) {
  const base = cfg.PUBLIC_TRACK_URL || (location.origin + location.pathname.replace(/[^/]*$/, '') + 'track.html');
  return `${base}?ref=${encodeURIComponent(ref)}`;
}
export const photoBucket = () => cfg.PHOTO_BUCKET || '';
export { t };
