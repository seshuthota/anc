import { describe, expect, it } from "vitest";
import { ActionNameSchema, SemanticActionSchema } from "./actions.js";
import { A2UIMessageSchema, PresentationInputSchema } from "./a2ui.js";
import { EntityRefSchema, TimeWindowSchema } from "./entities.js";
import { EvidenceEnvelopeSchema } from "./evidence.js";

const validEnvelope = {
  evidenceId: "ev-1",
  tool: "list_invoice_aging",
  toolVersion: "1",
  source: {
    system: "company-sqlite",
    datasetVersion: "sync-regression",
    retrievedAt: "2026-09-20T08:00:00.000Z",
    asOf: "2026-09-20T08:00:00.000Z",
    timezone: "UTC",
  },
  arguments: {},
  filters: {},
  result: { rows: [] },
  completeness: "complete" as const,
  payloadHash: "a".repeat(64),
};

describe("evidence envelope", () => {
  it("accepts a complete envelope and defaults entities", () => {
    const parsed = EvidenceEnvelopeSchema.parse(validEnvelope);
    expect(parsed.entities).toEqual([]);
    expect(parsed.source.currency).toBeUndefined();
  });

  it("rejects a payload hash that is not a sha256 hex digest", () => {
    expect(EvidenceEnvelopeSchema.safeParse({ ...validEnvelope, payloadHash: "nope" }).success).toBe(false);
  });

  it("rejects an unknown completeness value", () => {
    expect(EvidenceEnvelopeSchema.safeParse({ ...validEnvelope, completeness: "probably" }).success).toBe(false);
  });

  it("rejects a source timestamp that is not an ISO datetime", () => {
    const source = { ...validEnvelope.source, retrievedAt: "yesterday" };
    expect(EvidenceEnvelopeSchema.safeParse({ ...validEnvelope, source }).success).toBe(false);
  });

  it("rejects a currency code that is not three letters", () => {
    const source = { ...validEnvelope.source, currency: "dollars" };
    expect(EvidenceEnvelopeSchema.safeParse({ ...validEnvelope, source }).success).toBe(false);
  });

  it("normalizes a lowercase currency code to uppercase", () => {
    const source = { ...validEnvelope.source, currency: "usd" };
    expect(EvidenceEnvelopeSchema.parse({ ...validEnvelope, source }).source.currency).toBe("USD");
  });
});

describe("action contract", () => {
  it("accepts every registered action name", () => {
    for (const name of ActionNameSchema.options) {
      expect(ActionNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects an unregistered action name", () => {
    expect(ActionNameSchema.safeParse("delete_everything").success).toBe(false);
  });

  it("rejects a non-positive surface revision", () => {
    const action = {
      actionId: "act-1",
      name: "show_evidence",
      threadId: "session:user-ops",
      investigationId: "run-1",
      surfaceId: "surface-1",
      surfaceRevision: 0,
    };
    expect(SemanticActionSchema.safeParse(action).success).toBe(false);
  });

  it("defaults entities and parameters on a valid action", () => {
    const parsed = SemanticActionSchema.parse({
      actionId: "act-1",
      name: "show_evidence",
      threadId: "session:user-ops",
      investigationId: "run-1",
      surfaceId: "surface-1",
      surfaceRevision: 1,
    });
    expect(parsed.entities).toEqual([]);
    expect(parsed.parameters).toEqual({});
  });
});

describe("entity and time window", () => {
  it("rejects an unknown entity type", () => {
    expect(EntityRefSchema.safeParse({ type: "invoice", id: "inv-1" }).success).toBe(false);
  });

  it("rejects a time window whose start does not precede its end", () => {
    const window = {
      start: "2026-09-20T08:00:00.000Z",
      end: "2026-09-19T08:00:00.000Z",
      timezone: "UTC",
      grain: "day" as const,
    };
    expect(TimeWindowSchema.safeParse(window).success).toBe(false);
  });
});

describe("A2UI messages", () => {
  it("accepts the three lifecycle messages the composer emits", () => {
    const messages = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "catalog" } },
      { version: "v0.9", updateComponents: { surfaceId: "s1", components: [{ id: "root" }] } },
      { version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/", value: {} } },
    ];
    for (const message of messages) {
      expect(A2UIMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("rejects an unsupported protocol version", () => {
    expect(A2UIMessageSchema.safeParse({ version: "v0.8", deleteSurface: { surfaceId: "s1" } }).success).toBe(false);
  });

  it("rejects a message with no lifecycle operation", () => {
    expect(A2UIMessageSchema.safeParse({ version: "v0.9" }).success).toBe(false);
  });
});

describe("presentation input", () => {
  it("defaults optional collections so a minimal surface stays valid", () => {
    const parsed = PresentationInputSchema.parse({ title: "Morning overview", subtitle: "3 findings" });
    expect(parsed.metrics).toEqual([]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.actions).toEqual([]);
    expect(parsed.limitations).toEqual([]);
  });

  it("rejects an empty title", () => {
    expect(PresentationInputSchema.safeParse({ title: "", subtitle: "x" }).success).toBe(false);
  });

  it("rejects a metric without an evidence id so numbers cannot be unsourced", () => {
    const parsed = PresentationInputSchema.safeParse({
      title: "t",
      subtitle: "s",
      metrics: [{ id: "m1", label: "ARR", value: "$2.1M" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a finding whose kind is not a declared epistemic state", () => {
    const parsed = PresentationInputSchema.safeParse({
      title: "t",
      subtitle: "s",
      findings: [{ id: "f1", title: "Sync regression", body: "b", kind: "fact", evidenceIds: ["ev-1"] }],
    });
    expect(parsed.success).toBe(false);
  });
});
