import { describe, expect, it } from "bun:test";
import { StyleProfileEngine } from "../StyleProfileEngine";
import { TelegramContact } from "../TelegramContact";

describe("StyleProfileEngine", () => {
    it("returns null when style profile is disabled", async () => {
        const engine = new StyleProfileEngine();
        const contact = TelegramContact.fromConfig({
            userId: "1",
            displayName: "Alice",
            actions: ["notify"],
            replyDelayMin: 1000,
            replyDelayMax: 2000,
            styleProfile: {
                enabled: false,
                refresh: "incremental",
                rules: [],
                previewInWatch: false,
            },
        });
        const fakeStore = {
            queryMessages: () => [],
        };

        const result = await engine.deriveStylePrompt(
            contact,
            fakeStore as unknown as Parameters<StyleProfileEngine["deriveStylePrompt"]>[1]
        );

        expect(result).toBeNull();
    });
});
