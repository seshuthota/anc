# Setup

```bash
pnpm install
pnpm logistics:seed
cp .env.example .env   # then fill secrets locally
```

`better-sqlite3` needs a local native build toolchain (`make` and `g++` on Linux).

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
| `pnpm logistics:seed` | Recreate logistics SQLite (`hub-fault` default; pass `quiet-day` for the control scenario) |
| `pnpm investigate -- "What should I care about this morning?"` | CLI investigation |
| `pnpm replay` | Restore last accepted surface |
| `pnpm test` | Deterministic unit/integration tests |
| `pnpm test:e2e` | Fixture-backed Playwright suite (needs Google Chrome; ports 4110/3010 by default, move them with `E2E_AGENT_PORT` / `E2E_WEB_PORT`) |
| `pnpm eval:briefing` | Morning-briefing eval: 2 scenarios × 5 personas, R1–R4 checks and an action round-trip. Fixture mode by default (deterministic, no model key); exits 1 on any failed check and writes `test-results/eval-briefing.json` |
| `pnpm backup` | Snapshot the runtime and company databases into `data/backups/` |

`pnpm eval:briefing` runs against its own freshly seeded (schema v2) `hub-fault` and `quiet-day` databases in a temporary directory, so it never touches `data/`. Live mode is report-only: `MODEL_PROVIDER=explabs MODEL_EXECUTION_MODE=live-strict EVAL_REPEATS=5 pnpm eval:briefing` (needs a model key; prints a pass rate and always exits 0). `EVAL_REPORT=<path>` moves the JSON report. CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, the fixture eval, the composer DB-isolation grep and the Playwright suite.

The workspace page streams `POST /runtime/investigate` as SSE. CopilotKit at `/api/copilotkit` is an optional unused bridge, not the shell transport.

Demo identities: Ananya Reddy (COO), Ravi Teja Kondapalli (Hyderabad hub), Meenakshi Subramanian (last-mile), Arjun Mehta (accounts), Farah Siddiqui (care). The switcher is labeled “Demo identity” and is active only while `AUTH_MODE=demo` (the default while `DEMO_MODE` is not `false`). Requests send `x-anc-principal`. Switching identities clears local evidence and loads that person's session.

Real sign-in uses OpenID Connect. Set `AUTH_MODE=oidc` plus `SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SUBJECT_MAP`, `ALLOWED_ORIGINS`, and `AUDIT_ACCESS_TOKEN`. The browser then uses Sign in. The web app keeps an httpOnly session cookie and the agent accepts only a short-lived hop from that app, not a principal chosen in the browser. The agent process exits on startup if any of those values are missing.

`pnpm backup` writes consistent snapshots of the runtime and company databases under `data/backups/`. Restore by stopping the app and replacing the live file with the snapshot. `POST /runtime/retention` with the audit token erases one person (`principalId`) or drops rows older than `cutoff` / `RETENTION_DAYS`. Revoking a grant hides saved views that needed it.

Cost on `/health` is `unknown` until `MODEL_USD_PER_MILLION` is a positive number. An external read or note write stays disabled until its URL, token, principal list, and, for writes, host allowlist are set. Those secrets are not returned to the browser.

Same-shell tasks with no dedicated route: "What should I care about this morning?", hub and at-risk parcel questions, locker pressure, shipper commitment checks, complaint assignment through the generated confirmation, and requests a persona is not granted, which return a limitation rather than an adjacent answer.

Known limits: live-strict quality has not been rerun on the parcel scenario; keyboard/a11y is basic; CopilotKit A2UI is mounted through the workspace adapter in `apps/web/lib/a2ui.tsx` with workspace extensions (`Table`, `EditField`, `SelectOption`, `Chart`, `Stat`, `Sequence`). Catalog id is `WORKSPACE_CATALOG_ID` from `packages/contracts/src/catalog.ts`.

Pre-parcel wording for this document is preserved in [archive/pre-parcel-setup-2026-10-08.md](archive/pre-parcel-setup-2026-10-08.md).
