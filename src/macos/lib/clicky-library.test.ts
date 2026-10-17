import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import * as commands from "@genesiscz/utils/process/bounded-command";
import {
    archiveClickyLibrary,
    CLICKY_PACKED_SAMPLES,
    ClickyLibraryUnavailableError,
    ensureClickyLibrary,
    packClickyLibrary,
    unpackClickyLibrary,
    wavHeader,
    wavPCM,
} from "./clicky-library";

const hasTools = Boolean(Bun.which("flac")) && Boolean(Bun.which("afconvert"));
const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A decaying click: a short sine burst, `frames` long. */
function click(frames: number, hz: number): Buffer {
    const pcm = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
        const value = Math.sin((2 * Math.PI * hz * i) / 48_000) * Math.exp(-i / 400) * 20_000;
        pcm.writeInt16LE(Math.round(value), i * 2);
    }

    return Buffer.concat([wavHeader(pcm.length), pcm]);
}

function library(): string {
    const root = mkdtempSync(join(tmpdir(), "gt-clicky-lib-"));
    dirs.push(root);
    const files = [
        { filename: "press-01.wav", wav: click(2400, 1800) },
        { filename: "release-01.wav", wav: click(1300, 2600) },
    ];
    mkdirSync(join(root, "demo-set"));
    for (const file of files) {
        writeFileSync(join(root, "demo-set", file.filename), file.wav);
    }

    const manifest = {
        id: "demo-set",
        files: files.map((file) => ({
            filename: file.filename,
            sha256: createHash("sha256").update(file.wav).digest("hex"),
            frames: (file.wav.length - 44) / 2,
        })),
    };
    writeFileSync(join(root, "demo-set", "manifest.json"), SafeJSON.stringify(manifest));
    writeFileSync(join(root, "demo-set", "LICENCE.txt"), "Invented test sounds.\n");
    writeFileSync(join(root, "registry.json"), SafeJSON.stringify({ formatVersion: 1, sets: [{ id: "demo-set" }] }));
    return root;
}

