# Plan: anc live planner quality → thin shell → coercion → Playwright

Repo: https://github.com/seshuthota/anc @ SHA 1935bfe (+ local dirty tree)
Checkout: `/workspace/anc` (detached HEAD)

## Goal
Ship ordered improvements so DemoCo’s shared default shell stays sparse, while live-strict planning can answer morning / retrieve_compare / prepare_execute cells without fixture substitution.

Success bar for slice 1: `EVAL_REPEATS=1 EVAL_MATRIX_REPEATS=1 pnpm eval:live` → move toward **≥0.9 `strictRate`** (today ~27/75 overall; investigation 0/9; matrix ~27/66; `substitutedRuns` must stay 0).

## Product constraints
- One shared default shell; pixels must be earned by ask + grants + evidence.
- No decorative / always-on panels that are not earned.
- Do not redesign security grants; do not widen into new product surfaces.
- Live-strict must not silently fall back to fixtures (`MODEL_EXECUTION_MODE=live-strict`).

## Observed root causes (from read-only explore)
1. **Live path bypasses fixture policy rails.** `proposePlan` only calls `fixturePlan` when `mode === "fixture"`. Live goes straight to `livePlan` → `sanitizePlan`. Fixture’s `deniedRequest` / write-unsupported / grant-scoring / `draftRequest` / `trendRequest` / `BROAD`→`coreTasks` never run in live-strict.
2. **Thin planner prompt.** System prompt omits `trend` from the view enum, has no few-shots for morning / invoice comparison / queue / draft, and only receives **authorized** capabilities in `planRequest` (so the model cannot reason about “best match exists but not granted” the way fixture scoring does).
3. **Empty/wrong live JSON → fake denial.** `sanitizePlan` strips unknown/ungranted/write caps; empty tasks without `unsupported` become “You are not authorized…”. Coercion of boolean `unsupported`/`clarification` is already fixed locally but uncommitted.
4. **Shell chrome.** `apps/web/app/page.tsx` always renders topbar + activity aside (seed “Ask a question…”) + empty workspace heading even with no surface — conflicts with “earned pixels.”
5. **Playwright** is smoke-only (`apps/web/e2e/smoke.spec.ts`); expand only after live path is less broken.

Local uncommitted (slice 3 already drafted):
- `apps/agent/src/planner.ts` — `optionalPlanText` coercion
- `apps/agent/src/planner.test.ts` — boolean unsupported test
- `packages/runtime-storage/src/index.ts` — `String(input.message)` harden

---

## Slice 1 — Live planner quality (FIRST)

### Files to touch
- **Modify:** `apps/agent/src/planner.ts` (primary)
- **Modify:** `apps/agent/src/planner.test.ts`
- **Maybe modify:** `apps/agent/src/provider.ts` only if model/json config needs tightening (prefer leave alone)
- **Do not change:** eval rubrics to “make green”; fix product path instead
- **Docs optional:** `docs/evaluation-results.md` after a real live run (Coder or Chief can defer)

### Implementation notes
**A. Deterministic policy gates before live (recommended — needs Chief confirm)**  
Before `livePlan`, apply the same **policy** helpers already used by fixture (not answer synthesis):
- `UNSUPPORTED_WRITE` / payment-execution denials
- grant denial when best catalog match is not authorized (`deniedRequest` / whole-catalog scoring)
- write-intent without write grant
These return explicit limitations. They are **not** fixture substitution of findings (`source` can stay `"live"` or a new `"policy"` label if desired; never invent specialist evidence).

**B. Strengthen `livePlan` prompt + request payload**
- Extend system prompt: views include `trend`; require capability ids **exactly** from the provided list; prefer parallel core read domains for broad morning/`BROAD` paraphrases; map invoice aging → finance invoices + `comparison`; queue → tickets read + `queue`; draft checklist → customer/ticket read + `form` + draft intent; never schedule write/commit tools.
- Add 3–5 compact few-shot JSON examples covering morning COO, ops trend, finance invoices, support queue, draft for `customer-001`.
- Enrich `planRequest`: include `catalogDeniedHints` or full catalog ids with `granted: boolean` so the model can emit honest unsupported (mirrors fixture whole-catalog scoring). Keep trust boundary: model still cannot invent tools.

**C. Safer post-parse**
- Keep `optionalPlanText` coercion (slice 3).
- After `sanitizePlan`, if live returned empty tasks but objective matches a **known productive** pattern (BROAD / trend / draft / invoice / queue) **and** grants exist, either (1) one repair re-prompt with the sanitize failure reason, or (2) apply the matching fixture *task scheduler* only (tasks + view), still `source: "live"` only if Chief approves hybrid; prefer repair re-prompt first to avoid shadow-fixture.
- Ensure `view` is reconciled with scheduled capabilities via existing `viewFor` when model view disagrees but tasks are valid.

