# Demo scenario

Fixed clock: `2026-09-20T08:00:00Z`.

Seed: `pnpm db:seed` (defaults to `sync-regression`).

Opening question (paraphrases are valid):

> What should I care about this morning?

Expected discovery path:

1. Reliability sees an elevated sync-v2 error rate after `release-2026-09-19-3`.
2. Product sees a synchronization usage drop versus the equal prior period.
3. Customer sees sync_failure tickets. Tickets are corroboration, not the affected-account definition.
4. Finance sums ARR once per telemetry-impacted account (illustrative target: 14 accounts / $2.1M ARR).
5. Root cause remains a hypothesis.

Follow-ups from generated A2UI actions: affected accounts, release inspection, account inspection, financial impact, evidence envelopes, table view, ticket assignment.

Other same-shell tasks (no extra routes):

- Finance: “Compare overdue invoices by customer”
- Support: “Show unassigned escalations” then assign through the generated confirmation
- Unsupported: “Refund every overdue invoice by wire transfer” stops with a limitation
- Unseen capability (no planner/page branch): “What open incidents should I know about?”

Replay without model calls: `pnpm replay`.
Live-strict evaluation: `MODEL_PROVIDER=explabs pnpm eval:live`. Explicit fallback evaluation: `pnpm eval:live-fallback`.
