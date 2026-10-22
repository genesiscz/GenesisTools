import { describe, expect, test } from "bun:test";
import { genesisMdHandlerPath, genesisMdLink, hasGenesisMdHandler, openFileTarget } from "./open-file";
import { schemeLink } from "./targets";

describe("open-file", () => {
    const file = "/Users/alice/Notes/Weekly plan Č.md";

    test("the genesis-md link is the one targets.ts builds, slashes kept", () => {
        for (const range of [undefined, "12", "12-30"]) {
            expect(genesisMdLink({ path: file, range })).toBe(
                schemeLink({ preset: "genesis-md", action: "open", data: { path: file, range } })
            );
        }

        expect(genesisMdLink({ path: file, range: "3-4" })).toBe(
            "genesis-md://open?path=/Users/alice/Notes/Weekly%20plan%20%C4%8C.md&range=3-4"
        );
    });

    test("with a handler the target is the link; without one it is the plain path for the default app", () => {
        expect(openFileTarget(file, "5", { hasHandler: true })).toBe(genesisMdLink({ path: file, range: "5" }));
        expect(openFileTarget(file, "5", { hasHandler: false })).toBe(file);
    });

    test("the probe's answer decides, and a passed probe is not cached", () => {
        expect(hasGenesisMdHandler(() => null)).toBe(false);
        expect(hasGenesisMdHandler(() => "/Applications/Genesis Markdown.app")).toBe(true);
        expect(hasGenesisMdHandler(() => null)).toBe(false);
    });

    test.skipIf(process.platform !== "darwin")("the real probe answers an app path or null, never throws", () => {
        const found = genesisMdHandlerPath();
        expect(found === null || found.endsWith(".app")).toBe(true);
    });
});
