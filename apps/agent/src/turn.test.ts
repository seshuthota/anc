import { describe, expect, it } from "vitest";
import { classifyTurn, type PriorBriefing } from "./planner.js";

const prior: PriorBriefing = {
  surfaceId: "surface-1",
  revision: 3,
  label: "905 parcels at risk of missing today's promise",
  entities: [
    { type: "equipment", id: "eq-hyd-0920", label: "Sorter belt B" },
    { type: "shipper", id: "shipper-003", label: "Godavari Organics" },
    { type: "hub", id: "hub-hyd" },
  ],
  drills: [
    { question: "What is behind this: 905 parcels at risk of missing today's promise?", label: "905 parcels at risk of missing today's promise" },
    { question: "Look into: Velachery MRTS Station: 34 arrivals with no space", label: "Velachery MRTS Station: 34 arrivals with no space" },
  ],
};

describe("turn classification (R5)", () => {
  it("treats a Look into this click as a drill, labelled by the item it is about", () => {
    expect(classifyTurn({ objective: prior.drills[1]!.question, prior })).toEqual({ kind: "drill", label: "Velachery MRTS Station: 34 arrivals with no space" });
    expect(classifyTurn({ objective: prior.drills[0]!.question, prior })).toEqual({ kind: "drill", label: prior.label });
  });

  it("treats a typed question about a record on the briefing as a drill", () => {
    expect(classifyTurn({ objective: "How is Godavari Organics doing on on-time delivery?", prior })).toEqual({ kind: "drill", label: "Godavari Organics" });
    expect(classifyTurn({ objective: "what happened to eq-hyd-0920", prior })).toEqual({ kind: "drill", label: "Sorter belt B" });
    expect(classifyTurn({ objective: "Tell me more", entities: [{ type: "hub", id: "hub-hyd" }], prior })).toEqual({ kind: "drill", label: prior.label });    expect(classifyTurn({ objective: "status of hub-hyd today?", prior })).toEqual({ kind: "drill", label: prior.label });
  });

  it("matches a named record as a whole word, not inside another word (Reviewer M7)", () => {
    expect(classifyTurn({ objective: "what about hub-hyderabad-2", prior })).toEqual({ kind: "new_topic" });
    expect(classifyTurn({ objective: "how is godavari organicsplus doing", prior })).toEqual({ kind: "new_topic" });
    expect(classifyTurn({ objective: "Godavari Organics?", prior })).toEqual({ kind: "drill", label: "Godavari Organics" });
  });

  it("starts a new topic for a new briefing, an unrelated question, or with no briefing on screen", () => {
    expect(classifyTurn({ objective: "Brief me: what needs my attention this morning?", prior }).kind).toBe("new_topic");
    expect(classifyTurn({ objective: "Which parcel lockers are full?", prior }).kind).toBe("new_topic");
    expect(classifyTurn({ objective: prior.drills[1]!.question }).kind).toBe("new_topic");
  });

  it("names surface operations as actions, which never start work", () => {
    for (const action of ["propose_action", "confirm_action", "cancel_action", "show_evidence", "back_to_briefing"]) {
      expect(classifyTurn({ objective: "", action, prior }).kind).toBe("action");
    }
  });
});
