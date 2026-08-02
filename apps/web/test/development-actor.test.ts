import { describe, expect, test } from "bun:test";
import { developmentIdentity } from "../src/lib/development-actor";

describe("development scenario identity", () => {
  test("uses a valid scenario actor only in development", () => {
    expect(developmentIdentity("?scenarioActor=ananya", true)).toEqual({
      actorId: "ananya",
      scenario: true,
    });
    expect(developmentIdentity("?scenarioActor=ananya", false)).toEqual({
      actorId: "dev-user",
      scenario: false,
    });
  });

  test("falls back safely for malformed or missing actor ids", () => {
    expect(developmentIdentity("", true)).toEqual({ actorId: "dev-user", scenario: false });
    expect(developmentIdentity("?scenarioActor=../../admin", true)).toEqual({
      actorId: "dev-user",
      scenario: false,
    });
    expect(developmentIdentity(`?scenarioActor=${"a".repeat(65)}`, true)).toEqual({
      actorId: "dev-user",
      scenario: false,
    });
  });
});