**D. Tests**
- Unit: coercion (already), policy-before-live denials under `live-strict` with mock model never called / or called only after gate.
- Unit: mock live JSON for morning schedules ≥2 core domains; trend→`cap.service.trend`; draft→form tasks; invoice→finance caps.
- Unit: live empty `{}` does not become a misleading auth denial when grants exist (clarification or repair path).
- Keep fixture suite green: `pnpm --filter @anc/agent test`, `pnpm eval` still 27/27 + 66/66.

### Verification commands
```bash
cd /workspace/anc
pnpm --filter @anc/agent test
pnpm eval   # fixture path must stay 27/27 investigation + 66/66 matrix
EVAL_REPEATS=1 EVAL_MATRIX_REPEATS=1 pnpm eval:live
# Inspect printed strictRate / substitutedRuns; target strictRate ≥ 0.9, substitutedRuns === 0
```

### Done means (slice 1)
- [ ] Live-strict morning paraphrases produce a surface with multi-specialist activity (investigation checks can pass)
- [ ] retrieve_compare answer cells (trend/comparison/queue/morning) mostly pass under live-strict
- [ ] prepare_execute draft cells produce form/draft; payment cells still denied
- [ ] Denial cells still pass (no grant leaks)
- [ ] `substitutedRuns === 0`
- [ ] Fixture eval unchanged green

### Risks (slice 1)
- Prompt-only fixes may be flaky across Explabs models → prefer policy gates + tests
- Hybrid “use fixture task builder in live” can be mistaken for substitution — label clearly; never inject fixture findings
- Exposing full catalog to the model increases prompt size/cost
- Re-prompt increases latency/tokens on hard cells

---

## Slice 2 — Thin default shell / A2UI composition

### Files to touch
- **Modify:** `apps/web/app/page.tsx`, `apps/web/app/globals.css` (as needed)
- **Modify:** `apps/agent/src/composer.ts` only if always-on header/subtitle/findings chrome is emitted with empty presentation
- **Maybe:** `apps/web/lib/a2ui.tsx` if empty components still paint boxes

### Implementation notes
- Default shell = question input + persona switch + workspace mount. **Hide** activity aside until there is real activity (or collapse to zero height); remove seed “Ask a question to get started” row if it paints a panel.
- Do not render empty findings/metrics/table blocks (composer already gates most; audit header/subtitle-only surfaces).
- Every visible block must map to current ask, grants, or verified presentation evidence.
- No new decorative cards, side rails, or always-on “tools” chrome.

### Verification
```bash
pnpm --filter @anc/web test:e2e   # existing smoke still passes
pnpm --filter @anc/agent test     # composer/views tests if touched
```

### Done means
- [ ] Fresh load shows minimal chrome; activity panel not a permanent empty column
- [ ] After an ask, only justified A2UI blocks appear
- [ ] Smoke e2e still passes

### Risks
- Hiding activity too aggressively hurts cancel/progress UX — keep Cancel/progress when a run is active
- Persona switcher is identity, not decoration — keep it

---

## Slice 3 — Land coercion + SQLite message harden

### Files to touch
- **Modify:** `apps/agent/src/planner.ts`, `apps/agent/src/planner.test.ts`, `packages/runtime-storage/src/index.ts` (already dirty locally)
- Branch: create from 1935bfe (e.g. `fix/live-planner-coercion`) and commit these first or with slice 1

### Implementation notes
- Ship `optionalPlanText` for `unsupported` / `clarification`
- Ship test “coerces boolean unsupported…”
- Ship `message: String(input.message)` in runtime-storage insert
- Do not expand scope

### Verification
```bash
pnpm --filter @anc/agent test
pnpm --filter @anc/runtime-storage test  # if package has tests
git diff --stat   # only intended files
```

### Done means
- [ ] Coercion test green; boolean live JSON cannot crash/mis-type plan fields
- [ ] Changes committed on working branch (Chief decides push/PR)

---

## Slice 4 — Expand Playwright (AFTER live less broken)

### Files to touch
- **Create/Modify:** `apps/web/e2e/*.spec.ts` (table, draft, selection, assign)
- **Maybe:** `apps/web/playwright.config.ts` timeouts only if needed

### Implementation notes
- Cover: table view after retrieve; draft form edit/save; selection/set_selection; assign prepare→commit for support persona
- Use fixture mode for deterministic e2e unless Chief wants a separate live e2e lane
- Do not invent product routes; drive the shared shell

### Verification
```bash
pnpm test:e2e
```

### Done means
- [ ] New e2e specs green in CI/local
- [ ] Smoke still green

### Risks
- Flakes if pointed at live-strict; prefer `MODEL_EXECUTION_MODE=fixture` for e2e

---

## Suggested ship order for Coder
1. Slice 3 (tiny, unblocks live JSON) → commit
2. Slice 1 (live quality) → `pnpm eval` + `pnpm eval:live`
3. Slice 2 (thin shell)
4. Slice 4 (Playwright)

## Out of scope
- Opening PRs / pushing unless Chief asks
- Changing grant tables for convenience
- Fixture substitution in live-strict
- Nested bots from Coder/Planner

## Chief decision needed
See Shipping question: policy-gates-before-live vs prompt-only.
