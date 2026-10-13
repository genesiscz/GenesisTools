import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { loadConfig, saveConfig } from "./config";

function tempConfigPath(): string {
    return join(mkdtempSync(join(tmpdir(), "question-config-")), "config.json");
}

describe("question config save", () => {
    it("refuses to replace a config that does not parse, and leaves its bytes untouched", () => {
        const path = tempConfigPath();
        const torn = '{"sinks": {"obsidian": false, "sound": true}, "obsidianPathTemplate": "Inbox/{da';
        writeFileSync(path, torn);

        expect(() => saveConfig({ soundVolume: 0.2 }, path)).toThrow(/left untouched/);
        expect(readFileSync(path, "utf8")).toBe(torn);
        expect(loadConfig(path).obsidianPathTemplate).toBe("{project}/Questions/{date}.md");
    });

    it("merges a patch into a valid config and keeps the other keys", () => {
        const path = tempConfigPath();
        writeFileSync(
            path,
            SafeJSON.stringify({ obsidianPathTemplate: "Inbox/{date}.md", sinks: { obsidian: false } })
        );

        saveConfig({ sinks: { obsidian: false, sound: true, notify: false } }, path);
        const saved = SafeJSON.parse(readFileSync(path, "utf8"));

        expect(saved.obsidianPathTemplate).toBe("Inbox/{date}.md");
        expect(saved.sinks).toEqual({ obsidian: false, sound: true, notify: false });
    });
});
