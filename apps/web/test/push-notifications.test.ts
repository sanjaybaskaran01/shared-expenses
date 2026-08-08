import { describe, expect, test } from "bun:test";
import type { OperationEnvelope } from "@expenses/protocol";
import {
  classifyPushAvailability,
  foregroundActivityMessage,
  queuedForegroundActivityMessage,
  urlBase64ToUint8Array,
} from "../src/lib/push-notifications";

describe("push notification availability", () => {
  test("explains the iPhone Home Screen requirement", () => {
    expect(classifyPushAvailability({
      supported: true,
      isIos: true,
      standalone: false,
      permission: "default",
    })).toBe("install-required");
  });

  test("distinguishes blocked, available, and enabled notifications", () => {
    expect(classifyPushAvailability({ supported: true, isIos: false, standalone: false, permission: "denied" }))
      .toBe("denied");
    expect(classifyPushAvailability({ supported: true, isIos: false, standalone: false, permission: "default" }))
      .toBe("available");
    expect(classifyPushAvailability({ supported: true, isIos: true, standalone: true, permission: "granted", subscribed: true }))
      .toBe("enabled");
  });

  test("decodes a VAPID public key for PushManager", () => {
    expect([...urlBase64ToUint8Array("AQIDBA")]).toEqual([1, 2, 3, 4]);
  });
});

describe("foreground activity notices", () => {
  const expense: OperationEnvelope = {
    id: "operation-1",
    groupId: "group-1",
    actorId: "user-2",
    deviceId: "device-2",
    type: "ExpenseCreated",
    targetId: "expense-1",
    baseVersion: 0,
    clientTimestamp: "2026-08-07T10:00:00.000Z",
    payload: {
      description: "Dinner",
      category: "Dining out",
      amountMinor: 1000,
      currency: "USD",
      expenseDate: "2026-08-07",
      notes: "",
      payers: [{ participantId: "user-2", amountMinor: 1000 }],
      allocations: [{ participantId: "user-1", amountMinor: 1000 }],
    },
    contentHash: "hash",
    signature: "signature",
  };

  test("names the person and expense for one live update", () => {
    expect(foregroundActivityMessage([expense], {
      currentActorId: "user-1",
      actorNames: new Map([["user-2", "Maya"]]),
      groupNames: new Map([["group-1", "Trip"]]),
    })).toBe("Maya added Dinner · Trip");
  });

  test("summarizes a burst without producing several toasts", () => {
    expect(foregroundActivityMessage([expense, { ...expense, id: "operation-2" }], {
      currentActorId: "user-1",
      actorNames: new Map(),
      groupNames: new Map(),
    })).toBe("2 shared updates just arrived");
  });

  test("ignores updates that do not financially affect the signed-in person", () => {
    expect(foregroundActivityMessage([{ ...expense, type: "GroupRenamed" }], {
      currentActorId: "user-1",
      actorNames: new Map(),
      groupNames: new Map(),
    })).toBeUndefined();
    expect(foregroundActivityMessage([expense], {
      currentActorId: "user-3",
      actorNames: new Map(),
      groupNames: new Map(),
    })).toBeUndefined();
    expect(foregroundActivityMessage([{
      ...expense,
      payload: {
        ...(expense.payload as Record<string, unknown>),
        payers: [{ participantId: "user-1", amountMinor: 1000 }],
        allocations: [{ participantId: "user-1", amountMinor: 1000 }],
      },
    } as OperationEnvelope], {
      currentActorId: "user-1",
      actorNames: new Map(),
      groupNames: new Map(),
    })).toBeUndefined();
  });

  test("alerts a participant removed by an amendment using the prior local projection", () => {
    const amended = {
      ...expense,
      id: "operation-2",
      type: "ExpenseAmended",
      payload: {
        ...(expense.payload as Record<string, unknown>),
        payers: [{ participantId: "user-2", amountMinor: 1000 }],
        allocations: [{ participantId: "user-2", amountMinor: 1000 }],
      },
    } as OperationEnvelope;
    expect(foregroundActivityMessage([amended], {
      currentActorId: "user-1",
      actorNames: new Map([["user-2", "Maya"]]),
      groupNames: new Map([["group-1", "Trip"]]),
      previousExpenseNetMinor: new Map([["operation-2", 1000]]),
    })).toBe("Maya updated Dinner · Trip");
  });

  test("preserves awareness when several syncs arrive in a hidden tab", () => {
    expect(queuedForegroundActivityMessage([])).toBeUndefined();
    expect(queuedForegroundActivityMessage(["Maya added Dinner · Trip"]))
      .toBe("Maya added Dinner · Trip");
    expect(queuedForegroundActivityMessage([
      "Maya added Dinner · Trip",
      "Dev recorded a payment · Home",
    ])).toBe("2 shared updates arrived while you were away");
  });
});
