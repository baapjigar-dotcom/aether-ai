/**
 * NovaOS Enterprise v5.0 — Page Module: `pages/code-sandbox.js`
 * Description: Nova Code & SQL Query Sandbox: Interactive SQL-like collection query runner and JavaScript/TypeScript snippet evaluator.
 */
export function renderCodeSandboxPage(state) {
  return {
    module: "code-sandbox.js",
    description: 'Nova Code & SQL Query Sandbox: Interactive SQL-like collection query runner and JavaScript/TypeScript snippet evaluator.',
    activeUser: state?.currentUser?.email || null,
    customersReached: Object.values(state?.smartDb?.collections || {}).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0),
    ready: true
  };
}
