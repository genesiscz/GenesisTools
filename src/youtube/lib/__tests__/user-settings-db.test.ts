import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

function mkUser(email = "u@example.com") {
    return db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });
}

describe("user settings persistence", () => {
    it("defaults new users to an empty settings object", () => {
        const user = mkUser();

        expect(user.settings).toEqual({});
    });

    it("persists and round-trips a settings blob", () => {
        const user = mkUser();
        const updated = db.updateUserSettings(user.id, {
            theme: "dark",
            density: "compact",
            taskDefaults: { summary: { tone: "funny", lang: "en" } },
            panel: { autoOpen: true, defaultTab: "summary" },
        });

        expect(updated.settings.theme).toBe("dark");
        expect(updated.settings.taskDefaults?.summary?.tone).toBe("funny");

        const reread = db.getUserById(user.id);

        expect(reread?.settings.density).toBe("compact");
        expect(reread?.settings.panel?.autoOpen).toBe(true);
    });

    it("throws when updating settings for a missing user", () => {
        expect(() => db.updateUserSettings(9999, { theme: "light" })).toThrow("not found");
    });
});
