"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { A2UIProvider, A2UIRenderer, useA2UI, type A2UIClientEventMessage } from "@copilotkit/a2ui-renderer";
import { ClientStateContext, workspaceCatalog, type ClientState } from "./catalog";

export type A2UIMessage = {
  version?: string;
  createSurface?: { surfaceId: string; catalogId: string };
  updateComponents?: { surfaceId: string; components: Array<Record<string, unknown>> };
  updateDataModel?: { surfaceId: string; path?: string; value?: unknown };
  deleteSurface?: { surfaceId: string };
};

export type WorkspaceAction = {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  context: Record<string, unknown>;
};

/** Feeds the agent's A2UI messages to the standard renderer's message processor. */
function Surface({ messages }: { messages: A2UIMessage[] }) {
  const { processMessages, clearSurfaces } = useA2UI();
  const [surfaceId, setSurfaceId] = useState<string | null>(null);
  useEffect(() => {
    clearSurfaces();
    processMessages(messages as Array<Record<string, unknown>>);
    const created = messages.find((message) => message.createSurface)?.createSurface?.surfaceId;
    setSurfaceId(created ?? null);
  }, [messages, processMessages, clearSurfaces]);
  if (!surfaceId) return <p className="muted">The workspace is waiting for a generated surface.</p>;
  return <A2UIRenderer surfaceId={surfaceId} className="a2ui-root" />;
}

/**
 * Mounts an agent-authored A2UI v0.9 surface with the standard renderer
 * (`@copilotkit/a2ui-renderer`) and turns its user actions into workspace
 * actions. Nothing here knows about a specific business view.
 */
export function A2UIWorkspace({ messages, onAction }: { messages: A2UIMessage[]; onAction: (action: WorkspaceAction) => void }) {
  const state = useRef<ClientState>({ fields: {}, selections: {} });
  const client = useMemo(() => ({ state, touch: () => undefined }), []);
  // A new surface starts with no local edits.
  useEffect(() => { state.current = { fields: {}, selections: {} }; }, [messages]);

  const handle = (message: A2UIClientEventMessage) => {
    const action = message.userAction;
    if (!action) return;
    const context = { ...(action.context ?? {}) };
    // Edits and ticks live in the browser until an action carries them back.
    if (action.name === "save_draft" || action.name === "set_selection") {
      context.clientFields = { ...state.current.fields };
      context.clientSelections = { ...state.current.selections };
    }
    onAction({ name: action.name, surfaceId: action.surfaceId, sourceComponentId: action.sourceComponentId ?? "", context });
  };

  return (
    <ClientStateContext.Provider value={client}>
      <A2UIProvider catalog={workspaceCatalog} onAction={handle}>
        <Surface messages={messages} />
      </A2UIProvider>
    </ClientStateContext.Provider>
  );
}
