/**
 * gpt-oss via Explabs often wraps the real payload under a broken key like "final{" when
 * json_object mode is enabled, or buries JSON in markdown fences / nested JSON strings.
 * Extract a shaped object without inventing fields.
 */
export function extractModelJsonObject(
  content: unknown,
  looksLikeTarget: (obj: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return unwrapModelObject(content as Record<string, unknown>, looksLikeTarget);
  }
  if (typeof content !== "string") return {};
  const trimmed = content.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return unwrapModelObject(parsed as Record<string, unknown>, looksLikeTarget);
      }
    } catch {
      // try next candidate
    }
  }
  return {};
}

function unwrapModelObject(
  parsed: Record<string, unknown>,
  looksLikeTarget: (obj: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  if (looksLikeTarget(parsed)) return parsed;
  for (const [key, value] of Object.entries(parsed)) {
    if (value && typeof value === "object" && !Array.isArray(value) && looksLikeTarget(value as Record<string, unknown>)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === "string" && (/final/i.test(key) || key === "plan" || key === "result" || key === "output" || key === "data")) {
      try {
        const inner = JSON.parse(value) as unknown;
        if (inner && typeof inner === "object" && !Array.isArray(inner) && looksLikeTarget(inner as Record<string, unknown>)) {
          return inner as Record<string, unknown>;
        }
      } catch {
        // continue
      }
    }
    // Rare: the entire payload was stuffed into a JSON key name.
    if (key.includes('"') && (key.includes("{") || key.includes("["))) {
      for (const candidate of [`{${key}}`, key]) {
        try {
          const inner = JSON.parse(candidate) as unknown;
          if (inner && typeof inner === "object" && !Array.isArray(inner) && looksLikeTarget(inner as Record<string, unknown>)) {
            return inner as Record<string, unknown>;
          }
        } catch {
          // continue
        }
      }
    }
  }
  return parsed;
}
