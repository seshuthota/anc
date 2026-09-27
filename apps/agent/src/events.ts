export type AgentEvent = {
  type: string;
  threadId: string;
  runId: string;
  timestamp: string;
  [key: string]: unknown;
};

const buffers = new Map<string, AgentEvent[]>();
const listeners = new Map<string, Set<(event: AgentEvent) => void>>();

export function publishEvent(event: AgentEvent) {
  const list = buffers.get(event.runId) ?? [];
  list.push(event);
  if (list.length > 400) list.shift();
  buffers.set(event.runId, list);
  for (const listener of listeners.get(event.runId) ?? []) listener(event);
}

export function listEvents(runId: string): AgentEvent[] {
  return [...(buffers.get(runId) ?? [])];
}

export function subscribeRun(runId: string, listener: (event: AgentEvent) => void): () => void {
  const set = listeners.get(runId) ?? new Set<(event: AgentEvent) => void>();
  set.add(listener);
  listeners.set(runId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(runId);
  };
}
