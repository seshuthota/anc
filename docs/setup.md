# Setup

```bash
pnpm install
pnpm db:seed
cp .env.example .env   # then fill secrets locally
```

Default `MODEL_PROVIDER=fixture` with `MODEL_EXECUTION_MODE=fixture` is deterministic and needs no API key.

To use the Explabs OpenAI-compatible API:

```
MODEL_PROVIDER=explabs
MODEL_EXECUTION_MODE=live-strict
EXPLABS_API_KEY=...
EXPLABS_BASE_URL=https://api.experientiallabs.ai/v1
EXPLABS_MODEL=gpt-oss-120b
```

`live-strict` never substitutes deterministic specialist answers. Set `MODEL_EXECUTION_MODE=live-fallback` only when you explicitly want that recovery path; substitutions are recorded on the run and shown in developer details.

Commands:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Web :3000 and agent :4100 |
| `pnpm db:seed` | Recreate company SQLite (`SCENARIO=quiet-day` optional) |
| `pnpm investigate -- "What should I care about this morning?"` | CLI investigation |
| `pnpm replay` | Restore last accepted surface |
| `pnpm test` | Deterministic unit/integration tests including the 27-run opening-query rubric and HTTP investigate |
| `pnpm test:e2e` | Fixture-backed Playwright smoke (progress, cancel, refresh) |
| `pnpm eval` | Same 27-run fixture evaluation with latency JSON |
| `pnpm eval:live` | Live-strict rubric (`EVAL_REPEATS` default 3; needs Explabs key). Failed live findings are not replaced. |
| `pnpm eval:live-fallback` | Same rubric with explicit live-fallback; report `substitutedRuns` separately from `strictRate`. |
| `pnpm backup` | Snapshot the runtime and company databases into `data/backups/` |

The workspace page streams `POST /runtime/investigate` as SSE. CopilotKit at `/api/copilotkit` is an optional unused bridge, not the shell transport.

Demo identities: Casey Nguyen (COO), Alex Rivera (operations), Priya Shah (finance), Sam Okonkwo (support). The switcher is labeled “Demo identity” and is active only while `AUTH_MODE=demo` (the default while `DEMO_MODE` is not `false`). Requests send `x-anc-principal`. Switching identities clears local evidence and loads that person's session.

Real sign-in uses OpenID Connect. Set `AUTH_MODE=oidc` plus `SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SUBJECT_MAP`, `ALLOWED_ORIGINS`, and `AUDIT_ACCESS_TOKEN`. The browser then uses Sign in. The web app keeps an httpOnly session cookie and the agent accepts only a short-lived hop from that app, not a principal chosen in the browser. The agent process exits on startup if any of those values are missing.

`pnpm backup` writes consistent snapshots of the runtime and company databases under `data/backups/`. Restore by stopping the app and replacing the live file with the snapshot. `POST /runtime/retention` with the audit token erases one person (`principalId`) or drops rows older than `cutoff` / `RETENTION_DAYS`. Revoking a grant hides saved views that needed it.

Cost on `/health` is `unknown` until `MODEL_USD_PER_MILLION` is a positive number. An external read or note write stays disabled until its URL, token, principal list, and, for writes, host allowlist are set. Those secrets are not returned to the browser.

New capabilities added without new screens: invoice aging (`list_invoice_aging`) and support ticket assignment (prepare/commit). `pnpm db:seed` resets company data including overdue invoices and unassigned tickets.

Known limits: live-strict quality is reported separately from fallback-assisted completion; keyboard/a11y is basic; CopilotKit A2UI is mounted through the workspace adapter in `apps/web/lib/a2ui.tsx`.
