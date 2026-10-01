# Plan: Live-quality Phase D (specialists + weak matrix cells)

Baseline (Tester Phase C): **strictRate 0.44 (33/75)**, substitutedRuns **0**, investigation **0/9**, matrix 33/66. Prior Phase B fixed planner `json_object` mangling (0.36→0.44). Still far from ≥0.9.

Weak cells to attack (Chief): investigation 0/9; **ops/coo retrieve_compare**; **support prepare_execute**. Leave finance prepare_execute / stronger followups alone unless they regress.

## Goal
Diagnose then fix the dominant post-planner hole so morning investigation and the named matrix cells move without fixture substitution. One spend-conscious `eval:live` after green fixture tests.

## Constraints
- No fixture builders / no live→fixture specialist swap under live-strict.
- No Slice 4 / panel-footer / push unless Chief asks.
- Do not loosen rubrics.
- Spend-conscious Explabs (diagnose ≤~12 probes before full 75).

## Likely root cause (confirm in Phase D-A)
`apps/agent/src/specialists/live.ts`:
- Tool loop does **not** use `json_object` (good), but **`repairOnce` still sets `response_format: json_object`** (line ~113) — same Explabs/`gpt-oss` `{"final{":…}` failure mode as the old planner.
- `parseResult` uses a naive `/\{[\s\S]*\}/` match; broken wrappers yield empty `findings` → live-strict throws “no validated findings” or partial empty surfaces.
- Investigation 0/9 + ops trend align with **specialist_empty**; support prepare_execute may be specialist and/or draft composition (assumptions/steps missing).

## Files to touch
- **Primary:** `apps/agent/src/specialists/live.ts` (+ specialist tests under `apps/agent/src/specialists/`)
- **Maybe share:** extract `extractPlanObject`-style JSON unwrap to a small shared helper used by planner + specialists (or duplicate minimally in live.ts to keep diff small)
- **Only if compose_miss proven:** draft/presentation path (`composer` / views / draft builder) — not speculative
- **Do not:** reintroduce fixture substitution; widen into Playwright

## Implementation notes

### D-A — Diagnose (≤~12 probes; report buckets before coding)
Probes only:
1. Morning COO × sync-regression (1) — log specialist statuses / finding counts / parse errors
2. Ops trend paraphrase (1)
3. COO queue paraphrase (1)
4. Support draft `customer-001` (1)
5. Support assign paraphrase (1)
Optional: one more morning quiet-day if budget remains

Classify: `specialist_empty` | `specialist_throw` | `parse_fail` | `compose_miss` | `planner_regress` | `success`

Artifact: append under `/workspace/anc-phase-a/` or `/workspace/anc-phase-d/phase-d-report.json`

### D-B — Fix dominant bucket only
If **parse_fail / specialist_empty** (expected):
1. Drop `response_format: json_object` from `repairOnce` (and any other specialist finalize call if found).
2. Harden `parseResult` with the same unwrap rules as planner `extractPlanObject` (final{ keys, fences, nested JSON string).
3. Unit tests: mangled `{"final{": "{...}"}` and fenced JSON → validated findings shape; repair path does not request json_object.
4. Keep one repair attempt; on persistent empty findings return honest `failed`/`partial` (no fixture).

If **compose_miss** on support draft/assign only after specialists return evidence: fix draft assumptions/steps mapping only.

If **planner_regress**: stop and ping Chief (Phase B should not regress).

### D-C — Verify
```bash
cd /workspace/anc
RATE_LIMIT_PER_MINUTE=120 pnpm --filter @anc/agent test
pnpm eval
# one burn only unless Chief authorizes more:
EVAL_REPEATS=1 EVAL_MATRIX_REPEATS=1 pnpm eval:live
```
Report: strictRate, investigation passed/total, matrixByCell for ops/coo retrieve_compare + support prepare_execute, substitutedRuns.

## Done means
- [ ] D-A bucket counts posted in Shipping before D-B code
- [ ] Specialist JSON path no longer depends on Explabs `json_object` mangling
- [ ] Unit coverage for unwrap/repair
- [ ] Fixture eval still 93/93
- [ ] substitutedRuns === 0 on live
- [ ] Investigation off 0/9 and/or clear measured lift on the named matrix cells; full ≥0.9 may need a later pass — report truthfully

## Risks
- Tool-calling + free-form JSON still flaky without json_object — unwrap must be robust
- Sharing unwrap helper vs copy-paste: prefer small shared util to avoid drift
- Morning cost = N specialists × tokens — keep probe budget tight
- Temptation to fixture-fill empty findings — forbidden

## Out of scope
- Playwright Slice 4
- Rubric changes
- PR/push
