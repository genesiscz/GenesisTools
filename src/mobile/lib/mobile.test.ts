import { describe, expect, it } from "bun:test";
import { builtAppPath } from "./build";
import { compareFingerprints } from "./fingerprint";
import { stamp } from "./paths";

describe("build staleness", () => {
    it("names the inputs that changed, appeared or went", () => {
        expect(
            compareFingerprints(
                { "a.ts": "1:1", "b.ts": "2:2", "gone.ts": "3:3" },
                { "a.ts": "1:1", "b.ts": "2:9", "new.ts": "4:4" }
            )
        ).toEqual(["b.ts", "gone.ts", "new.ts"]);
    });

    it("finds the built .app for a configuration in DerivedData", () => {
        const ios = { build: { workspace: "w", scheme: "s", configuration: "Release" as const, productName: "Shop" } };
        expect(builtAppPath(ios, "/dd", "Debug")).toBe("/dd/Build/Products/Debug-iphonesimulator/Shop.app");
    });
});

describe("run folders", () => {
    it("stamps in local time", () => {
        expect(stamp(new Date(2026, 10, 4, 21, 5, 33))).toBe("2026-11-04T21-05-33");
    });
});
