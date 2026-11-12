/**
 * NovaOS Enterprise v5.0 — Page Module: `pages/dashboard.js`
 * Description: Executive Command Dashboard (No chatbox) displaying Customers Reached, Questions Asked, Active Consultations, and Neural Core Audit.
 */
export function renderExecutiveDashboard(state) {
  return {
    module: "dashboard.js",
    description: 'Executive Command Dashboard (No chatbox) displaying Customers Reached, Questions Asked, Active Consultations, and Neural Core Audit.',
    activeUser: state?.currentUser?.email || null,
    customersReached: Object.values(state?.smartDb?.collections || {}).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0),
    ready: true
  };
}
