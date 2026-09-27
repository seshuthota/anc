import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, ExperimentalEmptyAdapter, copilotRuntimeNextJSAppRouterEndpoint } from "@copilotkit/runtime";

// Optional CopilotKit bridge. The workspace page streams agent SSE directly
// from POST /runtime/investigate and does not use this route.
const agentUrl = process.env.AGENT_URL ?? "http://127.0.0.1:4100/ag-ui";

const runtime = new CopilotRuntime({
  agents: {
    // CopilotKit 1.73 bundles a different @ag-ui/client than the workspace pin.
    democo: new HttpAgent({ url: agentUrl }) as never,
  },
});

export const POST = async (req: Request) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
};
