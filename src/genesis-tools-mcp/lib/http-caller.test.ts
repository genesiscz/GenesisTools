import { describe, expect, it } from "bun:test";
import { codexThreadIdFromOpenFiles } from "./http-caller";

describe("codexThreadIdFromOpenFiles", () => {
    const rollout = (id: string) => `/Users/someone/.codex/sessions/2026/10/01/rollout-2026-10-01T03-02-36-${id}.jsonl`;
    const a = "01a0f4fc-171d-7c30-9679-ee00633dee2d";
    const b = "01a0f4fc-0000-7c30-9679-ee00633dee2d";

    it("names the thread when exactly one rollout is open", () => {
        expect(codexThreadIdFromOpenFiles(["/Users/someone/.codex/state_5.sqlite", rollout(a)])).toBe(a);
    });

    it("names nobody when several threads are open or none is", () => {
        expect(codexThreadIdFromOpenFiles([rollout(a), rollout(b)])).toBeNull();
        expect(codexThreadIdFromOpenFiles(["/Users/someone/.codex/state_5.sqlite"])).toBeNull();
        expect(codexThreadIdFromOpenFiles(["/tmp/rollout-x-" + a + ".jsonl"])).toBeNull();
    });
});