describe("Clicky library packing", () => {
    it("downloads the pinned archive once, checks it and caches it", async () => {
        const parent = mkdtempSync(join(tmpdir(), "gt-clicky-release-"));
        const cacheRoot = mkdtempSync(join(tmpdir(), "gt-clicky-cache-"));
        dirs.push(parent, cacheRoot);
        mkdirSync(join(parent, "ClickyLibrary"));
        writeFileSync(
            join(parent, "ClickyLibrary", "registry.json"),
            SafeJSON.stringify({ formatVersion: 1, sets: [] })
        );
        const archive = join(parent, "clicky-library-test.tar.gz");
        const inheritedEnv = spyOn(env, "getProcessEnv");
        const pin = await (async () => {
            try {
                const pin = await archiveClickyLibrary(join(parent, "ClickyLibrary"), archive, "clicky-library-test");
                expect(inheritedEnv).toHaveBeenCalledTimes(1);
                return pin;
            } finally {
                inheritedEnv.mockRestore();
            }
        })();
        expect(pin.url).toBe(
            "https://github.com/genesiscz/GenesisTools/releases/download/clicky-library-test/clicky-library-test.tar.gz"
        );
        let calls = 0;
        const fetchImpl = async () => {
            calls++;
            return new Response(readFileSync(archive));
        };

        const library = await ensureClickyLibrary(pin, { cacheRoot, fetchImpl });
        expect(existsSync(join(library, "registry.json"))).toBe(true);
        await ensureClickyLibrary(pin, { cacheRoot, fetchImpl });
        expect(calls).toBe(1);
    });

    it("bounds a stalled extractor and removes its staging folder", async () => {
        const cacheRoot = mkdtempSync(join(tmpdir(), "gt-clicky-extract-timeout-"));
        dirs.push(cacheRoot);
        const bytes = Buffer.from("fixture archive");
        const pin = {
            release: "fixture",
            url: "https://invalid/fixture.tar.gz",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            sets: 0,
            samples: 0,
        };
        const bounded = commands.boundedCommand;
        const runner = spyOn(commands, "boundedCommand").mockImplementation(async (options) => {
            expect(options.command[0]).toBe("tar");
            expect(options.timeoutMs).toBe(120_000);
            const result = await bounded({
                command: [process.execPath, "-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 1000);'],
                timeoutMs: 30,
            });
            expect(result.error?.code).toBe("ETIMEDOUT");
            return result;
        });
        try {
            await expect(
                ensureClickyLibrary(pin, { cacheRoot, fetchImpl: async () => new Response(bytes) })
            ).rejects.toThrow("tar timed out after 120000 ms");
            expect(runner).toHaveBeenCalledTimes(1);
            expect(readdirSync(cacheRoot)).toEqual([]);
        } finally {
            runner.mockRestore();
        }
    });

    it("refuses an archive that does not match its pin", async () => {
        const cacheRoot = mkdtempSync(join(tmpdir(), "gt-clicky-cache-"));
        dirs.push(cacheRoot);
        const pin = {
            release: "x",
            url: "https://invalid/x.tar.gz",
            sha256: "0".repeat(64),
            bytes: 3,
            sets: 0,
            samples: 0,
        };
        const fetchImpl = async () => new Response(Buffer.from("abc"));
        await expect(ensureClickyLibrary(pin, { cacheRoot, fetchImpl })).rejects.toThrow("the pin says");
        expect(existsSync(join(cacheRoot, "0".repeat(16)))).toBe(false);
    });

    it("classifies only transport, HTTP and response-stream failures as unavailable", async () => {
        const cacheRoot = mkdtempSync(join(tmpdir(), "gt-clicky-offline-"));
        dirs.push(cacheRoot);
        const pin = {
            release: "fixture",
            url: "https://example.invalid/library",
            sha256: "0".repeat(64),
            bytes: 3,
            sets: 0,
            samples: 0,
        };
        const downloads = [
            async (): Promise<Response> => {
                throw new Error("offline");
            },
            async () => new Response("unavailable", { status: 503 }),
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.error(new Error("disconnected"));
                        },
                    })
                ),
        ];
        for (const fetchImpl of downloads) {
            await expect(ensureClickyLibrary(pin, { cacheRoot, fetchImpl })).rejects.toBeInstanceOf(
                ClickyLibraryUnavailableError
            );
        }
        await expect(
            ensureClickyLibrary(pin, { cacheRoot, fetchImpl: async () => new Response("abc") })
        ).rejects.not.toBeInstanceOf(ClickyLibraryUnavailableError);
    });

    it.each(["headers", "body"])("bounds stalled %s and aborts the download", async (phase) => {
        const cacheRoot = mkdtempSync(join(tmpdir(), "gt-clicky-deadline-"));
        dirs.push(cacheRoot);
        const pin = {
            release: "fixture",
            url: "https://example.invalid/library",
            sha256: "0".repeat(64),
            bytes: 3,
            sets: 0,
            samples: 0,
        };
        let aborted = false;
        const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
            const signal = init?.signal;
            expect(signal).toBeInstanceOf(AbortSignal);
            signal?.addEventListener(
                "abort",
                () => {
                    aborted = true;
                },
                { once: true }
            );
            if (phase === "headers") {
                return new Promise(() => {});
            }
            return Promise.resolve(
                new Response(
                    new ReadableStream({
                        start(controller) {
                            signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
                        },
                    })
                )
            );
        };
        await expect(ensureClickyLibrary(pin, { cacheRoot, fetchImpl, downloadTimeoutMs: 20 })).rejects.toBeInstanceOf(
            ClickyLibraryUnavailableError
        );
        expect(aborted).toBe(true);
        expect(existsSync(join(cacheRoot, pin.sha256.slice(0, 16)))).toBe(false);
    });

    it("rejects an invalid pin before attempting a download", async () => {
        const pin = {
            release: "fixture",
            url: "https://example.invalid/library",
            sha256: "0".repeat(64),
            bytes: 3,
            sets: 0,
            samples: 0,
        };
        let calls = 0;
        const fetchImpl = async (): Promise<Response> => {
            calls++;
            throw new Error("offline");
        };
        for (const invalid of [
            { ...pin, sha256: "bad" },
            { ...pin, url: "not a URL" },
            { ...pin, bytes: -1 },
        ]) {
            await expect(ensureClickyLibrary(invalid, { fetchImpl })).rejects.not.toBeInstanceOf(
                ClickyLibraryUnavailableError
            );
        }
        expect(calls).toBe(0);
    });

    it("reads the PCM past extra chunks", () => {
        const pcm = Buffer.from([1, 0, 2, 0]);
        const padded = Buffer.concat([
            Buffer.from("RIFF\0\0\0\0WAVE", "latin1"),
            wavHeader(0).subarray(12, 36),
            Buffer.from("FLLR\x04\0\0\0\0\0\0\0", "latin1"),
            Buffer.from("data\x04\0\0\0", "latin1"),
            pcm,
        ]);
        expect(wavPCM(padded, "padded")).toEqual(pcm);
    });

    it.skipIf(!hasTools)("packs a set into one FLAC and unpacks byte-identical WAVs", async () => {
        const source = library();
        const packed = mkdtempSync(join(tmpdir(), "gt-clicky-packed-"));
        const unpacked = mkdtempSync(join(tmpdir(), "gt-clicky-unpacked-"));
        dirs.push(packed, unpacked);

        const result = await packClickyLibrary(source, packed);
        expect(result.sets).toBe(1);
        expect(readFileSync(join(packed, "demo-set", CLICKY_PACKED_SAMPLES)).length).toBeGreaterThan(0);
        expect(readFileSync(join(packed, "demo-set", "LICENCE.txt"), "utf8")).toBe("Invented test sounds.\n");

        expect(await unpackClickyLibrary(packed, unpacked)).toEqual({ sets: 1, samples: 2 });
        for (const name of ["press-01.wav", "release-01.wav"]) {
            expect(readFileSync(join(unpacked, "demo-set", name))).toEqual(
                readFileSync(join(source, "demo-set", name))
            );
        }
    });

    it.skipIf(!hasTools)("refuses to unpack a sample that differs from its manifest", async () => {
        const source = library();
        const packed = mkdtempSync(join(tmpdir(), "gt-clicky-packed-"));
        dirs.push(packed);
        await packClickyLibrary(source, packed);
        const manifestPath = join(packed, "demo-set", "manifest.json");
        const manifest = SafeJSON.parse(readFileSync(manifestPath, "utf8"), { strict: true }) as {
            files: { sha256: string }[];
        };
        manifest.files[0].sha256 = "0".repeat(64);
        writeFileSync(manifestPath, SafeJSON.stringify(manifest));

        const bad = mkdtempSync(join(tmpdir(), "gt-clicky-bad-"));
        dirs.push(bad);
        await expect(unpackClickyLibrary(packed, bad)).rejects.toThrow("does not match the manifest's SHA-256");
    });
});
