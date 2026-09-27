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

Same-shell tasks (no extra routes):

- Finance: "Compare overdue invoices by customer" → sortable comparison with tool-computed totals and account selection
- Support: "Show unassigned escalations" then assign through the generated confirmation
- Operations: "Show me the error rate trend over the past week" → service error-rate chart from `get_service_health_series`
- Any authorized user: "Draft an onboarding checklist for customer-001" → editable draft with explicit assumptions
- Any authorized user: "Show only these accounts as a table" → reuses the thread's stored records
- Unsupported: "Refund every overdue invoice by wire transfer" stops with a limitation
- Not granted: support asking for overdue invoices, or operations asking to assign a ticket, returns a limitation naming the unavailable domain and the alternatives that persona does have
- Unseen capability (no planner/page branch): "What open incidents should I know about?"

Replay without model calls: `pnpm replay`.
Fixture evaluation: `pnpm eval` (27 investigation runs + the 66-cell acceptance matrix).
Live-strict evaluation: `MODEL_PROVIDER=explabs pnpm eval:live`. Explicit fallback evaluation: `pnpm eval:live-fallback`. Neither has been rerun since 2026-09-20.
