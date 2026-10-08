<!-- Archived 2026-10-08: SaaS-era DemoCo content superseded by the Indian parcel network scenario. Kept for history only. -->

# Compatibility notes

This file tracks versions proven by local smoke tests. Do not infer compatibility solely from package names or documentation.

| Area | Selected package/version | Status |
| --- | --- | --- |
| Node.js | `v24.14.0` | Available locally |
| pnpm | workspace `packageManager` `pnpm@9.15.5`; local CLI may differ | Available locally |
| CopilotKit runtime | `@copilotkit/runtime@1.73.0` | Installed. Next.js `/api/copilotkit` proxies AG-UI to the agent `/ag-ui` endpoint via `HttpAgent`. Duplicate `@ag-ui/client` types required a `as never` adapter. |
| AG-UI transport | Agent SSE on `POST /runtime/investigate` and `GET /runtime/events` | Workspace consumes these events directly (`RUN_STARTED`, `STEP_*`, `STATE_SNAPSHOT`, `CUSTOM` activity, `RUN_FINISHED`). `/ag-ui` remains for the unused CopilotKit proxy. |
| A2UI renderer | A2UI protocol **v0.9** basic catalog | Composer emits `createSurface` / `updateComponents` / `updateDataModel`. CopilotKit's chat-oriented A2UI renderer is not used as the workspace host. A workspace mounting adapter in `apps/web/lib/a2ui.tsx` renders basic-catalog primitives (Column, Row, Text, Card, Button, List) plus four documented adapter extensions: `Table` (sortable, with totals and completeness note), `TextField` (edit state held in the adapter, not the model), `Checkbox` (selection), and `Chart` (SVG time series). Catalog ID: `https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json`. |
| LangGraph | `@langchain/langgraph@1.0.1`, `@langchain/langgraph-checkpoint-sqlite` | Persistent `SqliteSaver.fromConnString(RUNTIME_DB_PATH)` compiled with the investigation graph. Restart restores checkpoints and accepted surfaces from `runtime.sqlite`. |
| MCP SDK | `@modelcontextprotocol/client` / `server` v2 | Stdio child process owned by the agent. Concurrent specialists each open a client. |
| SQLite driver | `better-sqlite3@12.4.1` | Company DB opened read-only; runtime DB writable. |
| Model adapter | Explabs OpenAI-compatible (`EXPLABS_API_KEY`, `EXPLABS_BASE_URL`, `EXPLABS_MODEL`) | Live path is `MODEL_PROVIDER=explabs` with `MODEL_EXECUTION_MODE=live-strict` by default. `live-fallback` must be set explicitly. Default demo/CI path is `MODEL_PROVIDER=fixture`. |

## Transport decision

The company MCP process uses stdio and is owned by the local agent process. It accesses a deterministic SQLite file in read-only mode. Runtime state, evidence, activity, and accepted A2UI surfaces are stored in `runtime.sqlite`. LangGraph checkpoints use the same file via `SqliteSaver`.

The public frontend is local-only. The browser streams investigation progress from the agent over SSE, and uses REST for health, saved state, evidence inspection, surface restore, and cancel. `/api/copilotkit` is not the workspace transport.

## Component and action parity

The set of component types the server validator accepts and the set the browser adapter can draw are both read from `packages/contracts/src/catalog.ts` (`A2UI_COMPONENT_TYPES`). They cannot drift: a test in `apps/agent/src/a2ui-validate.test.ts` reads the renderer source and fails if any accepted type is no longer handled. This matters because a surface that validates but renders blank replaces the last known-good workspace, which is worse than a rejected surface. Registered action names are likewise derived from `ActionNameSchema` rather than a second hardcoded list.

## Current references

- [CopilotKit A2UI integration](https://docs.copilotkit.ai/generative-ui/specs/a2ui)
- [A2UI v0.9 protocol](https://a2ui.org/specification/v0.9-a2ui/)
- [AG-UI event concepts](https://docs.ag-ui.com/concepts/events)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
- [LangGraph JavaScript persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
