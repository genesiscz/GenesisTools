import { describe, expect, it } from "bun:test";
import { hostAppBundle, isDeveloperToolAllowed } from "@app/doctor/analyzers/security";

describe("Developer Tools check", () => {
    it("takes the outermost app up the process tree, not an app executable run as a CLI inside it", () => {
        const tree = [
            "/Users/example/Applications/GenesisTools.app/Contents/MacOS/GenesisTools",
            "/bin/zsh",
            "/Users/example/.bun/bin/bun",
            "/Applications/cmux.app/Contents/MacOS/cmux",
            "/sbin/launchd",
        ];
        expect(hostAppBundle(tree)).toBe("/Applications/cmux.app");
    });

    it("reads an editor app and gives nothing outside any app", () => {
        expect(hostAppBundle(["/Applications/Cursor.app/Contents/MacOS/Cursor"])).toBe("/Applications/Cursor.app");
        expect(hostAppBundle(["/bin/zsh", "/sbin/launchd"])).toBeNull();
    });

    it("allows only an allowed row for the same bundle id", () => {
        const rows = [
            { client: "com.apple.Terminal", auth_value: 2 },
            { client: "com.example.denied", auth_value: 0 },
        ];
        expect(isDeveloperToolAllowed(rows, "com.apple.Terminal")).toBe(true);
        expect(isDeveloperToolAllowed(rows, "com.example.denied")).toBe(false);
        expect(isDeveloperToolAllowed(rows, "com.cmuxterm.app")).toBe(false);
    });
});
