import { describe, expect, it } from "bun:test";
import { runDarwinKit } from "./helpers";

describe("darwinkit TTS commands", () => {
    describe("list-voices", () => {
        it("returns array of voice strings", async () => {
            const result = await runDarwinKit("list-voices");
            expect(result).toBeArray();
            expect(result.length).toBeGreaterThan(0);
            expect(typeof result[0]).toBe("string");
        });
    });

    describe("speak", () => {
        it("speaks text and returns confirmation", async () => {
            const result = await runDarwinKit("speak", "test");
            expect(result.spoken).toBe(true);
        });

        it("speaks with --rate flag", async () => {
            const result = await runDarwinKit("speak", "fast", "--rate", "400");
            expect(result.spoken).toBe(true);
        });
    });
});

describe("darwinkit auth commands", () => {
    describe("check-biometry", () => {
        it("returns availability and type", async () => {
            const result = await runDarwinKit("check-biometry");
            expect(result).toHaveProperty("available");
            expect(typeof result.available).toBe("boolean");

            if (result.available) {
                expect(result.biometry_type).toBeDefined();
            }
        });
    });
});

describe("darwinkit system commands", () => {
    describe("capabilities", () => {
        it("returns version, OS, arch, and methods", async () => {
            const result = await runDarwinKit("capabilities");
            expect(result.version).toBeDefined();
            expect(result.os).toBeDefined();
            expect(result.arch).toBe("arm64");
            expect(result.methods).toBeDefined();

            const methods = result.methods as Record<string, { available: boolean }>;
            expect(methods["nlp.language"]).toBeDefined();
            expect(methods["nlp.language"].available).toBe(true);
            expect(methods["vision.ocr"]).toBeDefined();
            expect(methods["vision.ocr"].available).toBe(true);
        });
    });
});
