export type SpecialistSubstitution = {
  specialist: string;
  reason: string;
};

const substitutionsByRun = new Map<string, SpecialistSubstitution[]>();

export function recordSubstitution(runId: string, specialist: string, reason: string) {
  const current = substitutionsByRun.get(runId) ?? [];
  current.push({ specialist, reason });
  substitutionsByRun.set(runId, current);
}

export function peekSubstitutions(runId: string): SpecialistSubstitution[] {
  return [...(substitutionsByRun.get(runId) ?? [])];
}

export function takeSubstitutions(runId: string): SpecialistSubstitution[] {
  const current = peekSubstitutions(runId);
  substitutionsByRun.delete(runId);
  return current;
}
