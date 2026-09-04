import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { listAutosaveFiles, readAutosaveFile, readPreviousAutosaveSession } from "./autosave";

describe("listAutosaveFiles", () => {
    test("splits current vs previous session files", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cmux-autosave-"));
        mkdirSync(dir, { recursive: true });
        await Bun.write(join(dir, "session-app.json"), SafeJSON.stringify({ windows: [] }));
        await Bun.write(
            join(dir, "session-app-previous.json"),
            SafeJSON.stringify({ windows: [{ tabManager: { workspaces: [] } }] })
        );
        await Bun.write(join(dir, "session-app-previous-backup.json"), SafeJSON.stringify({ windows: [] }));

        const current = listAutosaveFiles(dir, "current").map((f) => f.path.split("/").pop());
        const previous = listAutosaveFiles(dir, "previous").map((f) => f.path.split("/").pop());
        expect(current).toContain("session-app.json");
        expect(current).toContain("session-app-previous-backup.json");
        expect(previous).toEqual(["session-app-previous.json"]);
        expect(readPreviousAutosaveSession(dir).windows).toHaveLength(1);
    });

    test("readAutosaveFile treats null JSON as empty windows", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cmux-autosave-"));
        const path = join(dir, "session-app.json");
        await Bun.write(path, "null");
        expect(readAutosaveFile(path).windows).toEqual([]);
    });
});
