import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigCommand } from "@app/macos/commands/clones/config";
import { type ClonesConfig, loadClonesConfig, storage } from "@app/macos/lib/clones/store";
import { SafeJSON } from "@app/utils/json";

let configSnapshot: ClonesConfig | null;

beforeAll(async () => {
    configSnapshot = await storage.getConfig<ClonesConfig>();
});

afterAll(async () => {
    if (configSnapshot) {
        await storage.setConfig(configSnapshot);
    } else {
        await storage.clearConfig();
    }
});

describe("createConfigCommand (non-TTY)", () => {
    it("has no --format; declares --add-dir/--remove-dir/--list/--set-min-real/--node-modules", () => {
        const longs = createConfigCommand().options.map((o) => o.long);
        expect(longs).not.toContain("--format");
        expect(longs).toContain("--add-dir");
        expect(longs).toContain("--remove-dir");
        expect(longs).toContain("--list");
        expect(longs).toContain("--set-min-real");
        expect(longs).toContain("--node-modules");
    });

    it("--add-dir a,b via parseVariadic persists both (existing dirs); --list prints JSON", async () => {
        const d1 = mkdtempSync(join(tmpdir(), "gt-cl-cfg1-"));
        const d2 = mkdtempSync(join(tmpdir(), "gt-cl-cfg2-"));
        try {
            await createConfigCommand().parseAsync(["node", "config", "--add-dir", `${d1},${d2}`], {
                from: "node",
            });
            const cfg = await loadClonesConfig();
            expect(cfg.watchedDirs).toContain(d1);
            expect(cfg.watchedDirs).toContain(d2);

            const logs: string[] = [];
            const orig = console.log;
            console.log = (...x: unknown[]) => logs.push(x.join(" "));
            try {
                await createConfigCommand().parseAsync(["node", "config", "--list"], { from: "node" });
            } finally {
                console.log = orig;
            }

            const parsed = SafeJSON.parse(logs.join("\n")) as { watchedDirs: string[] };
            expect(parsed.watchedDirs).toContain(d1);

            await createConfigCommand().parseAsync(["node", "config", "--remove-dir", `${d1},${d2}`], {
                from: "node",
            });
        } finally {
            rmSync(d1, { recursive: true, force: true });
            rmSync(d2, { recursive: true, force: true });
        }
    });

    it("warns and skips a non-existent --add-dir path", async () => {
        const errs: string[] = [];
        const orig = console.error;
        console.error = (...x: unknown[]) => errs.push(x.join(" "));
        try {
            await createConfigCommand().parseAsync(["node", "config", "--add-dir", "/no/such/dir/xyz-123"], {
                from: "node",
            });
        } finally {
            console.error = orig;
        }

        const cfg = await loadClonesConfig();
        expect(cfg.watchedDirs).not.toContain("/no/such/dir/xyz-123");
        expect(errs.join("\n")).toContain("/no/such/dir/xyz-123");
    });
});
