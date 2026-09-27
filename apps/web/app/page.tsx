"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { A2UIWorkspace, type A2UIMessage } from "../lib/a2ui";
import {
  activityKindLabel,
  agentUrl,
  emptyState,
  principalHeaders,
  PRINCIPAL_STORAGE_KEY,
  readSse,
  streamRequest,
  type AgentEvent,
  type PrincipalSummary,
  type PublicState,
} from "../lib/agent";

export default function HomePage() {
  const [state, setState] = useState<PublicState>(emptyState);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [principalId, setPrincipalId] = useState("user-coo");
  const [personas, setPersonas] = useState<PrincipalSummary[]>([]);
  const [authMode, setAuthMode] = useState<"demo" | "oidc">("demo");
  const [signedOut, setSignedOut] = useState(false);
  const currentRunId = useRef<string | null>(null);
  const principalRef = useRef(principalId);
  const runtimeBase = useRef(agentUrl);
  const sessionAuth = useRef(false);
  principalRef.current = principalId;

  function authHeaders(id = principalRef.current): Record<string, string> {
    return sessionAuth.current ? {} : principalHeaders(id);
  }

  function endpoint(path: string) {
    return `${runtimeBase.current}${path}`;
  }

  function applyEvent(event: AgentEvent, expectedRunId?: string) {
    const runId = event.runId ?? event.snapshot?.runId ?? event.result?.runId;
    if (expectedRunId && runId && runId !== expectedRunId) return;
    if (currentRunId.current && runId && runId !== currentRunId.current) return;
    if (event.type === "RUN_ERROR") {
      setState((current) => ({
        ...current,
        status: "failed",
        activity: [{
          id: crypto.randomUUID(),
          message: event.message ?? "This request failed.",
          kind: "status",
          timestamp: new Date().toISOString(),
        }, ...current.activity],
      }));
      return;
    }
    const next = event.result ?? event.snapshot;
    if (next) setState(next);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("dev") === "1") setDeveloperOpen(true);
    const stored = window.localStorage.getItem(PRINCIPAL_STORAGE_KEY) ?? "user-coo";
    setPrincipalId(stored);
    void (async () => {
      const session = await fetch("/api/session").catch(() => null);
      if (session?.status === 401) {
        setAuthMode("oidc");
        setSignedOut(true);
        return;
      }
      const body = session?.ok
        ? await session.json() as { authMode?: "demo" | "oidc"; principal?: PrincipalSummary }
        : { authMode: "demo" as const };
      const signedInPrincipal = body.authMode === "oidc" ? body.principal : undefined;
      const id = signedInPrincipal?.id ?? stored;
      if (signedInPrincipal) {
        sessionAuth.current = true;
        runtimeBase.current = "/api/agent";
        setAuthMode("oidc");
        setSignedOut(false);
        setPrincipalId(signedInPrincipal.id);
        setPersonas([signedInPrincipal]);
      } else {
        const personasResponse = await fetch(`${agentUrl}/runtime/principals`).catch(() => null);
        if (personasResponse?.ok) {
          const payload = await personasResponse.json() as { personas?: PrincipalSummary[] };
          setPersonas(payload.personas ?? []);
        }
      }
      const headers = signedInPrincipal ? {} : principalHeaders(id);
      const credentials: RequestCredentials = signedInPrincipal ? "include" : "same-origin";
      const response = await fetch(endpoint("/runtime/state"), { headers, credentials });
      if (!response.ok || currentRunId.current) return;
      const restored = await response.json() as PublicState;
      if (currentRunId.current) return;
      setState(restored);
      if (restored.status === "running" && restored.runId) {
        currentRunId.current = restored.runId;
        setBusy(true);
        const events = await fetch(`${endpoint("/runtime/events")}?threadId=${encodeURIComponent(restored.threadId)}&runId=${encodeURIComponent(restored.runId)}`, { headers, credentials });
        if (events.ok) await readSse(events, (event) => applyEvent(event, restored.runId ?? undefined));
        setBusy(false);
      }
    })().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!evidence) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEvidence(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [evidence]);

  const statusLabel = useMemo(() => {
    if (busy || state.status === "running") return "Working";
    if (state.status === "failed") return "Could not finish";
    if (state.status === "cancelled") return "Stopped";
    if (state.status === "partial") return "Partial answer";
    if (state.surface) return "Ready";
    return "Waiting";
  }, [busy, state.status, state.surface]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    const runId = `run-${crypto.randomUUID()}`;
    currentRunId.current = runId;
    setBusy(true);
    setQuestion("");
    setState((current) => ({
      ...current,
      runId,
      status: "running",
      activity: [{ id: crypto.randomUUID(), message: "Looking into your question", kind: "status", timestamp: new Date().toISOString() }, ...current.activity],
    }));
    try {
      await streamRequest("/runtime/investigate", { question: trimmed, threadId: state.threadId, runId, principalId }, (event) => applyEvent(event, runId), sessionAuth.current ? undefined : principalId, sessionAuth.current ? { base: runtimeBase.current, credentials: "include" } : undefined);
    } catch (error) {
      if (currentRunId.current !== runId) return;
      setState((current) => ({
        ...current,
        status: "failed",
        activity: [{ id: crypto.randomUUID(), message: error instanceof Error ? error.message : "This request failed.", kind: "status", timestamp: new Date().toISOString() }, ...current.activity],
      }));
    } finally {
      if (currentRunId.current === runId) setBusy(false);
    }
  }

  async function invoke(name: string, context: Record<string, unknown> = {}) {
    if (name === "show_evidence") {
      const evidenceId = String(context.evidenceId ?? (Array.isArray(context.evidenceIds) ? context.evidenceIds[0] : ""));
      if (!evidenceId) return;
      const response = await fetch(endpoint(`/runtime/evidence/${encodeURIComponent(evidenceId)}`), { headers: authHeaders(), credentials: sessionAuth.current ? "include" : "same-origin" });
      setEvidence(response.ok ? await response.json() as Record<string, unknown> : { error: "Evidence not found" });
      return;
    }
    const runId = `run-${crypto.randomUUID()}`;
    currentRunId.current = runId;
    setBusy(true);
    try {
      await streamRequest("/runtime/actions", {
        actionId: crypto.randomUUID(),
        runId,
        name,
        threadId: state.threadId,
        investigationId: state.investigationId,
        surfaceId: state.surface?.surfaceId,
        surfaceRevision: state.surface?.revision,
        entities: Array.isArray(context.entities) ? context.entities : context.entityId ? [{ type: context.entityType ?? "customer", id: context.entityId }] : [],
        parameters: context,
        principalId,
      }, (event) => applyEvent(event, runId), sessionAuth.current ? undefined : principalId, sessionAuth.current ? { base: runtimeBase.current, credentials: "include" } : undefined);
      const snapshot = (await fetch(`${endpoint("/runtime/state")}?threadId=${encodeURIComponent(state.threadId)}`, { headers: authHeaders(), credentials: sessionAuth.current ? "include" : "same-origin" }).then((response) => response.json()).catch(() => null)) as PublicState | null;
      if (snapshot?.evidence) setEvidence(snapshot.evidence);
    } catch (error) {
      if (currentRunId.current !== runId) return;
      setState((current) => ({
        ...current,
        activity: [{ id: crypto.randomUUID(), message: error instanceof Error ? error.message : "This action is no longer valid.", kind: "status", timestamp: new Date().toISOString() }, ...current.activity],
      }));
    } finally {
      if (currentRunId.current === runId) setBusy(false);
    }
  }

  async function restore(item: PublicState["surfaceHistory"][number]) {
    const response = await fetch(endpoint("/runtime/surfaces/restore"), {
      method: "POST",
      credentials: sessionAuth.current ? "include" : "same-origin",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ threadId: state.threadId, surfaceId: item.surfaceId, revision: item.revision }),
    });
    if (response.ok) setState(await response.json() as PublicState);
  }

  async function cancel() {
    const runId = currentRunId.current ?? state.runId;
    if (!runId) return;
    const response = await fetch(endpoint("/runtime/cancel"), {
      method: "POST",
      credentials: sessionAuth.current ? "include" : "same-origin",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ runId, threadId: state.threadId }),
    });
    if (response.ok) {
      const next = await response.json() as PublicState;
      if (!currentRunId.current || currentRunId.current === runId) setState(next);
    }
  }

  const substitutions = state.execution?.substitutions ?? [];
  const currentPersona = personas.find((item) => item.id === principalId);

  async function switchPrincipal(nextId: string) {
    window.localStorage.setItem(PRINCIPAL_STORAGE_KEY, nextId);
    setPrincipalId(nextId);
    setEvidence(null);
    currentRunId.current = null;
    setBusy(false);
    const response = await fetch(endpoint("/runtime/state"), { headers: authHeaders(nextId) });
    if (response.ok) setState(await response.json() as PublicState);
    else setState({ ...emptyState, threadId: nextId === "user-coo" ? "local-demo" : `session:${nextId}` });
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#question">Skip to question</a>
      <header className="topbar">
        <div><span className="eyebrow">DEMOCO</span><h1>Morning workspace</h1></div>
        <div className="connection">
          <span className={`status-dot ${busy || state.status === "running" ? "running" : state.status === "failed" ? "failed" : ""}`} aria-hidden="true" />
          <span aria-live="polite">{statusLabel}</span>
          <span className="divider" />
          <span>Sep 20, 2026 · 08:00 UTC</span>
          {authMode === "oidc" ? (
            signedOut
              ? <a className="ghost" href="/api/auth/login">Sign in</a>
              : <form method="post" action="/api/auth/logout"><button className="ghost" type="submit">Sign out</button></form>
          ) : (
            <label className="persona-switch">
              <span>Demo identity</span>
              <select aria-label="Demo identity (not real sign-in)" value={principalId} onChange={(event) => void switchPrincipal(event.target.value)}>
                {(personas.length ? personas : [{ id: "user-coo", displayName: "Casey Nguyen", title: "Chief Operating Officer" }]).map((item) => (
                  <option key={item.id} value={item.id}>{item.displayName}</option>
                ))}
              </select>
            </label>
          )}
          {state.surfaceHistory.length > 1 ? <button className="ghost" type="button" onClick={() => restore(state.surfaceHistory[1]!)}>Back</button> : null}
          {busy ? <button className="ghost" type="button" onClick={() => void cancel()}>Cancel</button> : null}
        </div>
      </header>
      <div className="workspace-grid">
        <section className="workspace" aria-live="polite" aria-busy={busy}>
          <div className="workspace-heading">
            <div>
              <span className="eyebrow">{state.surface ? "CURRENT VIEW" : "WORKSPACE"}</span>
              <h2>{state.surface?.title ?? "Ask what needs attention"}</h2>
              <p>Ask in your own words. This workspace stays the same; the contents change with the question.</p>
            </div>
            <span className="badge">{currentPersona?.title ?? "Demo user"}</span>
          </div>
          {busy ? (
            <div className="progress-banner" role="status">
              <span>Working on your question…</span>
              <button className="ghost" type="button" onClick={() => void cancel()}>Cancel</button>
            </div>
          ) : null}
          {signedOut ? <p className="muted">Sign in to use the workspace.</p> : state.surface ? (
            <A2UIWorkspace
              messages={state.surface.messages as A2UIMessage[]}
              onAction={(action) => void invoke(action.name, action.context)}
            />
          ) : <p className="muted">No saved view yet. Try: What should I care about this morning?</p>}
          {signedOut ? null : <form className="question-form" onSubmit={submit} id="question">
            <span className="spark" aria-hidden="true">✦</span>
            <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask anything about the company…" aria-label="Workspace question" />
            <button type="submit" disabled={busy}>{busy ? "Working…" : "Ask"}</button>
          </form>}
        </section>
        <aside className="activity-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">PROGRESS</span><h2>Activity</h2></div>
            <span className="live-pill"><span className={`status-dot ${busy || state.status === "running" ? "running" : ""}`} /> {statusLabel}</span>
          </div>
          <div className="timeline">
            {(state.activity.length ? state.activity : [{ id: "seed", message: "Ask a question to get started", kind: "status", timestamp: new Date().toISOString() }]).map((item) => (
              <div className="timeline-item" key={item.id}>
                <span className="timeline-dot" />
                <div><p>{item.message}</p><small>{activityKindLabel(item.kind)}</small></div>
              </div>
            ))}
          </div>
          <div className="panel-footer">
            <span className="eyebrow">PREVIOUS VIEWS</span>
            {state.surfaceHistory.map((item) => (
              <button key={`${item.surfaceId}-${item.revision}`} className="ghost history" type="button" onClick={() => void restore(item)}>
                {item.title}
              </button>
            ))}
            {!state.surfaceHistory.length ? <p className="muted">No previous views yet.</p> : null}
            <details className="dev-details" open={developerOpen} onToggle={(event) => setDeveloperOpen(event.currentTarget.open)}>
              <summary>Developer details</summary>
              <p>Run {state.runId ?? "none"}</p>
              <p>Investigation {state.investigationId ?? "none"}</p>
              <p>Revision {state.surface?.revision ?? "—"}</p>
              <p>Provider {state.execution?.provider ?? "unknown"} · {state.execution?.executionMode ?? "fixture"}</p>
              <p>Cost {state.usage?.costStatus === "known" && state.usage.estimatedCostUsd !== null ? `$${state.usage.estimatedCostUsd}` : "unknown"}</p>
              <p>Transport agent SSE (`/runtime/investigate`)</p>
              {substitutions.length ? substitutions.map((item) => (
                <p key={`${item.specialist}-${item.reason}`}>Substituted {item.specialist}: {item.reason}</p>
              )) : <p>No specialist substitutions</p>}
            </details>
          </div>
        </aside>
      </div>
      {evidence ? (
        <div className="drawer" role="dialog" aria-modal="true" aria-label="Supporting evidence">
          <div className="drawer-card">
            <div className="workspace-heading">
              <div><span className="eyebrow">SUPPORTING SOURCE</span><h2>{String(evidence.tool ?? "Saved evidence")}</h2></div>
              <button className="ghost" type="button" autoFocus onClick={() => setEvidence(null)}>Close</button>
            </div>
            <p className="muted">{String(evidence.evidenceId ?? "")}</p>
            <pre>{JSON.stringify(evidence, null, 2)}</pre>
          </div>
        </div>
      ) : null}
    </main>
  );
}
