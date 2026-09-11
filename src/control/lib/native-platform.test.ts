import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = readFileSync(join(import.meta.dir, "../../../native/ax-tool/Package.swift"), "utf8");

// CGWindowListCreateImage is SCREEN_CAPTURE_OBSOLETE(10.5,14.0,15.0): it leaves the SDK the moment
// the deployment target reaches 15, and it is the only screenshot path ax-tool has. Raising the
// target without a ScreenCaptureKit path would remove every screenshot silently.
test("the native deployment target stays on macOS 13 while CGWindowListCreateImage is the screenshot path", () => {
    expect(manifest).toContain("platforms: [.macOS(.v13)]");
    expect(manifest).toContain("SCREEN_CAPTURE_OBSOLETE");
});
