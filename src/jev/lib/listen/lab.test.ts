import { expect, test } from "bun:test";
import { ListenSessionConflictError, resetListenLabForTests, startListenLab, stopListenLab } from "./lab";

test("a second listen start is a conflict", () => {
    resetListenLabForTests();
    startListenLab({ transcript: "fixture.jsonl" });
    expect(() => startListenLab()).toThrow(ListenSessionConflictError);
    expect(stopListenLab().running).toBe(false);
    resetListenLabForTests();
});
