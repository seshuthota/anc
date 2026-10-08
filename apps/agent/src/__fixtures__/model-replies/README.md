# Model replies for `pnpm eval:briefing` (fixture mode)

These files stand in for recorded Lead Analyst and UI Composer replies. They were
**written by hand**: no live model key was available when Slice 6 landed, so none
of them was captured from a real model. Replace them with recorded replies once a
live-strict run exists (keep the same shape).

Each file holds an ordered list of replies. The eval serves reply 1 on the first
call and reply 2 on the retry that follows a rejection, so every run exercises the
runtime's review → feedback → repair loop:

- `synthesis.json` — reply 1 invents a figure and a finding id (must be rejected);
  reply 2 is a valid account of the ranked primary (must be accepted).
- `composer-briefing.json` — reply 1 adds a free-standing Stat tile and a Card
  (over the R3 budget, must be rejected); reply 2 is a valid briefing tree (must be
  accepted, so the shown tree is the model's).

Placeholders (`{{…}}` in strings, `"$…"` entries in `children`) are filled from the
request by `apps/agent/src/eval/replay.ts`; no figure comes from these files.
