# Plan: Live-strict quality follow-up (Explabs)

Repo: `/workspace/anc` (dirty tree atop `1935bfe`). Prior Slice 1+3 shipped rails/prompt/repair; last `eval:live` was **strictRate 0.36 (27/75)**, investigation **0/9**, matrix **27/66**, `substitutedRuns` 0.

## Goal
Raise live-strict quality toward **≥0.9 strictRate** without fixture substitution. Prefer diagnosis → targeted fix → one spend-conscious full re-run. Playwright (Slice 4) stays blocked until Chief says otherwise. Drop `.panel-footer` nit from this work.

## Constraints (from Chief)
- Policy gates before live = OK (already shipped).
- **No** silent fixture `coreTasks` / draft+trend builders under live-strict.
- Honest unsupported/clarification; repair skip when `unsupported` already set (shipped).
- Spend-conscious Explabs usage.

## Hypothesis (to confirm, not assume)
Failures are likely mixed:
1. **Planner:** empty/wrong tasks or wrong `view` after sanitize → weak/clarification surface.
2. **Specialist live:** `runLiveSpecialist` returns 0 validated findings → live-strict throws → incomplete workspace (investigation rubric needs findings / specialist overlap).
3. **Composition/scoring:** plan OK but presentation missing chart/rows/draft assumptions → matrix cell fail.

Investigation 0/9 strongly suggests (2) and/or (1) on morning path, not denial cells (those mostly held at 27/66).

## Files likely to touch (after diagnosis)
- **Modify as needed:** `apps/agent/src/planner.ts` (+ `planner.test.ts`) — prompt/repair/hints only; no fixture task injection.
- **Modify as needed:** `apps/agent/src/specialists/live.ts` (+ tests) — validation/repair of live specialist JSON; empty-findings handling that stays honest (failed/partial), never fixture swap in live-strict.
- **Maybe:** `apps/agent/src/eval/suite.ts` + `apps/agent/src/cli.ts` — add spend knobs (`EVAL_MATRIX=0` / family filter) **only if** missing; keep rubrics intact.
- **Do not:** loosen `scoreInvestigation` / `scoreCase` to pass; do not enable live-fallback in the measured run.

## Implementation notes (ordered)

### Phase A — Diagnose (cheap; do this first)
1. Capture last failure shape: from Coder’s prior `eval:live` JSON if saved; else run **targeted** probes (not full 75):
   - One morning ask × one scenario via `pnpm investigate` / CLI under `MODEL_EXECUTION_MODE=live-strict`, log plan tasks + activity + surface title/`dataModel.view`.
   - One cell each: ops trend, finance invoices, support queue, COO draft `customer-001`.
2. Classify each probe: `planner_empty` | `planner_wrong_view` | `specialist_empty` | `specialist_throw` | `compose_miss` | `rubric_other`.
3. Optional harness (small): wire `runEvalSuite({ matrix: false })` or `EVAL_SUITE=investigation` so investigation-only live is one command (9 runs at `EVAL_REPEATS=1` vs 75). Matrix family sampling only after investigation moves.

**Budget cap for Phase A:** ≤ ~15 live investigation/matrix probes total before any code change.

### Phase B — Fix by dominant bucket
- If **planner_***: tighten few-shots / repair hints for failing paraphrases; ensure example capability ids match the real registry (`cap.service.health` etc. must exist); fix domain/cap mismatches that sanitize strips to empty. Still no fixture builders.
- If **specialist_***: improve live specialist prompt/schema coercion (mirror planner `optionalPlanText` pattern), one specialist repair re-prompt on empty findings, or clearer partial failure that doesn’t blank the whole morning surface when siblings succeeded — **without** calling `runFixtureSpecialist` in live-strict.
- If **compose_miss:** fix view/presentation mapping only for evidence already present.
- Always add unit tests with mocked model JSON covering the fixed failure mode.

### Phase C — Verify
1. `RATE_LIMIT_PER_MINUTE=120 pnpm --filter @anc/agent test`
2. `pnpm eval` (fixture must stay 27/27 + 66/66)
3. Spend-conscious live:
   - First: investigation-only if harness exists: `EVAL_REPEATS=1` live investigation.
   - Then **one** full: `EVAL_REPEATS=1 EVAL_MATRIX_REPEATS=1 pnpm eval:live`
4. Stop further Explabs loops unless strictRate improved and Chief authorizes another pass. Target: move investigation off 0/9 and lift overall toward ≥0.9; report `failedRows` + `matrixByCell` even if below bar.

## Verification commands
```bash
cd /workspace/anc
RATE_LIMIT_PER_MINUTE=120 pnpm --filter @anc/agent test
pnpm eval
# After targeted fixes — at most one full live burn unless Chief says otherwise:
EVAL_REPEATS=1 EVAL_MATRIX_REPEATS=1 pnpm eval:live
```

## Done means
- [ ] Failure classes documented from Phase A probes
- [ ] Fixes match class; zero fixture substitution under live-strict (`substitutedRuns === 0`)
- [ ] Fixture eval still fully green
- [ ] New/updated unit tests for the fixed path
- [ ] One post-fix `eval:live` logged with strictRate / investigation / matrix / failedRows
- [ ] No Slice 4 / no push unless Chief asks

## Risks
- Specialist live may dominate cost (N specialists × morning) — diagnose before widening prompts
- Prompt churn without registry-aligned capability ids wastes Explabs
- Partial specialist failure UX must not look like a successful quiet day
- Temptation to re-enable fixture builders — forbidden

## Out of scope
- Slice 4 Playwright
- `.panel-footer` polish
- PR/push
- Rubric softening
