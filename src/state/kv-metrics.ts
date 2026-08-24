// Accounting for full-scope enumerations.
//
// state::list has no pagination: the engine materialises the whole scope as one
// JSON array and ships it over the WebSocket. That is fine for a scope with 20
// rows and fatal for one with 90,000 — the graph read path spent 60.8 MB and
// ~2.1s per search on exactly this, and the growth was invisible because nothing
// counted it. See docs/investigations/2026-08-24-latency-and-oom.md.
//
// This keeps a small fixed-size tally so /health can name the expensive scopes
// instead of leaving an operator guessing.

interface ScopeStats {
  calls: number;
  rows: number;
  maxRows: number;
  totalMs: number;
  maxMs: number;
}

const stats = new Map<string, ScopeStats>();

// Some scopes are templated per session or per observation (see the functions in
// src/state/schema.ts), so their raw key space is unbounded and has to be
// collapsed to keep this map bounded. Fixed scopes are left alone: collapsing
// them would merge mem:graph:nodes with mem:graph:edges and hide exactly the
// distinction this tally exists to show.
const TEMPLATED_PREFIXES = [
  "mem:obs:",
  "mem:raw:",
  "mem:evt:",
  "mem:emb:",
  "mem:team:",
  "mem:enriched:",
  "mem:latent:",
];

function normalizeScope(scope: string): string {
  const prefix = TEMPLATED_PREFIXES.find((p) => scope.startsWith(p));
  return prefix ? `${prefix}*` : scope;
}

export function recordKvList(scope: string, rows: number, ms: number): void {
  const key = normalizeScope(scope);
  const existing = stats.get(key) ?? {
    calls: 0,
    rows: 0,
    maxRows: 0,
    totalMs: 0,
    maxMs: 0,
  };
  existing.calls++;
  existing.rows += rows;
  existing.maxRows = Math.max(existing.maxRows, rows);
  existing.totalMs += ms;
  existing.maxMs = Math.max(existing.maxMs, ms);
  stats.set(key, existing);
}

// Only the scopes worth looking at: the widest enumerations, by peak row count.
export function getKvListStats(limit = 8): Array<{
  scope: string;
  calls: number;
  maxRows: number;
  avgRows: number;
  maxMs: number;
  avgMs: number;
}> {
  return [...stats.entries()]
    .map(([scope, s]) => ({
      scope,
      calls: s.calls,
      maxRows: s.maxRows,
      avgRows: Math.round(s.rows / s.calls),
      maxMs: s.maxMs,
      avgMs: Math.round(s.totalMs / s.calls),
    }))
    .sort((a, b) => b.maxRows - a.maxRows)
    .slice(0, limit);
}

export function resetKvListStats(): void {
  stats.clear();
}
