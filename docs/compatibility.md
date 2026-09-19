# Compatibility notes

This file tracks versions proven by local smoke tests. Do not infer compatibility solely from package names or documentation.

| Area | Selected package/version | Status |
| --- | --- | --- |
| Node.js | `v24.14.0` | Available locally |
| pnpm | `10.33.0` | Available locally |
| CopilotKit runtime | Pending install | To verify in M0 |
| AG-UI transport | Pending install | To verify in M0 |
| A2UI renderer | Pending install | To verify in M0 |
| LangGraph | Pending install | To verify persistent checkpointer in M0 |
| MCP SDK | Pending install | To verify stdio client/server in M0 |
| SQLite driver | Pending install | To verify read-only connection in M0 |

## Transport decision

The initial company MCP process uses stdio and is owned by the local agent process. It accesses a deterministic SQLite file in read-only mode. The public frontend runtime is local-only during development. The browser uses the CopilotKit/AG-UI route once the M0 smoke test proves the selected packages can update a dedicated workspace surface and receive a semantic action.

## Current references

- [CopilotKit A2UI integration](https://docs.copilotkit.ai/generative-ui/a2ui)
- [AG-UI event concepts](https://docs.ag-ui.com/concepts/events)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
- [LangGraph JavaScript persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)

The current npm registry reports `@copilotkit/runtime` 1.73.0, `@langchain/langgraph` 1.4.16, and `@modelcontextprotocol/sdk` 1.30.0. Package compatibility remains unverified until the first installed smoke test.
