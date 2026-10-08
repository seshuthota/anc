"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { A2UIWorkspace, type A2UIMessage } from "../lib/a2ui";
import { EvidenceDrawer, type EvidenceDrawerState, type EvidenceExplanation, type EvidenceItem } from "../lib/EvidenceDrawer";
import { ActivityPill } from "../lib/ActivityPill";
import { ACTION_FAILED, REQUEST_FAILED } from "../lib/activity-text";
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

const RUN_START = "Looking into your question";
/** Asked on the person's behalf when they open the workspace, so they start from what needs attention. */
const BRIEFING = "Brief me: what needs my attention this morning?";
/**
 * A failed request or action, in fixed wording. The raw error (an exception
 * message, a validation error) is only appended for developers (?dev=1).
 */
function failureLine(fixed: string, raw: unknown): string {
  const detail = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  const developer = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dev") === "1";
  return developer && detail ? `${fixed} (${detail})` : fixed;
}
const briefedKey = (id: string) => `democo-briefed:${id}`;

export default function HomePage() {
  const [state, setState] = useState<PublicState>(emptyState);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceDrawerState | null>(null);
  // Run details are for developers only, behind ?dev=1.
  const [developer, setDeveloper] = useState(false);
  // The landing view is only a question box. A surface takes over once asked for.
  const [home, setHome] = useState(true);
  // What the current question was. While it is worked on, the answer on screen
  // stays visible but dimmed, so the page never goes blank between turns.
  const [asked, setAsked] = useState("");
  const [priorSteps, setPriorSteps] = useState<Set<string> | null>(null);
  const [principalId, setPrincipalId] = useState("user-coo");
  const [personas, setPersonas] = useState<PrincipalSummary[]>([]);
  const [authMode, setAuthMode] = useState<"demo" | "oidc">("demo");
  const [signedOut, setSignedOut] = useState(false);
  const currentRunId = useRef<string | null>(null);
  const principalRef = useRef(principalId);
  const runtimeBase = useRef(agentUrl);
  const sessionAuth = useRef(false);
  const openedFor = useRef<string | null>(null);
  // Latest activity, readable from callbacks created before it arrived.
  const activityRef = useRef<PublicState["activity"]>([]);
  activityRef.current = state.activity;
  principalRef.current = principalId;

  function authHeaders(id = principalRef.current): Record<string, string> {
    return sessionAuth.current ? {} : principalHeaders(id);
  }

  /** Moves the question box between the centre and the top in place, without a page change. */
  function morph(update: () => void) {
    const start = (document as Document & { startViewTransition?: (callback: () => void) => unknown }).startViewTransition;
    if (start) start.call(document, () => flushSync(update));
    else update();
  }

  function showResults() {
    morph(() => setHome(false));
    if (window.location.hash !== "#view") window.history.replaceState(null, "", "#view");
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
          message: failureLine(REQUEST_FAILED, event.message),
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
    if (params.get("dev") === "1") setDeveloper(true);
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
      if (restored.status !== "running") openWorkspace(restored, id);
      if (restored.status === "running" && restored.runId) {
        showResults();
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

  async function ask(text: string, threadId = state.threadId, id = principalId, earlier = activityRef.current) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const runId = `run-${crypto.randomUUID()}`;
    currentRunId.current = runId;
    setAsked(trimmed);
    setPriorSteps(new Set(earlier.map((item) => item.id)));
    showResults();
    setBusy(true);
    setQuestion("");
    setState((current) => ({
      ...current,
      runId,
      status: "running",
      activity: [{ id: crypto.randomUUID(), message: RUN_START, kind: "status", timestamp: new Date().toISOString() }, ...current.activity],
    }));
    try {
      await streamRequest("/runtime/investigate", { question: trimmed, threadId, runId, principalId: id }, (event) => applyEvent(event, runId), sessionAuth.current ? undefined : id, sessionAuth.current ? { base: runtimeBase.current, credentials: "include" } : undefined);
    } catch (error) {
      if (currentRunId.current !== runId) return;
      setState((current) => ({
        ...current,
        status: "failed",
        activity: [{ id: crypto.randomUUID(), message: failureLine(REQUEST_FAILED, error), kind: "status", timestamp: new Date().toISOString() }, ...current.activity],
      }));
    } finally {
      if (currentRunId.current === runId) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  /**
   * Opens on a briefing rather than a blank page. It is prepared once per
   * browser session for each identity; after that the last view is shown.
   */
  function openWorkspace(restored: PublicState, id: string) {
    // The mount effect can run twice in development; one briefing per identity is enough.
    if (openedFor.current === id) return;
    openedFor.current = id;
    let briefed = false;
    try { briefed = window.sessionStorage.getItem(briefedKey(id)) === "1"; } catch { /* storage unavailable */ }
    if (briefed && restored.surface) { showResults(); return; }
    try { window.sessionStorage.setItem(briefedKey(id), "1"); } catch { /* storage unavailable */ }
    void ask(BRIEFING, restored.threadId, id, restored.activity);
  }

  async function invoke(name: string, context: Record<string, unknown> = {}) {
    if (name === "show_evidence") {
      // Every cited record, each explained by the runtime (grant-checked, redacted, no model).
      const ids = [...new Set([context.evidenceId, ...(Array.isArray(context.evidenceIds) ? context.evidenceIds : [])]
        .filter((id): id is string => typeof id === "string" && id.length > 0))];
      if (!ids.length) return;
      const metricId = typeof context.metricId === "string" ? context.metricId : undefined;
      const resultPath = typeof context.resultPath === "string" ? context.resultPath : undefined;
      const query = new URLSearchParams({ ...(metricId ? { metricId } : {}), ...(resultPath ? { path: resultPath } : {}) }).toString();
      const items = await Promise.all(ids.map(async (evidenceId): Promise<EvidenceItem> => {
        try {
          const response = await fetch(endpoint(`/runtime/evidence/${encodeURIComponent(evidenceId)}/explain${query ? `?${query}` : ""}`), { headers: authHeaders(), credentials: sessionAuth.current ? "include" : "same-origin" });
          if (response.status === 403) return { evidenceId, error: "You do not have access to this record." };
          if (!response.ok) return { evidenceId, error: "Evidence not found" };
          return { evidenceId, explanation: await response.json() as EvidenceExplanation };
        } catch {
          return { evidenceId, error: "Evidence could not be loaded" };
        }
      }));
      setEvidence({ items, ...(metricId ? { metricId } : {}), ...(resultPath ? { resultPath } : {}) });
      return;
    }
    // Going deeper into a topic is a new question, shown like one the person typed.
    if (name === "investigate" && typeof context.question === "string" && context.question.trim()) {
      void ask(context.question);
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
        entities: Array.isArray(context.entities) ? context.entities : context.entityId && context.entityType ? [{ type: context.entityType, id: context.entityId }] : [],
        parameters: context,
        principalId,
      }, (event) => applyEvent(event, runId), sessionAuth.current ? undefined : principalId, sessionAuth.current ? { base: runtimeBase.current, credentials: "include" } : undefined);
      const snapshot = (await fetch(`${endpoint("/runtime/state")}?threadId=${encodeURIComponent(state.threadId)}`, { headers: authHeaders(), credentials: sessionAuth.current ? "include" : "same-origin" }).then((response) => response.json()).catch(() => null)) as PublicState | null;
      if (snapshot?.evidence) setEvidence({ items: [{ evidenceId: String(snapshot.evidence.evidenceId ?? "evidence"), raw: snapshot.evidence }] });
    } catch (error) {
      if (currentRunId.current !== runId) return;
      setState((current) => ({
        ...current,
        activity: [{ id: crypto.randomUUID(), message: failureLine(ACTION_FAILED, error), kind: "status", timestamp: new Date().toISOString() }, ...current.activity],
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
    if (response.ok) {
      setState(await response.json() as PublicState);
      showResults();
    }
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

  async function switchPrincipal(nextId: string) {
    window.localStorage.setItem(PRINCIPAL_STORAGE_KEY, nextId);
    setPrincipalId(nextId);
    setEvidence(null);
    setAsked("");
    setPriorSteps(null);
    currentRunId.current = null;
    setBusy(false);
    const response = await fetch(endpoint("/runtime/state"), { headers: authHeaders(nextId) });
    const next = response.ok
      ? await response.json() as PublicState
      : { ...emptyState, threadId: nextId === "user-coo" ? "local-demo" : `session:${nextId}` };
    setState(next);
    if (next.status !== "running") openWorkspace(next, nextId);
  }

  const working = busy || state.status === "running";
  // Steps of the current question only, oldest first.
  const steps = useMemo(() => {
    const newestFirst = priorSteps
      ? state.activity.filter((item) => !priorSteps.has(item.id))
      : state.activity.slice(0, state.activity.findIndex((item) => item.message === RUN_START) + 1 || state.activity.length);
    return [...newestFirst].reverse();
  }, [state.activity, priorSteps]);
  // The answer on screen stays while the next one is worked on (dimmed), and is
  // replaced in place when it arrives (R5).
  const surface = state.surface;
  const pending = working && !surface;

  const identity = authMode === "oidc" ? (
    signedOut
      ? <a className="ghost" href="/api/auth/login">Sign in</a>
      : <form method="post" action="/api/auth/logout"><button className="ghost" type="submit">Sign out</button></form>
  ) : (
    <select className="persona-select" aria-label="Demo identity (not real sign-in)" value={principalId} onChange={(event) => void switchPrincipal(event.target.value)}>
      {(personas.length ? personas : [{ id: "user-coo", displayName: "Ananya Reddy", title: "Chief Operating Officer" }]).map((item) => (
        <option key={item.id} value={item.id}>{item.displayName} · {item.title}</option>
      ))}
    </select>
  );

  return (
    <main className={home ? "app-shell home" : "app-shell"}>
      <header className="masthead">
        <div className="masthead-inner">
          {home
            ? <h1 className="wordmark"><span className="wordmark-mark" aria-hidden="true" />DemoCo <span className="wordmark-sub">Parcel Network</span></h1>
            : <button className="wordmark" type="button" onClick={() => void ask(BRIEFING)} aria-label="DemoCo: refresh briefing" title="Refresh the morning briefing"><span className="wordmark-mark" aria-hidden="true" />DemoCo</button>}
          {signedOut ? <p className="muted">Sign in to use the workspace.</p> : (
            <form className="question-form" onSubmit={submit} id="question">
              <svg className="question-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about hubs, parcels, lockers, shippers or complaints" aria-label="Workspace question" autoFocus />
              <button type="submit" disabled={busy || !question.trim()}>Ask</button>
            </form>
          )}
          <div className="connection">
            {home ? null : (
              <>
                <ActivityPill steps={steps} working={working} status={state.status} />
                {busy ? <button className="ghost" type="button" onClick={() => void cancel()}>Cancel</button> : null}
                <span className="clock" title="The network's fixed demo clock">Mon 21 Sep · 07:00 IST</span>
              </>
            )}
            {identity}
          </div>
        </div>
      </header>
      {home ? null : (
        <div className="stage" data-testid="stage">
          <section className={working && surface ? "workspace updating" : "workspace"} aria-live="polite" aria-busy={busy} data-testid="workspace">
            {pending ? (
              <div className="pending" role="status">
                <h2>{asked === BRIEFING ? "Preparing your morning briefing" : asked || "Working on it"}</h2>
                <div className="skeleton" aria-hidden="true"><span /><span /><span /></div>
              </div>
            ) : surface ? (
              <A2UIWorkspace
                messages={surface.messages as A2UIMessage[]}
                onAction={(action) => void invoke(action.name, action.context)}
              />
            ) : (
              <div className="pending">
                {asked && asked !== BRIEFING ? <h2>{asked}</h2> : null}
                <p className="muted">{state.status === "failed" ? "This request could not be completed." : state.status === "cancelled" ? "Stopped." : "Nothing to show yet."}</p>
              </div>
            )}
          </section>
          {developer && !working ? (
            <details className="dev-details" open>
              <summary>Developer: every step, previous views and run details</summary>
              <ol className="dev-steps">
                {steps.map((item) => <li key={item.id}>{activityKindLabel(item.kind)} · {item.message}</li>)}
              </ol>
              {state.surfaceHistory.map((item) => (
                <button key={`${item.surfaceId}-${item.revision}`} className="ghost history" type="button" onClick={() => void restore(item)}>
                  {item.title} · revision {item.revision}
                </button>
              ))}
              <p>Run {state.runId ?? "none"}</p>
              <p>Investigation {state.investigationId ?? "none"}</p>
              <p>Revision {state.surface?.revision ?? "—"}</p>
              <p>Provider {state.execution?.provider ?? "unknown"} · {state.execution?.executionMode ?? "fixture"}</p>
              <p>Cost {state.usage?.costStatus === "known" && state.usage.estimatedCostUsd !== null ? `$${state.usage.estimatedCostUsd}` : "unknown"}</p>
              {substitutions.length ? substitutions.map((item) => (
                <p key={`${item.specialist}-${item.reason}`}>Substituted {item.specialist}: {item.reason}</p>
              )) : <p>No specialist substitutions</p>}
            </details>
          ) : null}
        </div>
      )}
      {evidence ? <EvidenceDrawer key={evidence.items.map((item) => item.evidenceId).join("|")} state={evidence} onClose={() => setEvidence(null)} /> : null}
    </main>
  );
}
