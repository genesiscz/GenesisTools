import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createDuplicatesCommand } from "@app/macos/commands/clones/duplicates";
import { SafeJSON } from "@app/utils/json";

describe("createDuplicatesCommand", () => {
    it("named 'duplicates' with --group and --format", () => {
        const cmd = createDuplicatesCommand();
        expect(cmd.name()).toBe("duplicates");
        const longs = cmd.options.map((o) => o.long);
        expect(longs).toContain("--group");
        expect(longs).toContain("--format");
        expect(longs).toContain("--node-modules");
    });

    it("--group json sets grouped:true and emits members", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-dupcmd-"));
        try {
            mkdirSync(join(dir, "a"), { recursive: true });
            mkdirSync(join(dir, "b"), { recursive: true });
            writeFileSync(join(dir, "a", "f"), Buffer.alloc(70_000, 1));
            writeFileSync(join(dir, "b", "f"), Buffer.alloc(70_000, 1));
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => logs.push(a.join(" "));
            try {
                await createDuplicatesCommand().parseAsync(
                    ["node", "duplicates", dir, "--group", "--format", "json"],
                    { from: "node" },
                );
            } finally {
                console.log = orig;
            }

            const parsed = SafeJSON.parse(logs.join("\n")) as {
                grouped: boolean;
                sets: { members: string[] }[];
            };
            expect(parsed.grouped).toBe(true);
            expect(parsed.sets.length).toBeGreaterThan(0);
            expect(parsed.sets[0].members.length).toBe(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
