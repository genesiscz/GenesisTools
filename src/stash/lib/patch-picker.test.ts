import { describe, expect, it } from "bun:test";
import { pickPatchInteractively } from "./patch-picker";

// Synthetic 3-hunk diff: file-a.ts has hunk-0 and hunk-1; file-b.ts has hunk-2.
const SYNTHETIC_PATCH = `diff --git a/file-a.ts b/file-a.ts
index abc1234..def5678 100644
--- a/file-a.ts
+++ b/file-a.ts
@@ -1,4 +1,5 @@
 const x = 1;
+const hunk0 = true;
 const y = 2;
 const z = 3;
@@ -10,4 +11,5 @@
 const a = 10;
+const hunk1 = true;
 const b = 11;
 const c = 12;
diff --git a/file-b.ts b/file-b.ts
index abc1234..def5678 100644
--- a/file-b.ts
+++ b/file-b.ts
@@ -1,4 +1,5 @@
 const p = 1;
+const hunk2 = true;
 const q = 2;
 const r = 3;
`;

describe("pickPatchInteractively", () => {
    it("accepts hunk-0, rejects hunk-1, accepts hunk-2; droppedCount=1", async () => {
        const responses = ["y", "n", "y"];
        let callIndex = 0;

        const mockPrompts = {
            select: async (_opts: { message: string; options: Array<{ value: string; label: string }> }) => {
                const answer = responses[callIndex];
                callIndex++;

                if (answer === undefined) {
                    throw new Error("Unexpected extra select() call");
                }

                return answer;
            },
            note: (_message: string, _title?: string) => {
                // no-op in tests
            },
        };

        const result = await pickPatchInteractively({ patch: SYNTHETIC_PATCH }, { prompts: mockPrompts });

        // droppedCount must be exactly 1 (hunk-1 skipped)
        expect(result.droppedCount).toBe(1);

        // hunk-0 body must be present
        expect(result.kept).toContain("hunk0");

        // hunk-1 body must NOT be present
        expect(result.kept).not.toContain("hunk1");

        // hunk-2 body must be present
        expect(result.kept).toContain("hunk2");
    });

    it("quit early after hunk-0: keeps hunk-0, returns immediately without reviewing hunk-1 or hunk-2", async () => {
        // First prompt: accept hunk-0 ("y"). Second prompt: quit ("q") — stop without hunk-1/hunk-2.
        const responses = ["y", "q"];
        let callIndex = 0;

        const mockPrompts = {
            select: async (_opts: { message: string; options: Array<{ value: string; label: string }> }) => {
                const answer = responses[callIndex];
                callIndex++;
                return answer ?? "q";
            },
            note: (_message: string, _title?: string) => {},
        };

        const result = await pickPatchInteractively({ patch: SYNTHETIC_PATCH }, { prompts: mockPrompts });

        expect(result.kept).toContain("hunk0");
        expect(result.kept).not.toContain("hunk1");
        expect(result.kept).not.toContain("hunk2");
        // droppedCount: 0 (hunk-0 was accepted; quit before reaching hunk-1/hunk-2)
        expect(result.droppedCount).toBe(0);
        // Only 2 select() calls were made
        expect(callIndex).toBe(2);
    });

    it("returns empty kept with droppedCount=0 for empty patch", async () => {
        const mockPrompts = {
            select: async () => "y",
            note: () => {},
        };

        const result = await pickPatchInteractively({ patch: "" }, { prompts: mockPrompts });

        expect(result.kept).toBe("");
        expect(result.droppedCount).toBe(0);
    });
});
