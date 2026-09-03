import { describe, expect, it } from "bun:test";
import { clonesGuide } from "@app/macos/commands/clones/guide";

describe("clonesGuide", () => {
    it("names every verb of the group", () => {
        const text = clonesGuide();
        for (const verb of ["measure", "du", "duplicates", "optimize", "reclaim", "config", "daemon"]) {
            expect(text).toContain(verb);
        }
    });

    it("teaches the two meanings of plan and never calls the 1h snapshot a preset", () => {
        const text = clonesGuide();
        expect(text).toContain("preset");
        expect(text).toContain("rediscovers");
        expect(text).toContain("1 hour");
    });

    it("states the keep-only rule and lists the log locations", () => {
        const text = clonesGuide();
        expect(text).toContain("never written");
        expect(text).toContain("~/.genesis-tools/macos-clones/reclaim/");
        expect(text).toContain("~/.genesis-tools/macos-clones/process/");
        expect(text).toContain("PROFILE=clones");
    });

    it("shows a runnable reclaim example", () => {
        expect(clonesGuide()).toContain("tools macos clones reclaim plan --dir");
    });
});
