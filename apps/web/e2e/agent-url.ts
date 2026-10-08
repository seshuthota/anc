/** The agent runtime's URL for direct API calls, from playwright.config.ts (E2E_AGENT_PORT). */
export function agentUrl(path: string): string {
  const base = process.env.E2E_AGENT_URL;
  if (!base) throw new Error("E2E_AGENT_URL is not set; run the specs through playwright.config.ts");
  return `${base}${path}`;
}
