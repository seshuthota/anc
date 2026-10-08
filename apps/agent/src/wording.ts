/** Person-facing wording shared by operation receipts and confirms. */

/** "1 late complaint", "3 late complaints". */
export function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-IN")} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * A company system's refusal in words for the person: never a tool name, an id
 * scheme or a stack detail. The raw message stays in the audit log.
 */
export function personReason(message: string): string {
  const text = message.replace(/^Company tool \S+ failed:?\s*/i, "").trim();
  const known: Array<[RegExp, string]> = [
    [/version is stale/i, "someone else changed it first"],
    [/already escalated/i, "it had already been escalated"],
    [/already cleared/i, "the fault had already cleared"],
    [/no engineer is on call/i, "no engineer is on call for this hub"],
    [/is closed/i, "the complaint had already been closed"],
    [/not eligible/i, "that person cannot take complaints"],
    [/^unknown /i, "the record could not be found"],
    [/read-only|writable connection/i, "the company system would not accept a change"],
    [/not connected|ECONNREFUSED|ETIMEDOUT|timed? ?out|fetch failed/i, "the company system could not be reached"],
  ];
  for (const [pattern, words] of known) if (pattern.test(text)) return words;
  return "the company system reported a problem";
}
