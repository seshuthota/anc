# Plan: Live-quality Phase E (investigation empty-findings root cause)

## Baseline
- Tester **D-C**: fixture green (93/93, substitutedRuns 0); live **strictRate 0.44 (33/75)**, investigation **0/9**, matrix 33/66 (0.5), substitutedRuns **0**. Same weak cells as Phase C: ops/coo `retrieve_compare` 0, support `prepare_execute` 0.
- Phase **D-B** (drop specialist `json_object` + shared unwrap) did **not** move live scores.
- Chief: pause full-matrix Explabs burns; diagnose from artifacts + ≤5 probes only if needed.

## Goal
For investigation **0/9**, decide whether empty surfaces come from **Zod/schema**, **evidence validation**, **empty/wrong tool use**, or **compose/rubric** — then fix the dominant bucket only. One spend-conscious live check after green units/fixture (investigation-focused first; full 75 only if Chief authorizes).

## Artifact read (no new matrix spend)

Sources: `/workspace/anc-phase-d/phase-d-report.json`, `/tmp/anc-phase-d-S8yPkb/runtime.sqlite` (D-A probes), D-C score line from Tester. D-C eval dirs under `/tmp/anc-eval-*` hold **seed** sqlite only (no per-run specialist transcripts).

| Observation | Implication |
|---|---|
| `findings` table **0** rows; surfaces titled Incomplete answer | Compose/rubric never sees findings — **not** the primary hole |
| **9** evidence rows across probes; **8/10** tasks had ≥1 tool success | Tools are **not** globally empty |
| Tasks still `failed` / “no validated findings” | Failure is **after** tools: parse/schema, validateFinding drop, or model returned `findings: []` |
| ops-trend reliability: **0** evidence | Separate **tool_empty / tool-miss** lane (series tool not called or failed) |
| Morning reliability often called `list_open_incidents` not `get_error_metrics` / health | Wrong-tool / weak finalize even when evidence exists |
| D-B unwrap → still 0.44 | Dominant hole is **not** Explabs `final{` alone |

**Open fork (artifacts cannot finish):** among tasks with evidence, is it `schema_fail` vs `validation_reject` vs `empty_findings_json`? D-A collapsed these into `specialist_empty` because `specialists/index.ts` rethrows and live silently drops Zod/validate failures.

**Strong code hypothesis (confirm in E-A):** `parseResult` runs full `AgentFindingSchema` **before** injecting `taskId`/`agentId`/`createdAt`. Models that omit those fields fail Zod → empty `findings` → **repairOnce never runs** (repair only when `parsed.findings.length > 0` but validateFinding drops all). Same path as invented evidence IDs / numeric mismatches once schema passes.

## Constraints
- No fixture substitution under live-strict; no rubric softening; no Slice 4 / push unless Chief asks.
- ≤**5** live probes in E-A unless artifacts already suffice (they don’t for the Zod vs validate split).
- No full `eval:live` 75 until E-B green on probes + Chief go.

## Files to touch
- **Primary:** `apps/agent/src/specialists/live.ts` (+ `live.test.ts`) — coerce/normalize findings before Zod; surface reject reasons; run repair on schema_fail too; keep honest failed on empty.
- **Maybe:** `apps/agent/src/specialists/index.ts` — preserve structured failure detail instead of only “no validated findings” (helps future probes; optional).
- **Maybe if tool_empty dominant on trend:** specialist system prompt / tool descriptions; ensure planned `cap.service.trend` → model calls `get_service_health_series` (registry already maps it; `SPECIALISTS.reliability` catalog list omits trend — add if that blocks anything real).
- **Maybe if support draft still compose_miss after findings land:** draft composition path only — not speculative.
- **Probe harness (disposable):** `/workspace/anc-phase-e/probe.ts` + `phase-e-report.json` (do **not** commit unless Chief wants).
- **Do not:** reintroduce fixture specialist under live-strict; change `scoreInvestigation` / `scoreCase`.

## Implementation notes

### E-A — Instrumented diagnose (≤5 probes; report before E-B code)
Reuse D-A probe shape; add per-specialist counters (log only, no product behavior change yet — or temporary debug flags in the disposable probe that wrap/mocks parse if needed). Prefer instrumenting via a **disposable probe script** that records:

