# Plan: Live-quality Phase F (artifacts + morning signal + ops trend)

## Baseline (Tester post–E-B `eval:live`)
- **strictRate 0.80 (60/75)**, substitutedRuns **0**, investigation **3/9**, matrix **57/66**.
- Prior: 0.44 → E-B coerce/inject lifted specialists; remaining gap is composition + trend tool path, not Zod.
- Artifact: `/workspace/anc-phase-e/eval-live-post-eb-tail.txt`

### Failure shape (from that report)
| Bucket | Evidence |
|---|---|
| **investigation sync-regression 0/3** | Surface titled **"Unassigned support queue"**; `error_signal` fail (no “error” in blob); specialists often ran (overlap OK) but reliability signal weak / wrong surface title |
| **investigation unrelated-anomaly 0/3** | Same queue title / quiet subtitle; `follows_evidence` fail |
| **quiet-day ~3/3** | Likely the only investigation passes |
| **user-ops/retrieve_compare 0/3** | Incomplete answer; wanted **trend** got summary; **0 chart points** |
| Other matrix (lower priority) | finance retrieve_compare 4/6; one COO queue Incomplete; some contextual followups with 0 rows |
| E-B probes (compose_miss / tool_empty) | ops-trend: model **called** `get_service_health_series` but **0 evidence persisted**; draft/queue: findings land, surface miss |

### Root cause (code, confirmed read-only)
1. **Live specialists never materialize view artifacts.** Only `specialists/fixture.ts` `runCapabilities` calls `store.saveArtifact` for `series` / table-queue/comparison. `live.ts` validates findings only → compose has no chart/rows even when tools succeed (`graph.ts` `toPresentation` reads artifacts for chart/table).
2. **ops-trend tool_empty:** series tool invoked but evidence not saved (likely MCP throw / bad args / non-structured result) — fix call+persist, then artifact materialization.
3. **Morning compose/title:** `viewFor` returns `comparison` whenever any scheduled task includes `cap.finance.invoices` (typical morning plan) — fights summary. Queue artifact/finding titled from cap description **"Unassigned support queue"** can win `toPresentation` title over broad “Morning overview” when a table artifact is present. Reliability often hits incidents/maintenance instead of `get_error_metrics` → rubric `error_signal` fails.
4. **compose_miss draft/queue (cheap only):** draft needs customer entities for `buildDraft`; queue needs table artifact from `list_unassigned_escalations` — both largely fixed by (1) if entities/rows land.

## Goal
Smallest pass to move **investigation off ~3/9** (esp. sync-regression) and **user-ops/retrieve_compare off 0/3**, without fixture substitution. Target: clear lift toward ≥0.9; one full `eval:live` only after ≤5 green probes + Chief go.

## Constraints
- No fixture swap under live-strict; no rubric softening; thin shell unchanged; no Slice 4 / push unless Chief asks.
- Spend-conscious: ≤**5** probes before another 75-run live.
- Leave finance prepare_execute / strong cells alone unless they regress.

## Files to touch
- **Primary:** `apps/agent/src/specialists/live.ts` (+ `live.test.ts`) — after successful MCP tool results, materialize series/table artifacts the way fixture does; harden series tool args (use `task.window`).
- **Share (preferred small util):** e.g. `apps/agent/src/specialists/artifacts.ts` (or extract from fixture) — `materializeToolArtifacts({ store, runId, task, tool, evidence })` for `series` + `rowEntity` table/queue/comparison payloads. Fixture should call the same helper to avoid drift.
- **Planner (narrow):** `apps/agent/src/planner.ts` (+ tests) — when `isBroadObjective(objective)`, **force `view: "summary"`** after capability selection (do not let finance invoices → comparison or tickets → queue).
- **Maybe compose:** `apps/agent/src/graph.ts` `toPresentation` — for broad objectives, prefer title **"Morning overview"** over `tablePayload?.title` / first finding title (belt-and-suspenders with planner fix).
- **Do not:** fixture substitution; widen into Playwright; change rubrics.

## Implementation notes

### F-A — Confirm with ≤5 probes (report before coding if anything contradicts)
Reuse `/workspace/anc-phase-e/probe.ts` harness (or thin copy). Log per probe: `plan.view`, evidence tools, **artifact kinds**, finding titles, surface title/view, chart points / table rows.

