import { deploymentProblems } from "@anc/policy";
import { createAgentServer } from "./server.js";

const problems = deploymentProblems();
if (problems.length) {
  console.error(`Refusing to start. OpenID sessions are missing: ${problems.join(", ")}`);
  process.exit(1);
}

const port = Number(process.env.AGENT_PORT ?? 4100);
const host = process.env.AGENT_HOST ?? "127.0.0.1";

const server = createAgentServer();
server.listen(port, host, () => {
  console.log(`DemoCo agent runtime listening on http://${host}:${port}`);
});
