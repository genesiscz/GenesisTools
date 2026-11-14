import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PromptCancelledError } from "@genesiscz/utils/prompts/cancel";
import { getBackend, setBackend } from "../backend";
import { buildInstallPrompt, offerInstall } from "../offer-install";
import { CANCEL_ANSWER, makeTestBackend } from "./test-backend";

describe("offer-install", () => {
    it("builds prompt message with why and command preview", () => {
        const message = buildInstallPrompt({ tool: "fd", command: "brew install fd", why: "faster scans" });

        expect(message).toContain("fd");
        expect(message).toContain("faster scans");
        expect(message).toContain("brew install fd");
    });

    describe("the install confirmation", () => {
        const original = getBackend();
        const originalTty = process.stdin.isTTY;
        // No such program exists, so a run that wrongly reaches the install fails without starting anything.
        const opts = { tool: "fixture-tool", command: "gt-fixture-no-such-installer --yes", why: "a fixture" };

        beforeEach(() => {
            process.stdin.isTTY = true;
        });

        afterEach(() => {
            setBackend(original);
            process.stdin.isTTY = originalTty;
        });

        it("a cancelled confirmation never reaches the install command", async () => {
            setBackend(makeTestBackend({ confirm: CANCEL_ANSWER }));

            await expect(offerInstall(opts)).rejects.toBeInstanceOf(PromptCancelledError);
        });

        it("a declined confirmation installs nothing", async () => {
            setBackend(makeTestBackend({ confirm: false }));

            expect(await offerInstall(opts)).toBe(false);
        });
    });
});
