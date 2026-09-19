"use client";

import { FormEvent, useMemo, useState } from "react";

type Surface = {
  surfaceId: string;
  revision: number;
  title: string;
  subtitle: string;
  components: Array<
    | { type: "metric"; id: string; label: string; value: string; detail: string; tone?: "danger" | "warning" | "neutral" }
    | { type: "finding"; id: string; title: string; body: string; evidence: string }
    | { type: "action"; id: string; label: string; intent: string }
  >;
};

const initialSurface: Surface = {
  surfaceId: "fixture-morning-brief",
  revision: 1,
  title: "Good morning",
  subtitle: "A fixture investigation is ready for review.",
  components: [
    { type: "metric", id: "errors", label: "API error rate", value: "5.8%", detail: "up from 0.7% yesterday", tone: "danger" },
    { type: "metric", id: "usage", label: "Sync usage", value: "−19%", detail: "compared with the prior period", tone: "warning" },
    { type: "metric", id: "accounts", label: "Accounts in scope", value: "14", detail: "$2.1M ARR represented" },
    { type: "finding", id: "release", title: "A recent release lines up with the change", body: "The synchronization error signature began after release-2026-09-19-3 reached the affected cohort.", evidence: "release timeline · error metrics" },
    { type: "action", id: "affected", label: "Show affected accounts", intent: "show_affected_accounts" },
  ],
};

const activitySeed = [
  "Ask a question to start an investigation",
];

const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:4100";

export default function HomePage() {
  const [surface, setSurface] = useState(initialSurface);
  const [activity, setActivity] = useState(activitySeed);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  const metrics = useMemo(() => surface.components.filter((component) => component.type === "metric"), [surface]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setActivity((items) => [`You asked: ${trimmed}`, "Orchestrator started an investigation", ...items]);
    setQuestion("");
    try {
      const response = await fetch(`${agentUrl}/runtime/investigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: trimmed }) });
      if (!response.ok) throw new Error("The runtime could not complete this investigation.");
      const next = await response.json() as { surface: Surface; activity: Array<{ message: string }> };
      setSurface(next.surface);
      setActivity(next.activity.map((item) => item.message));
    } catch (error) {
      setActivity((items) => [error instanceof Error ? error.message : "The runtime could not complete this investigation.", ...items]);
    } finally {
      setBusy(false);
    }
  }

  async function invoke(intent: string) {
    setActivity((items) => [`Action dispatched: ${intent}`, ...items]);
    try {
      const response = await fetch(`${agentUrl}/runtime/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId: crypto.randomUUID(), surfaceId: surface.surfaceId, surfaceRevision: surface.revision, intent }) });
      if (!response.ok) throw new Error("This action is no longer valid for the current workspace.");
      const next = await response.json() as { surface: Surface; activity: Array<{ message: string }> };
      setSurface(next.surface);
      setActivity(next.activity.map((item) => item.message));
    } catch (error) {
      setActivity((items) => [error instanceof Error ? error.message : "The runtime could not complete this action.", ...items]);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><span className="eyebrow">DEMOCO / INVESTIGATIONS</span><h1>Morning workspace</h1></div>
        <div className="connection"><span className="status-dot" /> Local runtime <span className="divider" /> Sep 20, 2026 · 08:00 UTC</div>
      </header>
      <div className="workspace-grid">
        <section className="workspace" aria-live="polite">
          <div className="workspace-heading"><div><span className="eyebrow">GENERATED WORKSPACE · REVISION {surface.revision}</span><h2>{surface.title}</h2><p>{surface.subtitle}</p></div><span className="badge">Read only</span></div>
          <div className="metric-grid">{metrics.map((metric) => metric.type === "metric" && <article className={`metric-card ${metric.tone ?? ""}`} key={metric.id}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small></article>)}</div>
          <div className="finding-list">{surface.components.filter((component) => component.type !== "metric").map((component) => component.type === "finding" ? <article className="finding-card" key={component.id}><div className="finding-icon">↗</div><div><span className="eyebrow">FINDING</span><h3>{component.title}</h3><p>{component.body}</p><button className="evidence-link" onClick={() => invoke("show_evidence")}>View evidence <span>{component.evidence}</span></button></div></article> : <button className="action-card" key={component.id} onClick={() => invoke(component.intent)}><span>＋</span><span>{component.label}</span><b>→</b></button>)}</div>
          <form className="question-form" onSubmit={submit}><span className="spark">✦</span><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask anything about the company…" aria-label="Investigation question" /><button type="submit" disabled={busy}>{busy ? "Investigating…" : "Ask"}</button></form>
        </section>
        <aside className="activity-panel"><div className="panel-heading"><div><span className="eyebrow">RUNTIME</span><h2>Activity</h2></div><span className="live-pill"><span className="status-dot" /> Live</span></div><div className="timeline">{activity.map((item, index) => <div className="timeline-item" key={`${item}-${index}`}><span className="timeline-dot" /><div><p>{item}</p><small>{index === 0 ? "now" : `${index * 2}m ago`}</small></div></div>)}</div><div className="panel-footer"><span className="eyebrow">INVESTIGATION</span><p>{surface.surfaceId}</p><span className="muted">Evidence references appear with each verified claim.</span></div></aside>
      </div>
    </main>
  );
}
