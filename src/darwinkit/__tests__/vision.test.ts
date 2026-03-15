import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { runDarwinKit, runDarwinKitRaw } from "./helpers";

const TEST_IMAGE = "/tmp/darwinkit-ocr-test.png";

beforeAll(async () => {
    // Create test image with text using Swift/AppKit
    const proc = Bun.spawn(
        [
            "swift",
            "-e",
            `
import AppKit
let img = NSImage(size: NSSize(width: 400, height: 100))
img.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 400, height: 100).fill()
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 24), .foregroundColor: NSColor.black]
"Hello DarwinKit OCR Test 2026".draw(at: NSPoint(x: 10, y: 40), withAttributes: attrs)
img.unlockFocus()
let tiff = img.tiffRepresentation!
let rep = NSBitmapImageRep(data: tiff)!
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: "${TEST_IMAGE}"))
    `,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
});

afterAll(async () => {
    try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(TEST_IMAGE);
    } catch {
        // ignore
    }
});

describe("darwinkit vision commands", () => {
    describe("ocr", () => {
        it("extracts text with bounding boxes", async () => {
            const result = await runDarwinKit("ocr", TEST_IMAGE);
            expect(result.text).toBe("Hello DarwinKit OCR Test 2026");
            expect(result.blocks).toBeArray();

            const block = (result.blocks as { text: string; confidence: string }[])[0];
            expect(block.text).toBe("Hello DarwinKit OCR Test 2026");
            expect(Number(block.confidence)).toBeGreaterThan(0.5);
        });

        it("extracts text-only with --text-only", async () => {
            const result = await runDarwinKit("ocr", TEST_IMAGE, "--text-only");
            expect(result).toBe("Hello DarwinKit OCR Test 2026");
        });

        it("works with --level fast", async () => {
            const result = await runDarwinKit("ocr", TEST_IMAGE, "--level", "fast", "--text-only");
            expect(result).toBe("Hello DarwinKit OCR Test 2026");
        });

        it("errors gracefully for nonexistent file", async () => {
            const { exitCode, stderr } = await runDarwinKitRaw("ocr", "/nonexistent.png");
            expect(exitCode).toBe(1);
            expect(stderr).toContain("not found");
        });
    });
});