1. Morning COO × sync-regression (investigation)
2. Ops trend paraphrase (user-ops retrieve_compare)
3. Optional: finance invoice aging OR COO queue (compose artifact path)
4–5. Optional: support draft; morning quiet-day only if budget remains

Buckets: `missing_artifact` | `tool_empty` | `wrong_view` | `weak_reliability_signal` | `compose_miss` | `success`

If F-A already matches this plan’s root cause, Coder may proceed to F-B in the same session after posting bucket line — still no full eval:live.

### F-B — Fix (ordered, smallest first)

**B1 — Materialize artifacts in live (must)**  
After each successful `mcp.call` in `runLiveSpecialist` (or once at end from task evidence):
- Look up capability by tool (`CAPABILITIES` / `TOOL_CAPABILITIES`).
- If `def.series`: build points from `evidence.result.points` (≥2) → `saveArtifact` kind `series` (same payload shape as fixture).
- If `def.rowEntity` and rows present: `saveArtifact` kind `table`/`queue`/`comparison` as fixture does (title, columns, rows, totals, rowAction).
- Thread/owner: use real `threadId`/`principalId` from runtime context if available; match how fixture’s pending IDs get rewritten — **inspect current store API** and mirror whatever production path fixture uses successfully under eval (fixture today writes `threadId: "pending"` — confirm listArtifacts still sees them for the run; if live must pass the investigation threadId, wire it through `runSpecialist`/`runLiveSpecialist` without widening scope).
- Unit tests with mock evidence envelopes → artifacts saved; no invented findings.

**B2 — Series tool actually persists evidence**  
- Prefer calling `get_service_health_series` with `window: { from: task.window.start, to: task.window.end }` (or schema-correct shape) when the model omits/breaks window.
- On tool error, keep honest failed/partial (already); log reason in unresolvedQuestions.
- Reliability system line: for trend/series tasks, call the series tool before final JSON.

**B3 — Morning view + title**  
- `sanitizePlan` / post-`viewFor`: if `isBroadObjective(objective)` → `view = "summary"`.
- Optional `toPresentation`: if `isBroadObjective(objective)`, title = `"Morning overview"` (ignore queue table title).
- Reliability morning prompt nudge: prefer `get_error_metrics` / `get_service_health` over incidents-only so surface blob contains “error”.

**B4 — Cheap draft/queue only if B1 insufficient**  
- Draft: ensure `get_customer` findings include customer `entities` so `buildDraft` runs; do not fixture-fill steps.
- Queue: table artifact from B1 should supply rows.

### F-C — Verify
```bash
cd /workspace/anc
RATE_LIMIT_PER_MINUTE=120 pnpm --filter @anc/agent test
pnpm eval
# re-run same ≤5 probes; expect ops-trend chart points ≥2 and morning title Morning overview + error_signal path healthier
# Full burn only with Chief go:
# EVAL_REPEATS=1 EVAL_MATRIX_REPEATS=1 pnpm eval:live
```
Report: probe buckets; then if authorized — strictRate, investigation x/9, user-ops/retrieve_compare, substitutedRuns.

## Done means
- [ ] Live path saves series/table artifacts from real tool evidence (shared with fixture or duplicated minimally)
- [ ] Broad morning plans compose as summary / Morning overview; sync-regression can show error language when evidence exists
- [ ] Ops-trend probe: evidence persisted + chart points ≥2 (or honest tool failure reason — not silent Incomplete with 0 points after a “successful” specialist)
- [ ] Unit tests for artifact materialization + broad view override
- [ ] Fixture eval still 93/93; substitutedRuns === 0 on any live run
- [ ] Investigation and/or ops retrieve_compare lift measured; ≥0.9 may need another pass — report truthfully

## Risks
- Artifact `threadId`/`ownerId` wiring wrong → artifacts invisible to compose (verify with probe)
- Over-forcing summary on broad asks must not break intentional queue/trend single-intent asks
- Auto-injecting tool windows could disagree with model args — prefer fill-only when missing/invalid
- Temptation to fixture-fill chart points — forbidden

## Out of scope
- Playwright Slice 4
- Rubric changes
- PR/push
- Full matrix live before probe lift + Chief go
