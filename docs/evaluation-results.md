# Evaluation results

Updated 2026-09-20 for P0 reporting. Human usability review is still open. Live-strict evaluation was not rerun in this update.

## Deterministic fixture suite

| Suite | Result |
| --- | --- |
| `@anc/database` seed, ARR, rates, quiet-day | pass |
| `@anc/company-mcp` evidence envelopes, unknown IDs, read-only | pass |
| `@anc/runtime-storage` evidence persistence | pass |
| `@anc/agent` failure matrix (finance timeout, invalid A2UI, quiet-day, unrelated anomaly, narrow finance, unknown customer, stale/duplicate actions, allowlist/injection, timings) | pass |
| Opening-query rubric: 3 paraphrases × 3 datasets × 3 repeats = **27/27** | pass (rate 1.00) |
| Workspace typecheck | pass |
| Agent HTTP investigate / SSE progress / first-run cancel / late-result | pass |
| Playwright fixture smoke (`pnpm test:e2e`) | pass (cancel first run, progress + Morning overview, refresh restore, demo identity label) |
| Persona isolation, invoice aging, ticket assign prepare/commit | pass |
| Unseen capability (`list_open_incidents`) without planner/page branches | pass |
| Held-out prompts (overnight / receivables / support queue) | pass |

### Fixture latency (`pnpm eval`, MODEL_PROVIDER=fixture)

| Metric | Median | p95 | Target |
| --- | --- | --- | --- |
| First activity | <1 ms | 1 ms | 2 s |
| First useful finding | 840 ms | 1040 ms | 20 s |
| Completed workspace | 1499 ms | 1742 ms | 60 s |

Tokens: 0 (no model). Cost: $0.

Headline numeric claims in the regression seed match the independent SQL fixture (14 accounts, $2.1M ARR minor units `210000000`, weighted sync-v2 error rate > 5%).

## Live model (`MODEL_PROVIDER=explabs`)

Modes are now separate:

| Mode | Command | Substitution |
| --- | --- | --- |
| live-strict | `pnpm eval:live` | Never. Failed live findings stay failed. |
| live-fallback | `pnpm eval:live-fallback` | Explicit only. Counted in `substitutedRuns`, not `strictRate`. |

Historical sample (`EVAL_REPEATS=1`, 9 runs) scored **9/9 with silent fixture substitution**. A prior live-only pass scored **3/9**. That 9/9 figure is fallback-assisted completion, not live-strict ability. Re-run `pnpm eval:live` to measure live-strict; do not treat the historical 9/9 as strict.

The full 27-run live matrix was not re-executed here to limit token spend. Fixture 27/27 remains the CI gate.

## Failure matrix

| Scenario | Result |
| --- | --- |
| Sync regression | pass (fixture + live sample) |
| Quiet day | pass (no invented major incident) |
| Unrelated anomaly | pass (does not always blame sync-v2) |
| Paraphrased opening query | pass (27 fixture, 9 live) |
| Narrow finance question | pass |
| Finance timeout | pass (ops findings + ARR unavailable) |
| Unknown customer | pass (context preserved) |
| Malformed A2UI | pass (keep last surface) |
| Duplicate / stale click | pass |
| Refresh / restore | pass |
| Prompt injection in ticket body | pass (execute_sql not on allowlist) |
| Specialist overlap | pass |

## Remaining

- Real identity provider before any deployed multi-user access (P1 leftover, P7)
- Four-participant usability review (P6). Held-out automated prompts pass; unfamiliar humans have not been scheduled.
- Live-strict `pnpm eval:live` (not rerun; historical 9/9 was fallback-assisted)
- Optional: set `MODEL_USD_PER_MILLION` to record cost