For each specialist completion attempt:
1. `evidenceCount` + tool names for the task
2. Raw final assistant content preview (first ~400 chars) + whether unwrap found a `findings` array
3. `ResultSchema` success + **zod issue paths** (or a looser draft parse count)
4. `parsedFindingsCount` vs `validatedFindingsCount`
5. `validateRejectReasons` (unknown evidence id / numeric mismatch) — sample first 3
6. `repairTriggered` boolean
7. Final bucket

**Probes (≤5):**
1. Morning COO × sync-regression (investigation) — one run is enough if all 3 specialists instrumented
2. Ops trend paraphrase (`retrieve_compare`) — tool_empty vs schema
3. Support draft `customer-001` (`prepare_execute`)
4. Optional: COO queue paraphrase
5. Optional: only if budget remains — morning quiet-day **or** support assign

**Buckets:** `schema_fail` | `validation_reject` | `empty_findings_json` | `tool_empty` | `success` | `compose_miss` (only if findings>0 but draft/rows/chart missing)

Artifact: `/workspace/anc-phase-e/phase-e-report.json`. Post bucket counts in Shipping **before** E-B.

### E-B — Fix dominant bucket only
**If `schema_fail` (expected):**
1. Parse findings with a **draft** schema (or strip/coerce): inject `taskId`, `agentId=task.domain`, `createdAt=now` before `AgentFindingSchema`.
2. Coerce common enums/strings where safe; drop individual bad findings rather than nuking the whole result when ≥1 finding validates.
3. Trigger **repairOnce** when draft had finding-shaped objects but none validated (today repair is skipped on total Zod fail).
4. Unit tests: findings missing `createdAt`/`taskId`/`agentId` still validate after coerce; invented evidence id still rejected; repair params still **no** `json_object`.

**If `validation_reject`:**
1. Repair prompt lists **allowed evidence IDs** from the task’s stored evidence.
2. Optionally: if a claim cites mixed valid+invalid IDs, keep claim with valid IDs only when ≥1 remains (do not invent numbers).
3. Tests for unknown-id rejection and allowed-id repair message content.

**If `tool_empty` (esp. ops trend):**
1. Strengthen specialist instruction to call the scheduled capability’s tool (trend → `get_service_health_series`) before final JSON.
2. Confirm planner still emits `cap.service.trend` for ops paraphrases (fixture planner tests already cover; live probe should log task.capabilities).
3. Add `cap.service.trend` to `SPECIALISTS.reliability.capabilities` if missing from catalog confuses anything — only if E-A shows it matters.

**If `empty_findings_json`:** few-shot / finalize instruction requiring ≥1 observation citing tool `evidenceId`s; still no fixture fill.

**If `compose_miss` only after findings>0:** narrow draft/view mapping fix.

Stop and ping Chief if planner_regress.

### E-C — Verify (spend ladder)
```bash
cd /workspace/anc
RATE_LIMIT_PER_MINUTE=120 pnpm --filter @anc/agent test
pnpm eval
# After E-B: re-run the same ≤5 instrumented probes (or investigation-only live if harness exists)
# Full matrix only with Chief go:
# EVAL_REPEATS=1 EVAL_MATRIX_REPEATS=1 pnpm eval:live
```
Report: probe buckets; then if authorized — strictRate, investigation x/9, matrixByCell for ops/coo retrieve_compare + support prepare_execute, substitutedRuns.

## Done means
- [ ] E-A bucket counts posted before E-B code
- [ ] Dominant bucket fixed with unit coverage; no fixture sub under live-strict
- [ ] Fixture eval still 93/93
- [ ] Investigation moves off 0/9 **or** truthful report that another bucket remains
- [ ] No full-matrix burn without Chief go after probe lift

## Risks
- Coercion too loose could publish weak findings — keep evidence-id + numeric checks mandatory
- Repair on every schema fail increases Explabs calls — keep **one** repair
- Tool-miss and schema_fail may both be real — fix schema first (cheaper), then one trend-focused probe
- Temptation to loosen rubrics or fixture-fill — forbidden

## Out of scope
- Playwright Slice 4
- Rubric changes
- PR/push
- Full 75 `eval:live` before probe-confirmed lift
