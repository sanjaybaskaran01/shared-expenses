export interface DevelopmentIdentity {
  actorId: string;
  scenario: boolean;
}

const scenarioActorPattern = /^[a-z][a-z0-9-]{0,47}$/;

export function developmentIdentity(search: string, development: boolean): DevelopmentIdentity {
  if (!development) return { actorId: "dev-user", scenario: false };
  const candidate = new URLSearchParams(search).get("scenarioActor")?.trim() ?? "";
  if (!scenarioActorPattern.test(candidate)) return { actorId: "dev-user", scenario: false };
  return { actorId: candidate, scenario: true };
}
