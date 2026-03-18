import { describe, expect, test } from "bun:test";
import {
    createLanguageDetector,
    DarwinKitTextDriver,
    LanguageDetector,
    MmsLidDriver,
    WhisperLanguageDriver,
} from "./LanguageDetector";

// ============================================
// To run audio tests, set this to a real audio file path:
// TEST_AUDIO_FILE=/path/to/czech-audio.m4a bun test src/utils/ai/LanguageDetector.test.ts
// ============================================
const TEST_AUDIO_FILE = process.env.TEST_AUDIO_FILE;

describe("LanguageDetector", () => {
    describe("text detection (DarwinKit)", () => {
        const driver = new DarwinKitTextDriver();

        test("detects Czech text", async () => {
            if (!(await driver.isAvailable())) {
                return; // Skip on non-macOS
            }

            const result = await driver.detectFromText("Ahoj, jak se máš? Dnes je hezky venku.");
            expect(result.language).toBe("cs");
            expect(result.confidence).toBeGreaterThan(0.9);
            expect(result.driver).toBe("darwinkit");
        });

        test("detects English text", async () => {
            if (!(await driver.isAvailable())) {
                return;
            }

            const result = await driver.detectFromText("Hello, how are you today? The weather is nice.");
            expect(result.language).toBe("en");
            expect(result.confidence).toBeGreaterThan(0.9);
        });

        test("detects German text", async () => {
            if (!(await driver.isAvailable())) {
                return;
            }

            const result = await driver.detectFromText("Hallo, wie geht es Ihnen? Das Wetter ist schön.");
            expect(result.language).toBe("de");
            expect(result.confidence).toBeGreaterThan(0.9);
        });
    });

    describe("factory", () => {
        test("createLanguageDetector returns configured instance", () => {
            const detector = createLanguageDetector();
            expect(detector).toBeInstanceOf(LanguageDetector);
        });

        test("accepts custom whisper model", () => {
            const detector = createLanguageDetector({ whisperModel: "onnx-community/whisper-tiny" });
            expect(detector).toBeInstanceOf(LanguageDetector);
        });

        test("accepts mms-lid driver by name", () => {
            const detector = createLanguageDetector({ audioDrivers: ["mms-lid"] });
            expect(detector).toBeInstanceOf(LanguageDetector);
        });

        test("accepts custom driver objects", () => {
            const custom: import("./LanguageDetector").LanguageDetectionDriver = {
                name: "custom",
                isAvailable: async () => true,
                detectFromAudio: async () => ({ language: "cs", confidence: 1, driver: "custom" }),
            };
            const detector = createLanguageDetector({ audioDrivers: [custom] });
            expect(detector).toBeInstanceOf(LanguageDetector);
        });

        test("accepts empty driver arrays → fallback", async () => {
            const detector = createLanguageDetector({ audioDrivers: [], textDrivers: [] });
            const result = await detector.detectFromText("test");
            expect(result.driver).toBe("fallback");
        });
    });

    describe("fallback behavior", () => {
        test("returns English fallback when no drivers available", async () => {
            const detector = new LanguageDetector();
            const result = await detector.detectFromText("anything");
            expect(result.language).toBe("en");
            expect(result.confidence).toBe(0);
            expect(result.driver).toBe("fallback");
        });

        test("returns English fallback for audio when no drivers available", async () => {
            const detector = new LanguageDetector();
            const result = await detector.detectFromAudio(new Float32Array(16000));
            expect(result.language).toBe("en");
            expect(result.confidence).toBe(0);
        });
    });

    describe("driver chaining", () => {
        test("skips unavailable driver and tries next", async () => {
            const failDriver: import("./LanguageDetector").TextLanguageDetectionDriver = {
                name: "fail",
                isAvailable: async () => false,
                detectFromText: async () => ({ language: "xx", confidence: 1, driver: "fail" }),
            };
            const okDriver: import("./LanguageDetector").TextLanguageDetectionDriver = {
                name: "ok",
                isAvailable: async () => true,
                detectFromText: async () => ({ language: "cs", confidence: 0.99, driver: "ok" }),
            };

            const detector = new LanguageDetector();
            detector.registerTextDriver(failDriver);
            detector.registerTextDriver(okDriver);

            const result = await detector.detectFromText("test");
            expect(result.driver).toBe("ok");
            expect(result.language).toBe("cs");
        });

        test("skips erroring driver and tries next", async () => {
            const errorDriver: import("./LanguageDetector").TextLanguageDetectionDriver = {
                name: "error",
                isAvailable: async () => true,
                detectFromText: async () => {
                    throw new Error("boom");
                },
            };
            const okDriver: import("./LanguageDetector").TextLanguageDetectionDriver = {
                name: "ok",
                isAvailable: async () => true,
                detectFromText: async () => ({ language: "de", confidence: 0.95, driver: "ok" }),
            };

            const detector = new LanguageDetector();
            detector.registerTextDriver(errorDriver);
            detector.registerTextDriver(okDriver);

            const result = await detector.detectFromText("test");
            expect(result.language).toBe("de");
        });
    });

    // Audio detection tests — only run with TEST_AUDIO_FILE env var
    describe.skipIf(!TEST_AUDIO_FILE)("audio detection (requires TEST_AUDIO_FILE env)", () => {
        test("WhisperLanguageDriver detects language", async () => {
            const driver = new WhisperLanguageDriver("onnx-community/whisper-tiny");
            const { readFileSync } = await import("node:fs");
            const { toFloat32Audio } = await import("@app/utils/audio/converter");

            const audio = readFileSync(TEST_AUDIO_FILE!);
            const float32 = await toFloat32Audio(audio);

            const result = await driver.detectFromAudio(float32);
            console.log("Whisper detected:", result);
            expect(result.driver).toBe("whisper");
            expect(result.language).toBeTruthy();

            driver.dispose();
        }, 120_000);

        test("MmsLidDriver detects Czech", async () => {
            const driver = new MmsLidDriver();
            const { readFileSync } = await import("node:fs");
            const { toFloat32Audio } = await import("@app/utils/audio/converter");

            const audio = readFileSync(TEST_AUDIO_FILE!);
            const float32 = await toFloat32Audio(audio);

            const result = await driver.detectFromAudio(float32);
            console.log("MMS-LID detected:", result);
            expect(result.driver).toBe("mms-lid");
            expect(result.confidence).toBeGreaterThan(0.5);

            driver.dispose();
        }, 120_000);

        test("full LanguageDetector pipeline", async () => {
            const detector = createLanguageDetector();
            const { readFileSync } = await import("node:fs");

            const audio = readFileSync(TEST_AUDIO_FILE!);
            const result = await detector.detectFromAudio(audio);
            console.log("LanguageDetector detected:", result);
            expect(result.language).toBeTruthy();
            expect(result.confidence).toBeGreaterThan(0);

            detector.dispose();
        }, 120_000);
    });
});
