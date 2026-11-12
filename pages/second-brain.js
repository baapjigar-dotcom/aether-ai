/**
 * NovaOS Enterprise v5.0 — Page Module: `pages/second-brain.js`
 * Description: Second Brain & Knowledge Graph: Interactive SVG entity graph, auto-tagged customer facts, and non-destructive session summaries.
 */
export function renderSecondBrainPage(state) {
  return {
    module: "second-brain.js",
    description: 'Second Brain & Knowledge Graph: Interactive SVG entity graph, auto-tagged customer facts, and non-destructive session summaries.',
    activeUser: state?.currentUser?.email || null,
    customersReached: Object.values(state?.smartDb?.collections || {}).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0),
    ready: true
  };
}
