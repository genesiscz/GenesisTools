import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import * as apfs from "@genesiscz/utils/macos/apfs";
import { getCloneId } from "@genesiscz/utils/macos/apfs";
import * as commands from "@genesiscz/utils/process/bounded-command";
import * as processes from "@genesiscz/utils/process/processes";
import * as prompts from "@genesiscz/utils/prompts/p";
import { withFileLock } from "@genesiscz/utils/storage";
import { skip } from "@genesiscz/utils/test/skip";
import { ClickyLibraryUnavailableError, ensureClickyLibrary, unpackClickyLibrary } from "../clicky-library";
import {
    bundleClickyLibrary,
    downloadClickyLibrary,
    offerCodesignTrust,
    pinnedRetiredBundles,
    readAppFaceProcesses,
    readRunningExecutableInodes,
    requireAppBuildSdk,
    retiredStampsToShare,
    runningExecutableInodes,
    runStreaming,
    shareRetiredResources,
    sourceHash,
    sourceRootsFor,
    stampAppToolsPath,
} from "./app";
import {
    type BuildOfferDeps,
    createRealBuildOfferDeps,
    DECLINE_COOLDOWN_MS,
    isGatedInvocation,
    maybeOfferGenesisAppBuild,
    readOfferStateFrom,
    shouldAsk,
    writeOfferStateTo,
} from "./build-offer";
import { shareBundleResources } from "./bundle-resources";
import {
    createBuildProgressDisplay,
    createSwiftProgressReporter,
    formatSwiftBuildProgress,
    PLAIN_PROGRESS_EVERY_MS,
    parseSwiftBuildProgress,
} from "./swift-progress";

describe("readAppFaceProcesses", () => {
    it("lists the faces oldest first, so they start again in the order they first started", () => {
        const entry = (pid: number, startMs: number | null) => ({
            pid,
            ppid: 1,
            pgid: null,
            uid: null,
            name: "GenesisTools",
            command: `/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --face ${pid}`,
            tty: null,
            startMs,
            zombie: false,
            state: "S",
        });
        // The kernel table lists the newest pid first.
        const list = spyOn(processes, "listProcesses").mockReturnValue([
            entry(33602, 2_000),
            entry(33573, 1_000),
            entry(40000, null),
            entry(33590, 1_000),
        ]);

        try {
            expect(readAppFaceProcesses().map((process) => process.pid)).toEqual([33573, 33590, 33602, 40000]);
        } finally {
            list.mockRestore();
        }
    });
});

describe("downloadClickyLibrary", () => {
    function writePack(out: string) {
        mkdirSync(join(out, "fixture"), { recursive: true });
        writeFileSync(join(out, "fixture", "LICENCE.txt"), "Fixture licence.\n");
        writeFileSync(join(out, "registry.json"), SafeJSON.stringify({ sets: [{ id: "fixture" }] }));
        const bytes = Buffer.from("fixture sample");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        writeFileSync(
            join(out, "fixture", "manifest.json"),
            SafeJSON.stringify({
                files: ["a.wav", "b.wav"].map((filename) => ({ filename, sha256 })),
            })
        );
        for (const name of ["a.wav", "b.wav"]) {
            writeFileSync(join(out, "fixture", name), bytes);
        }
    }

    it("rebuilds an interrupted cache and a cache missing a sample", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-clicky-incomplete-"));
        try {
            const pinPath = join(root, "pin.json");
            writeFileSync(
                pinPath,
                SafeJSON.stringify({ release: "fixture", sha256: "c".repeat(64), sets: 1, samples: 2 })
            );
            const out = join(root, "c".repeat(16), "GenesisTools sounds");
            mkdirSync(out, { recursive: true });
            writeFileSync(join(out, "registry.json"), "{}");
            let unpacks = 0;
            const options = {
                pinPath,
                root,
                ensure: async () => "packed",
                unpack: async (_source: string, staging: string) => {
                    expect(staging).not.toBe(out);
                    unpacks++;
                    writePack(staging);
                    return { sets: 1, samples: 2 };
                },
            };
            expect((await downloadClickyLibrary(options)).reused).toBe(false);
            rmSync(join(out, "fixture", "b.wav"));
            expect((await downloadClickyLibrary(options)).reused).toBe(false);
            expect(unpacks).toBe(2);
            const licence = join(out, "fixture", "LICENCE.txt");
            const damage = [
                undefined,
                Buffer.alloc(0),
                Buffer.from(" \n\t"),
                Buffer.from([0xff]),
                Buffer.from("licence\0"),
                Buffer.alloc(256 * 1024 + 1, 65),
            ];
            for (const [index, bytes] of damage.entries()) {
                if (bytes === undefined) {
                    rmSync(licence);
                } else {
                    writeFileSync(licence, bytes);
                }

                expect((await downloadClickyLibrary(options)).reused).toBe(false);
                expect(unpacks).toBe(3 + index);
                expect(readFileSync(licence, "utf8")).toBe("Fixture licence.\n");
            }

            expect((await downloadClickyLibrary(options)).reused).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("a stalled decoder releases the download lock and removes unpack staging", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-clicky-decoder-timeout-"));
        const pinPath = join(root, "pin.json");
        const sha256 = "e".repeat(64);
        writeFileSync(pinPath, SafeJSON.stringify({ release: "fixture", sha256, sets: 1, samples: 2 }));
        const source = join(root, "packed");
        writePack(source);
        let decoded: string | undefined;
        const bounded = commands.boundedCommand;
        const runner = spyOn(commands, "boundedCommand").mockImplementation(async (options) => {
            expect(options.command[0]).toBe("afconvert");
            decoded = options.command.at(-1);
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
                downloadClickyLibrary({
                    pinPath,
                    root,
                    ensure: async () => source,
                    unpack: unpackClickyLibrary,
                })
            ).rejects.toThrow("afconvert timed out after 120000 ms");
            expect(runner).toHaveBeenCalledTimes(1);
            expect(readdirSync(root).filter((name) => name.startsWith(".unpack-"))).toEqual([]);
            expect(existsSync(join(root, sha256.slice(0, 16), "GenesisTools sounds"))).toBe(false);
            expect(decoded).toBeDefined();
            if (decoded) {
                expect(existsSync(dirname(decoded))).toBe(false);
            }
            expect(await withFileLock(join(root, `${sha256}.lock`), async () => "released", 100)).toBe("released");
        } finally {
            runner.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("cleans failed unpacking and serializes concurrent downloads before publishing", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-clicky-publish-"));
        try {
            const pinPath = join(root, "pin.json");
            writeFileSync(
                pinPath,
                SafeJSON.stringify({ release: "fixture", sha256: "d".repeat(64), sets: 1, samples: 2 })
            );
            const out = join(root, "d".repeat(16), "GenesisTools sounds");
            const ensure = async () => "packed";
            await expect(
                downloadClickyLibrary({
                    pinPath,
                    root,
                    ensure,
                    unpack: async (_source, staging) => {
                        writePack(staging);
                        throw new Error("decode failed");
                    },
                })
            ).rejects.toThrow("decode failed");
            expect(existsSync(out)).toBe(false);
            expect(readdirSync(root).filter((name) => name.startsWith(".unpack-"))).toEqual([]);
            let unpacks = 0;
            const options = {
                pinPath,
                root,
                ensure,
                unpack: async (_source: string, staging: string) => {
                    unpacks++;
                    writePack(staging);
                    expect(existsSync(out)).toBe(false);
                    await Bun.sleep(10);
                    return { sets: 1, samples: 2 };
                },
            };
            const results = await Promise.all([downloadClickyLibrary(options), downloadClickyLibrary(options)]);
            expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
            expect(unpacks).toBe(1);
            expect(existsSync(join(out, "fixture", "b.wav"))).toBe(true);
            expect(readdirSync(root).filter((name) => name.startsWith(".unpack-"))).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("unpacks the pinned pack outside the bundle once, then reuses the folder", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-clicky-download-"));
        try {
            const pinPath = join(root, "pin.json");
            writeFileSync(
                pinPath,
                SafeJSON.stringify({ release: "fixture", sha256: "a".repeat(64), sets: 1, samples: 2 })
            );
            let downloads = 0;
            const unpack = async (_source: string, out: string) => {
                writePack(out);
                return { sets: 1, samples: 2 };
            };
            const ensure = async () => {
                downloads++;
                return "packed";
            };
            const first = await downloadClickyLibrary({ pinPath, root, ensure, unpack });
            const second = await downloadClickyLibrary({ pinPath, root, ensure, unpack });
            expect(first).toEqual({ path: join(root, "aaaaaaaaaaaaaaaa", "GenesisTools sounds"), reused: false });
            expect(second).toEqual({ path: first.path, reused: true });
            expect(downloads).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("removes a pack whose counts do not match the pin", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-clicky-download-bad-"));
        try {
            const pinPath = join(root, "pin.json");
            writeFileSync(
                pinPath,
                SafeJSON.stringify({ release: "fixture", sha256: "b".repeat(64), sets: 2, samples: 2 })
            );
            const result = downloadClickyLibrary({
                pinPath,
                root,
                ensure: async () => "packed",
                unpack: async (_source, out) => {
                    mkdirSync(out, { recursive: true });
                    return { sets: 1, samples: 2 };
                },
            });
            await expect(result).rejects.toThrow("count mismatch");
            expect(existsSync(join(root, "bbbbbbbbbbbbbbbb", "GenesisTools sounds"))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("bundleClickyLibrary", () => {
    // Clicky is a staging face: a normal install downloaded its 10 MB library on every first build for nothing.
    it("downloads nothing while Clicky's staging switch is off", async () => {
        const steps: string[] = [];
        let ensured = false;
        await bundleClickyLibrary({
            contents: join(tmpdir(), "gt-clicky-off-never-written"),
            pinPath: "/never/read.json",
            step: (message) => steps.push(message),
            wanted: () => false,
            ensure: async () => {
                ensured = true;
                throw new Error("must not download");
            },
        });
        expect(ensured).toBe(false);
        expect(steps).toEqual([expect.stringContaining("Clicky sound library skipped")]);
    });

    it.each([
        { sets: 1, samples: 0 },
        { sets: 0, samples: 1 },
    ])("rejects an incomplete cached catalogue against pin %j", async (counts) => {
        const contents = mkdtempSync(join(tmpdir(), "gt-clicky-counts-"));
        try {
            const pin = {
                release: "fixture",
                url: "https://example.invalid/library",
                sha256: "0".repeat(64),
                bytes: 3,
                ...counts,
            };
            const pinPath = join(contents, "pin.json");
            writeFileSync(pinPath, SafeJSON.stringify(pin));
            const cacheRoot = join(contents, "cache");
            const source = join(cacheRoot, pin.sha256.slice(0, 16), "ClickyLibrary");
            mkdirSync(source, { recursive: true });
            writeFileSync(join(source, "registry.json"), SafeJSON.stringify({ sets: [] }));
            const steps: string[] = [];
            await expect(
                bundleClickyLibrary({
                    contents,
                    pinPath,
                    step: (message) => steps.push(message),
                    ensure: (value) => ensureClickyLibrary(value, { cacheRoot }),
                    wanted: () => true,
                })
            ).rejects.toThrow(`Remove the cached library at ${source} and rebuild`);
            expect(existsSync(join(contents, "Resources", "ClickyLibrary"))).toBe(false);
            expect(steps.some((message) => message.includes("skipped"))).toBe(false);
        } finally {
            rmSync(contents, { recursive: true, force: true });
        }
    });

    it.each(["offline", "archive", "sample", "pin", "success"])(
        "handles %s without masking integrity failures",
        async (mode) => {
            const contents = mkdtempSync(join(tmpdir(), "gt-clicky-bundle-"));
            try {
                const pinPath = join(contents, "pin.json");
                writeFileSync(
                    pinPath,
                    mode === "pin" ? "{broken" : SafeJSON.stringify({ release: "fixture", sets: 1, samples: 1 })
                );
                const out = join(contents, "Resources", "ClickyLibrary");
                mkdirSync(out, { recursive: true });
                const failure = mode === "offline" ? new ClickyLibraryUnavailableError("offline") : new Error(mode);
                const steps: string[] = [];
                let ensured = false;
                let unpacked = false;
                const result = bundleClickyLibrary({
                    contents,
                    pinPath,
                    wanted: () => true,
                    step: (message) => steps.push(message),
                    ensure: async () => {
                        ensured = true;
                        if (mode === "offline" || mode === "archive") {
                            throw failure;
                        }
                        return "verified-library";
                    },
                    unpack: async (source, destination) => {
                        unpacked = true;
                        expect(source).toBe("verified-library");
                        expect(destination).toBe(out);
                        if (mode === "sample") {
                            throw failure;
                        }
                        return { sets: 1, samples: 1 };
                    },
                });
                if (mode === "offline" || mode === "success") {
                    await result;
                } else if (mode === "pin") {
                    await expect(result).rejects.toThrow();
                } else {
                    await expect(result).rejects.toBe(failure);
                }
                expect(ensured).toBe(mode !== "pin");
                expect(unpacked).toBe(mode === "sample" || mode === "success");
                expect(steps.some((message) => message.includes("skipped"))).toBe(mode === "offline");
                expect(existsSync(out)).toBe(mode !== "offline");
            } finally {
                rmSync(contents, { recursive: true, force: true });
            }
        }
    );
});

describe("stampAppToolsPath", () => {
    it("records the actual build checkout as XML text without changing template values", () => {
        const template = "<plist><dict><key>Existing</key><string>unchanged</string></dict></plist>";
        const stamped = stampAppToolsPath(template, "/fixture/space & <branch>/tools");
        expect(stamped).toContain("<key>GenesisToolsSourceToolsPath</key>");
        expect(stamped).toContain("/fixture/space &amp; &lt;branch&gt;/tools");
        expect(stamped).toContain("<key>Existing</key><string>unchanged</string>");
    });

    it("refuses duplicate origin keys, malformed plists and relative executables", () => {
        expect(() => stampAppToolsPath("<plist></plist>", "/fixture/tools")).toThrow("Cannot stamp");
        expect(() => stampAppToolsPath("<plist><dict></dict></plist>", "tools")).toThrow("Cannot stamp");
        const stamped = stampAppToolsPath("<plist><dict></dict></plist>", "/fixture/tools");
        expect(() => stampAppToolsPath(stamped, "/another/tools")).toThrow("Cannot stamp");
    });
});

describe("offerCodesignTrust", () => {
    it("defaults the keychain-wide trust question to No, and a decline only records the answer", async () => {
        const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
        const steps: string[] = [];

        try {
            await offerCodesignTrust((message) => steps.push(message));
            expect(confirm).toHaveBeenCalledTimes(1);
            expect(confirm.mock.calls[0]?.[0].initialValue).toBe(false);
            expect(steps).toEqual([expect.stringContaining("codesign trust declined")]);
        } finally {
            confirm.mockRestore();
        }
    });
});

describe("runningExecutableInodes", () => {
    it("collects the executable inode of every process, once each", () => {
        const inodes = new Map([
            [101, 596381987],
            [102, 42],
            [103, 596381987],
        ]);

        expect(runningExecutableInodes([101, 102, 103], (pid) => inodes.get(pid) ?? null)).toEqual(
            new Set([596381987, 42])
        );
    });

    it("skips a process whose executable cannot be read, such as kernel_task or a binary an upgrade deleted", () => {
        expect(runningExecutableInodes([0, 101], (pid) => (pid === 101 ? 42 : null))).toEqual(new Set([42]));
    });

    it("keeps every retired bundle when no process could be read", () => {
        expect(runningExecutableInodes([], () => 42)).toBeNull();
        expect(runningExecutableInodes([0, 101], () => null)).toBeNull();
    });

    it.skipIf(process.platform !== "darwin")("reads this machine, including the binary running this test", () => {
        expect(readRunningExecutableInodes()?.has(statSync(process.execPath).ino)).toBe(true);
    });
});

describe("requireAppBuildSdk", () => {
    it("builds with Xcode's own SDK when the full Xcode toolchain is active", () => {
        expect(requireAppBuildSdk({ kind: "xcode" })).toEqual({});
    });

    it("builds with the Command Line Tools SDK that passed the probe (#564)", () => {
        const sdkRoot = "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk";

        expect(requireAppBuildSdk({ kind: "command-line-tools", sdkRoot })).toEqual({ sdkRoot });
    });

    it("refuses with the Xcode-install hint when no SDK can build, instead of letting swift build dump errors", () => {
        expect(() =>
            requireAppBuildSdk({
                kind: "unsupported",
                toolchain: { kind: "command-line-tools", developerDir: "/Library/Developer/CommandLineTools" },
            })
        ).toThrow("GenesisTools.app needs the full Xcode");
    });

    it("refuses the same way when xcode-select names no toolchain at all", () => {
        expect(() => requireAppBuildSdk({ kind: "unsupported", toolchain: { kind: "none" } })).toThrow(
            "GenesisTools.app needs the full Xcode"
        );
    });
});

describe("pinnedRetiredBundles", () => {
    const inodes: Record<string, number | null> = { "100": 1, "200": 2, "300": 3, "400": null, "500": 5 };
    const inodeOf = (entry: string) => inodes[entry] ?? null;

    it("pins every bundle a running process executes, and nothing else (the newest are kept by retention)", () => {
        const pinned = pinnedRetiredBundles({ entries: ["100", "200", "300", "500"], inodeOf, running: new Set([2]) });

        expect([...pinned].sort()).toEqual(["200"]);
    });

    it("pins a bundle whose binary it cannot stat", () => {
        const pinned = pinnedRetiredBundles({ entries: ["100", "400", "500"], inodeOf, running: new Set() });

        expect([...pinned].sort()).toEqual(["400"]);
    });
});

describe("isGatedInvocation", () => {
    it("gates a control command that drives the UI", () => {
        expect(isGatedInvocation("control", ["see", "--app", "Finder"])).toBe(true);
    });

    // Regression test: Fable judge J1 — a diagnostic or a help page must never prompt or write the cooldown file.
    it.each([["doctor"], ["audit"], ["--help"], ["-h"], ["help"]])("does not gate control %s", (arg) => {
        expect(isGatedInvocation("control", [arg])).toBe(false);
    });

    it("does not gate --help after a control subcommand", () => {
        expect(isGatedInvocation("control", ["see", "--help"])).toBe(false);
    });

    // Regression test: PR #456 review round 2 — reading a README is documentation, like --help,
    // and must never prompt for a build or write the cooldown file
    it("does not gate --readme, after a subcommand or alone", () => {
        expect(isGatedInvocation("control", ["see", "--readme"])).toBe(false);
        expect(isGatedInvocation("control", ["--readme"])).toBe(false);
        expect(isGatedInvocation("macos", ["reminders", "list", "--readme"])).toBe(false);
    });

    // Regression test: PR #456 review round 6 — `tools macos control <cmd>` runs the same control
    // tool as `tools control <cmd>`, so it needs the same build offer
    it("gates the macos control delegation like tools control", () => {
        expect(isGatedInvocation("macos", ["control", "see", "--app", "Finder"])).toBe(true);
        expect(isGatedInvocation("macos", ["control", "doctor"])).toBe(false);
        expect(isGatedInvocation("macos", ["control"])).toBe(false);
    });

    // Regression test: PR #456 review round 4 — a bare area prints Commander's help, so it must not offer a build
    it("does not gate a bare macos area with no subcommand", () => {
        expect(isGatedInvocation("macos", ["calendar"])).toBe(false);
        expect(isGatedInvocation("macos", ["reminders", "--json"])).toBe(false);
        expect(isGatedInvocation("macos", ["calendar", "list"])).toBe(true);
    });

    // Regression test: PR #456 review — a read-only word matched anywhere, so an option value suppressed the offer
    it("gates a control command whose option value is a read-only word", () => {
        expect(isGatedInvocation("control", ["see", "--app", "status"])).toBe(true);
        expect(isGatedInvocation("control", ["-v", "click", "--app", "doctor"])).toBe(true);
    });

    it("gates a macos subcommand whose option value is a read-only word", () => {
        expect(isGatedInvocation("macos", ["reminders", "list", "--list", "doctor"])).toBe(true);
    });

    it("still skips a read-only subcommand after a leading global flag", () => {
        expect(isGatedInvocation("control", ["-v", "doctor"])).toBe(false);
        expect(isGatedInvocation("macos", ["calendar", "doctor", "--json"])).toBe(false);
    });

    it("does not gate bare control, which prints its help", () => {
        expect(isGatedInvocation("control", [])).toBe(false);
    });

    // Regression test: Fable judge J7 — hub builds the app on its own, so a "no" here would be ignored.
    it("does not gate hub", () => {
        expect(isGatedInvocation("hub", ["status"])).toBe(false);
    });

    it.each([["calendar"], ["reminders"], ["mail"], ["messages"], ["voice-memos"]])("gates macos %s", (subcommand) => {
        expect(isGatedInvocation("macos", [subcommand, "list"])).toBe(true);
    });

    it.each([["calendar"], ["reminders"]])("does not gate macos %s doctor", (subcommand) => {
        expect(isGatedInvocation("macos", [subcommand, "doctor"])).toBe(false);
    });

    it("does not gate macos permissions, which manages the app itself", () => {
        expect(isGatedInvocation("macos", ["permissions", "status"])).toBe(false);
    });

    it("does not gate an unlisted macos subcommand", () => {
        expect(isGatedInvocation("macos", ["swap"])).toBe(false);
    });

    // eslogger takes only options, and a capture needs Full Disk Access, so it is gated without a second word
    it("gates a macos eslogger capture, bare or with options", () => {
        expect(isGatedInvocation("macos", ["eslogger"])).toBe(true);
        expect(isGatedInvocation("macos", ["eslogger", "-e", "exec"])).toBe(true);
        expect(isGatedInvocation("macos", ["-v", "eslogger", "-c", "process"])).toBe(true);
    });

    it.each([["--list-events"], ["--dry-run"], ["-d"], ["--input"], ["--input=rec.jsonl"], ["--help"], ["--readme"]])(
        "does not gate macos eslogger %s, which never starts eslogger",
        (arg) => {
            expect(isGatedInvocation("macos", ["eslogger", "-e", "exec", arg])).toBe(false);
        }
    );

    it("does not read an object prototype key as a gated macos subcommand", () => {
        expect(isGatedInvocation("macos", ["constructor", "-x"])).toBe(false);
    });

    it("does not gate bare macos with no subcommand", () => {
        expect(isGatedInvocation("macos", [])).toBe(false);
    });

    it("does not gate an unrelated tool", () => {
        expect(isGatedInvocation("ask", [])).toBe(false);
    });
});

describe("createRealBuildOfferDeps", () => {
    function stubTty(stdin: boolean, stdout: boolean): () => void {
        const before = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
        Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true, writable: true });
        Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true, writable: true });

        return () => {
            Object.defineProperty(process.stdin, "isTTY", { value: before.stdin, configurable: true, writable: true });
            Object.defineProperty(process.stdout, "isTTY", {
                value: before.stdout,
                configurable: true,
                writable: true,
            });
        };
    }

    // Regression test: Fable judge J2 — `tools control see … | jq` must never get the offer on its stdout.
    it("is not a terminal when stdout is piped, even with a terminal on stdin", () => {
        const restore = stubTty(true, false);

        try {
            expect(createRealBuildOfferDeps().isTty()).toBe(false);
        } finally {
            restore();
        }
    });

    it("is a terminal when both stdin and stdout are terminals", () => {
        const restore = stubTty(true, true);

        try {
            expect(createRealBuildOfferDeps().isTty()).toBe(true);
        } finally {
            restore();
        }
    });

    it("uses stderr terminal status for build progress", () => {
        const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
        try {
            for (const interactive of [false, true]) {
                Object.defineProperty(process.stderr, "isTTY", { value: interactive, configurable: true });
                expect(createRealBuildOfferDeps().progress?.interactive).toBe(interactive);
                // A terminal build redraws one spinner line; the real deps must hand the display a spinner.
                expect(typeof createRealBuildOfferDeps().progress?.spinner).toBe("function");
            }
        } finally {
            if (descriptor) {
                Object.defineProperty(process.stderr, "isTTY", descriptor);
            } else {
                Reflect.deleteProperty(process.stderr, "isTTY");
            }
        }
    });

    it("writes its messages to stderr", () => {
        const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

        try {
            createRealBuildOfferDeps().log("hello from the offer");

            expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("hello from the offer");
        } finally {
            stderr.mockRestore();
        }
    });
});

describe("shouldAsk", () => {
    const now = 1_700_000_000_000;

    it("asks when nothing was ever declined", () => {
        expect(shouldAsk(undefined, now)).toBe(true);
    });

    it("stays quiet inside the cooldown window", () => {
        expect(shouldAsk(now - DECLINE_COOLDOWN_MS + 1, now)).toBe(false);
    });

    it("asks again once the cooldown has fully elapsed", () => {
        expect(shouldAsk(now - DECLINE_COOLDOWN_MS, now)).toBe(true);
    });
});

describe("readOfferStateFrom / writeOfferStateTo", () => {
    function tempStatePath(): string {
        return join(mkdtempSync(join(tmpdir(), "build-offer-test-")), "state.json");
    }

    it("round-trips a written timestamp", () => {
        const path = tempStatePath();
        writeOfferStateTo(path, { declinedAtMs: 1_234_567 });

        expect(readOfferStateFrom(path).declinedAtMs).toBe(1_234_567);
    });

    it("keeps the decline and the Xcode notice apart in one file", () => {
        const path = tempStatePath();
        writeOfferStateTo(path, { declinedAtMs: 1_000 });
        writeOfferStateTo(path, { xcodeNoticeAtMs: 2_000 });

        expect(readOfferStateFrom(path)).toEqual({ declinedAtMs: 1_000, xcodeNoticeAtMs: 2_000 });
    });

    it("reads nothing when no state file exists yet", () => {
        expect(readOfferStateFrom(tempStatePath())).toEqual({});
    });

    it("leaves a state file that does not parse untouched instead of rewriting it", () => {
        const path = tempStatePath();
        const torn = '{"declinedAtMs": 1000, "xcodeNot';
        writeFileSync(path, torn);
        writeOfferStateTo(path, { xcodeNoticeAtMs: 2_000 });

        expect(readFileSync(path, "utf8")).toBe(torn);
        expect(readOfferStateFrom(path)).toEqual({});
    });
});

const NOW = 1_700_000_000_000;

interface FakeDepsOverrides {
    noAppEnv?: boolean;
    isTty?: boolean;
    isAppBuilt?: boolean;
    declinedAt?: number;
    xcodeNoticeAt?: number;
    toolchain?: { kind: "xcode" | "command-line-tools" | "none"; developerDir?: string };
    confirmAnswer?: boolean;
}

/** Every call that reaches a dep is logged, so an override still shows up in `calls` even though its return value changed. */
function fakeDeps(overrides: FakeDepsOverrides = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps = {
        isTty: () => overrides.isTty ?? true,
        noAppEnv: () => overrides.noAppEnv ?? false,
        isAppBuilt: () => overrides.isAppBuilt ?? false,
        detectToolchain: () =>
            (overrides.toolchain ?? {
                kind: "xcode",
                developerDir: "/Applications/Xcode.app/Contents/Developer",
            }) as ReturnType<BuildOfferDeps["detectToolchain"]>,
        readDeclinedAt: () => overrides.declinedAt,
        writeDeclinedAt: (atMs: number) => {
            calls.push(`writeDeclinedAt:${atMs}`);
        },
        readXcodeNoticeAt: () => overrides.xcodeNoticeAt,
        writeXcodeNoticeAt: (atMs: number) => {
            calls.push(`writeXcodeNoticeAt:${atMs}`);
        },
        confirmBuild: async () => {
            calls.push("confirmBuild");
            return overrides.confirmAnswer ?? true;
        },
        build: async (onStep: (message: string) => void) => {
            calls.push("build");
            onStep("building");
        },
        log: (message: string) => {
            calls.push("log");
            logs.push(message);
        },
        now: () => NOW,
    };

    return { deps, calls, logs };
}

describe("maybeOfferGenesisAppBuild", () => {
    it.each([false, true])("uses terminal progress and stops the spinner when build failure is %s", async (fails) => {
        const { deps } = fakeDeps();
        const events: string[] = [];
        const configured: BuildOfferDeps = {
            ...deps,
            progress: {
                interactive: true,
                spinner: () => ({
                    start: (message) => {
                        events.push(`start:${message}`);
                    },
                    message: (message) => {
                        events.push(`message:${message}`);
                    },
                    stop: (message) => {
                        events.push(`stop:${message}`);
                    },
                }),
            },
            build: async (onStep, onProgress) => {
                onStep("compiling");
                onProgress("1/2 files");
                onProgress("2/2 files");
                if (fails) {
                    throw new Error("fixture build failure");
                }
            },
            log: (message) => {
                events.push(`log:${message}`);
            },
        };
        await maybeOfferGenesisAppBuild(configured);
        expect(events).toContain("start:1/2 files");
        expect(events).toContain("message:2/2 files");
        expect(events).toContain("stop:2/2 files");
        if (fails) {
            expect(events.at(-2)).toBe("stop:2/2 files");
            expect(events.at(-1)).toContain("fixture build failure");
        } else {
            expect(events.at(-1)).toBe("stop:2/2 files");
        }
    });

    it("keeps plain progress throttled when stderr is redirected", async () => {
        const { deps } = fakeDeps();
        const logs: string[] = [];
        let clock = 0;
        let spinners = 0;
        await maybeOfferGenesisAppBuild({
            ...deps,
            progress: {
                interactive: false,
                now: () => clock,
                spinner: () => {
                    spinners++;
                    throw new Error("redirected output must not use a spinner");
                },
            },
            log: (message) => {
                logs.push(message);
            },
            build: async (_onStep, onProgress) => {
                onProgress("first progress");
                clock = 1000;
                onProgress("suppressed progress");
                clock = 15_000;
                onProgress("later progress");
            },
        });
        expect(logs).toContain("first progress");
        expect(logs).not.toContain("suppressed progress");
        expect(logs).toContain("later progress");
        expect(spinners).toBe(0);
    });

    it("asks nothing when GENESIS_TOOLS_NO_APP is set", async () => {
        const { deps, calls } = fakeDeps({ noAppEnv: true });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    it("asks nothing without a TTY", async () => {
        const { deps, calls } = fakeDeps({ isTty: false });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    it("asks nothing once the app is already built", async () => {
        const { deps, calls } = fakeDeps({ isAppBuilt: true });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    it("asks nothing while a decline is still inside its cooldown", async () => {
        const { deps, calls } = fakeDeps({ declinedAt: NOW - 1000 });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    // Regression test: PR #456 review — the Xcode notice was stored as a decline, so installing Xcode
    // did not bring the offer back for 3 days
    it("prints the Xcode hint and records the notice, not a decline, without full Xcode", async () => {
        const { deps, calls, logs } = fakeDeps({
            toolchain: { kind: "command-line-tools", developerDir: "/Library/Developer/CommandLineTools" },
        });
        await maybeOfferGenesisAppBuild(deps);

        expect(logs[0]).toContain("needs the full Xcode");
        expect(calls).toEqual(["log", `writeXcodeNoticeAt:${NOW}`]);
    });

    it("does not repeat the Xcode notice inside its cooldown", async () => {
        const { deps, calls } = fakeDeps({
            xcodeNoticeAt: NOW - 1000,
            toolchain: { kind: "command-line-tools", developerDir: "/Library/Developer/CommandLineTools" },
        });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    it("asks as soon as Xcode is installed, even right after the Xcode notice", async () => {
        const { deps, calls } = fakeDeps({ xcodeNoticeAt: NOW - 1000 });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual(["log", "confirmBuild", "build", "log"]);
    });

    it("records a decline and never builds when the answer is no", async () => {
        const { deps, calls } = fakeDeps({ confirmAnswer: false });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual(["log", "confirmBuild", `writeDeclinedAt:${NOW}`]);
    });

    it("builds and never records a decline when the answer is yes", async () => {
        const { deps, calls } = fakeDeps();
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual(["log", "confirmBuild", "build", "log"]);
    });

    it("never throws when the build itself fails, so the original command still runs after", async () => {
        const { deps, calls, logs } = fakeDeps();
        deps.build = async () => {
            calls.push("build");
            throw new Error("swift build failed");
        };

        await expect(maybeOfferGenesisAppBuild(deps)).resolves.toBeUndefined();

        expect(calls).toEqual(["log", "confirmBuild", "build", "log"]);
        expect(logs.at(-1)).toContain("swift build failed");
    });
});

// `tools hub` sat silent through the whole cold `swift build` (about a minute) and looked stuck: the build ran under
// `Bun.spawnSync` and its output was read only at the end.
describe("swift build progress", () => {
    it("reads SwiftPM's step lines and keeps the file name", () => {
        expect(parseSwiftBuildProgress("[180/430] Compiling GenesisTools HubAgents.swift")).toEqual({
            done: 180,
            total: 430,
            action: "Compiling",
            subject: "HubAgents.swift",
        });
        expect(parseSwiftBuildProgress("[430/430] Linking GenesisTools")?.subject).toBe("GenesisTools");
        expect(parseSwiftBuildProgress("[3/9] Write-swift-version")).toMatchObject({
            action: "Write-swift-version",
            subject: "",
        });
        expect(parseSwiftBuildProgress("Building for debugging...")).toBeNull();
        // Swift 6.4's default build system (Swift Build) spaces the counter and often names only a module, or nothing.
        expect(parseSwiftBuildProgress("[2 / 10] GenesisKitBase")).toEqual({
            done: 2,
            total: 10,
            action: "GenesisKitBase",
            subject: "",
        });
        expect(parseSwiftBuildProgress("[14 / 150]")).toEqual({ done: 14, total: 150, action: "", subject: "" });
        expect(formatSwiftBuildProgress({ done: 14, total: 150, action: "", subject: "" }, 3200)).toBe(
            "swift build step 14 of 150, 3 s"
        );
        expect(parseSwiftBuildProgress("/x/Foo.swift:3:1: warning: [1/2] is not progress")).toBeNull();
    });

    it("reports the first step at once and then at most once per interval", () => {
        let clock = 0;
        const shown: string[] = [];
        const feed = createSwiftProgressReporter(
            (message) => shown.push(message),
            1000,
            () => clock
        );

        feed("[1/400] Compiling GenesisKit A.swift");
        clock = 500;
        feed("[2/400] Compiling GenesisKit B.swift");
        feed("warning: something");
        clock = 1500;
        feed("[200/400] Compiling GenesisTools C.swift");

        expect(shown).toEqual([
            "swift build step 1 of 400: Compiling A.swift, 0 s",
            "swift build step 200 of 400: Compiling C.swift, 1 s",
        ]);
    });

    it("in a terminal: one spinner line that the next step and finish stop on its last message", () => {
        const events: string[] = [];
        const spinner = {
            start: (message?: string) => events.push(`start ${message}`),
            message: (message?: string) => events.push(`message ${message}`),
            stop: (message?: string) => events.push(`stop ${message}`),
        };
        const display = createBuildProgressDisplay({
            step: (message) => events.push(`step ${message}`),
            spinner: () => spinner,
            interactive: true,
        });

        display.onStep("swift build (optimized, incremental)");
        display.onProgress("swift build 1/4 (25%) Compiling A.swift, 0 s");
        display.onProgress("swift build 3/4 (75%) Compiling C.swift, 2 s");
        display.onStep("assemble bundle");
        display.finish();

        expect(events).toEqual([
            "step swift build (optimized, incremental)",
            "start swift build 1/4 (25%) Compiling A.swift, 0 s",
            "message swift build 3/4 (75%) Compiling C.swift, 2 s",
            "stop swift build 3/4 (75%) Compiling C.swift, 2 s",
            "step assemble bundle",
        ]);
    });

    it.each([
        [true, false],
        [false, true],
    ])("defaults progress to stderr independently of stdin (%s, %s)", (stdinTty, stderrTty) => {
        const descriptors = [process.stdin, process.stderr].map((stream) =>
            Object.getOwnPropertyDescriptor(stream, "isTTY")
        );
        const events: string[] = [];
        let clock = 0;
        try {
            Object.defineProperty(process.stdin, "isTTY", { value: stdinTty, configurable: true });
            Object.defineProperty(process.stderr, "isTTY", { value: stderrTty, configurable: true });
            const display = createBuildProgressDisplay({
                step: (message) => {
                    events.push(`plain:${message}`);
                },
                spinner: () => ({
                    start: (message) => {
                        events.push(`start:${message}`);
                    },
                    message: (message) => {
                        events.push(`message:${message}`);
                    },
                    stop: (message) => {
                        events.push(`stop:${message}`);
                    },
                }),
                now: () => clock,
            });
            display.onProgress("first");
            clock = 1000;
            display.onProgress("suppressed");
            clock = PLAIN_PROGRESS_EVERY_MS;
            display.onProgress("last");
            display.finish();
            expect(events).toEqual(
                stderrTty
                    ? ["start:first", "message:suppressed", "message:last", "stop:last"]
                    : ["plain:first", "plain:last"]
            );
        } finally {
            for (const [index, stream] of [process.stdin, process.stderr].entries()) {
                const descriptor = descriptors[index];
                if (descriptor) {
                    Object.defineProperty(stream, "isTTY", descriptor);
                } else {
                    Reflect.deleteProperty(stream, "isTTY");
                }
            }
        }
    });

    it("terminates a stalled streaming command and releases its lock before another request", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-stream-deadline-"));
        try {
            const lock = join(root, "build.lock");
            const lines: string[] = [];
            const hung = withFileLock(
                lock,
                () =>
                    runStreaming({
                        cmd: [
                            process.execPath,
                            "-e",
                            'console.log("build started"); process.on("SIGTERM", () => {}); setTimeout(() => {}, 2000);',
                        ],
                        onLine: (line) => {
                            lines.push(line);
                        },
                        timeoutMs: 500,
                    }),
                2000
            );
            await expect(hung).rejects.toThrow("timed out after 500 ms and was terminated");
            expect(lines).toContain("build started");
            const next = await withFileLock(
                lock,
                () =>
                    runStreaming({
                        cmd: [
                            process.execPath,
                            "-e",
                            'process.stdout.write("recovered"); process.stderr.write("warning");',
                        ],
                        onLine: (line) => {
                            lines.push(line);
                        },
                        timeoutMs: 2000,
                    }),
                2000
            );
            expect(next).toEqual({ code: 0, stdout: "recovered", stderr: "warning" });
            expect(lines).toContain("recovered");
            expect(lines).toContain("warning");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("outside a terminal: a plain line, then the next only after the plain interval", () => {
        let clock = 0;
        const lines: string[] = [];
        const display = createBuildProgressDisplay({
            step: (message) => lines.push(message),
            interactive: false,
            now: () => clock,
        });

        display.onProgress("p1");
        clock = PLAIN_PROGRESS_EVERY_MS - 1;
        display.onProgress("p2");
        clock = PLAIN_PROGRESS_EVERY_MS;
        display.onProgress("p3");
        display.finish();

        expect(lines).toEqual(["p1", "p3"]);
    });

    it("hands each line over while the process still runs, and keeps the whole output", async () => {
        const seen: { line: string; at: number }[] = [];
        const script =
            'console.log("[1/2] Compiling A a.swift"); setTimeout(() => console.error("[2/2] Linking App"), 400);';
        const result = await runStreaming({
            cmd: [process.execPath, "-e", script],
            onLine: (line) => {
                seen.push({ line, at: performance.now() });
            },
        });
        const exitedAt = performance.now();

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("[1/2] Compiling A a.swift");
        expect(result.stderr).toContain("[2/2] Linking App");
        expect(seen.map((entry) => entry.line)).toEqual(["[1/2] Compiling A a.swift", "[2/2] Linking App"]);
        // The first line came before the process ended, not in one batch after it.
        expect(exitedAt - (seen[0]?.at ?? exitedAt)).toBeGreaterThan(250);
    });
});

describe("an install is stale only when the code it links changed", () => {
    function sourceTree(): string {
        const root = mkdtempSync(join(tmpdir(), "app-source-roots-"));
        const app = join(root, "GenesisTools");
        const files = [
            "GenesisTools/Package.swift",
            "GenesisTools/Info.plist",
            "GenesisTools/scripts/AppIcon.icns",
            "GenesisTools/ClickyLibrary.json",
            "GenesisTools/Sources/Host/Host.swift",
            "GenesisTools/Sources/GenesisTools/main.swift",
            "GenesisTools/Sources/Parts/Hub/Hub.swift",
            "GenesisTools/web/diff-viewer/index.ts",
            "GenesisKit/Package.swift",
            "GenesisKit/Sources/GenesisKitBase/Base.swift",
            "GenesisKit/Sources/GenesisKit/Kit.swift",
        ];

        for (const file of files) {
            mkdirSync(dirname(join(root, file)), { recursive: true });
            writeFileSync(join(root, file), `// ${file}\n`);
        }

        return app;
    }

    it("a host-only install ignores the parts, but sees its own sources and GenesisKitBase", () => {
        const app = sourceTree();

        try {
            const host = sourceHash(app, []);
            const hub = sourceHash(app, ["features", "hub"]);
            writeFileSync(join(app, "Sources/Parts/Hub/Hub.swift"), "// changed\n");
            writeFileSync(join(app, "../GenesisKit/Sources/GenesisKit/Kit.swift"), "// changed\n");

            expect(sourceHash(app, [])).toBe(host);
            expect(sourceHash(app, ["features", "hub"])).not.toBe(hub);

            writeFileSync(join(app, "../GenesisKit/Sources/GenesisKitBase/Base.swift"), "// changed\n");
            expect(sourceHash(app, [])).not.toBe(host);
        } finally {
            rmSync(dirname(app), { recursive: true, force: true });
        }
    });

    it("only installs bundling the diff viewer become stale after a web edit", () => {
        const app = sourceTree();
        const selections = [[], ["features"], ["markdown"], ["features", "clicky"], ["features", "hub"]];

        try {
            const before = selections.map((parts) => sourceHash(app, parts));
            writeFileSync(join(app, "web/diff-viewer/index.ts"), "// changed\n");

            for (const [index, parts] of selections.entries()) {
                expect(sourceRootsFor(parts).includes("web")).toBe(parts.includes("hub"));
                expect(sourceHash(app, parts) === before[index]).toBe(!parts.includes("hub"));
            }
        } finally {
            rmSync(dirname(app), { recursive: true, force: true });
        }
    });

    it("a full build keeps the inputs it always had, so existing installs are not rebuilt", () => {
        const app = sourceTree();

        try {
            // Frozen legacy digest: root order, sorted recursive paths, then each path and its file bytes.
            const legacyHash = "c4cdaea45ba34a58";
            expect(sourceHash(app)).toBe(legacyHash);
            expect(sourceHash(app, ["clicky", "features", "hub", "markdown", "widget"])).toBe(legacyHash);
        } finally {
            rmSync(dirname(app), { recursive: true, force: true });
        }
    });
});

describe.skipIf(skip.unlessMac)("shareBundleResources", () => {
    const KB64 = 64 * 1024;
    /** 64 KB of one repeated byte, so a file holds real blocks and two variants never match by accident. */
    const bytes = (fill: number) => Buffer.alloc(KB64, fill);

    function bundleIn(root: string, stamp: string, files: Record<string, Buffer>): string {
        const bundle = join(root, stamp, "GenesisTools.app");

        for (const [rel, content] of Object.entries(files)) {
            const path = join(bundle, "Contents", rel);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, content);
        }

        return bundle;
    }

    const inode = (path: string) => statSync(path).ino;
    const sameClone = (a: string, b: string) => {
        const id = getCloneId(a);
        return id !== null && id !== 0n && id === getCloneId(b);
    };

    it("a dry run counts the identical resources and changes no file", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));

        try {
            const files = { "Resources/ClickyLibrary/a.wav": bytes(1), "Resources/AppIcon.icns": bytes(2) };
            const installed = bundleIn(root, "installed", files);
            const retired = bundleIn(root, "100", files);
            const icon = join(retired, "Contents/Resources/AppIcon.icns");
            const before = inode(icon);

            const report = shareBundleResources({ bundles: [installed, retired], apply: false });

            expect(report.shared).toBe(2);
            expect(report.sharedBytes).toBeGreaterThanOrEqual(2 * KB64);
            expect(inode(icon)).toBe(before);
            expect(sameClone(join(installed, "Contents/Resources/AppIcon.icns"), icon)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("apply turns each identical resource into a clone of the first bundle's copy and leaves that copy alone", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));

        try {
            const installed = bundleIn(root, "installed", {
                "Resources/ClickyLibrary/a.wav": bytes(1),
                "Resources/diff-viewer/viewer.js": bytes(3),
            });
            const retired = bundleIn(root, "100", {
                "Resources/ClickyLibrary/a.wav": bytes(1),
                "Resources/diff-viewer/viewer.js": bytes(4),
            });
            const keeper = join(installed, "Contents/Resources/ClickyLibrary/a.wav");
            const keeperInode = inode(keeper);

            const report = shareBundleResources({ bundles: [installed, retired], apply: true });

            expect(report.shared).toBe(1);
            expect(report.errors).toEqual([]);
            expect(sameClone(keeper, join(retired, "Contents/Resources/ClickyLibrary/a.wav"))).toBe(true);
            expect(readFileSync(join(retired, "Contents/Resources/ClickyLibrary/a.wav"))).toEqual(bytes(1));
            expect(inode(keeper)).toBe(keeperInode);
            // A changed file keeps its own bytes: sharing never makes two different builds look alike.
            expect(readFileSync(join(retired, "Contents/Resources/diff-viewer/viewer.js"))).toEqual(bytes(4));
            // The folder swap leaves neither the fresh clone nor the replaced copy behind.
            expect(readdirSync(join(retired, "Contents/Resources")).sort()).toEqual(["ClickyLibrary", "diff-viewer"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("enters a folder that differs and shares its equal files one by one", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));

        try {
            const installed = bundleIn(root, "installed", {
                "Resources/ClickyLibrary/a.wav": bytes(1),
                "Resources/ClickyLibrary/b.wav": bytes(2),
            });
            const retired = bundleIn(root, "100", {
                "Resources/ClickyLibrary/a.wav": bytes(1),
                "Resources/ClickyLibrary/b.wav": bytes(3),
                "Resources/ClickyLibrary/c.wav": bytes(4),
            });

            const report = shareBundleResources({ bundles: [installed, retired], apply: true });

            expect(report).toMatchObject({ files: 5, shared: 1, alreadyShared: 0, errors: [] });
            const library = (bundle: string, name: string) => join(bundle, "Contents/Resources/ClickyLibrary", name);
            expect(sameClone(library(installed, "a.wav"), library(retired, "a.wav"))).toBe(true);
            expect(readFileSync(library(retired, "b.wav"))).toEqual(bytes(3));
            expect(readFileSync(library(retired, "c.wav"))).toEqual(bytes(4));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("never touches the executable, Info.plist or the signature, even when they are identical", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));

        try {
            const outside = {
                "MacOS/GenesisTools": bytes(7),
                "Info.plist": bytes(8),
                "_CodeSignature/CodeResources": bytes(9),
            };
            const installed = bundleIn(root, "installed", outside);
            const retired = bundleIn(root, "100", outside);
            const paths = Object.keys(outside).map((rel) => join(retired, "Contents", rel));
            const before = paths.map(inode);

            const report = shareBundleResources({ bundles: [installed, retired], apply: true });

            expect(report.files).toBe(0);
            expect(paths.map(inode)).toEqual(before);
            expect(sameClone(join(installed, "Contents/MacOS/GenesisTools"), paths[0])).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("shares with any earlier bundle that has the same bytes, not only the first one", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));
        const rel = "Resources/diff-viewer/viewer.js";

        try {
            const installed = bundleIn(root, "installed", { [rel]: bytes(1) });
            const newer = bundleIn(root, "200", { [rel]: bytes(2) });
            const older = bundleIn(root, "100", { [rel]: bytes(2) });
            const oldest = bundleIn(root, "050", { [rel]: bytes(1) });

            const report = shareBundleResources({ bundles: [installed, newer, older, oldest], apply: true });

            expect(report.shared).toBe(2);
            expect(sameClone(join(newer, "Contents", rel), join(older, "Contents", rel))).toBe(true);
            expect(sameClone(join(installed, "Contents", rel), join(oldest, "Contents", rel))).toBe(true);
            expect(sameClone(join(installed, "Contents", rel), join(newer, "Contents", rel))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("a second pass finds everything shared and clones nothing", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));

        try {
            const files = { "Resources/ClickyLibrary/a.wav": bytes(1), "Resources/webview/index.html": bytes(5) };
            const installed = bundleIn(root, "installed", files);
            const retired = bundleIn(root, "100", files);
            shareBundleResources({ bundles: [installed, retired], apply: true });
            const html = join(retired, "Contents/Resources/webview/index.html");
            const after = inode(html);

            const again = shareBundleResources({ bundles: [installed, retired], apply: true });

            expect(again.shared).toBe(0);
            expect(again.alreadyShared).toBe(2);
            expect(inode(html)).toBe(after);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("a retired folder done once is marked and not walked again; a dry run marks nothing", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));

        try {
            const files = { "Resources/ClickyLibrary/a.wav": bytes(1) };
            const installed = bundleIn(root, "installed", files);
            const retiredRoot = join(root, "retired.noindex");
            bundleIn(retiredRoot, "200", files);
            bundleIn(retiredRoot, "100", files);

            const dry = shareRetiredResources({ retiredRoot, installedBundle: installed, apply: false });
            expect(dry?.shared).toBe(2);
            expect(retiredStampsToShare(retiredRoot, ["200", "100"])).toEqual(["200", "100"]);

            const applied = shareRetiredResources({ retiredRoot, installedBundle: installed, apply: true });
            expect(applied?.shared).toBe(2);
            expect(retiredStampsToShare(retiredRoot, ["200", "100"])).toEqual([]);

            bundleIn(retiredRoot, "300", files);
            const next = shareRetiredResources({ retiredRoot, installedBundle: installed, apply: true });
            expect(next).toMatchObject({ bundles: 2, files: 2, shared: 1 });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("a folder whose links differ is entered and keeps its own links; equal links still allow a whole-folder share", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));
        const res = (bundle: string, rel: string) => join(bundle, "Contents/Resources", rel);

        try {
            const files = {
                "Resources/web/a.js": bytes(1),
                "Resources/docs/b.md": bytes(2),
                "Resources/same/c.js": bytes(3),
            };
            const installed = bundleIn(root, "installed", files);
            const retired = bundleIn(root, "100", files);
            symlinkSync("a.js", res(installed, "web/current"));
            symlinkSync("b.js", res(retired, "web/current"));
            symlinkSync("b.md", res(retired, "docs/latest"));
            symlinkSync("c.js", res(installed, "same/link"));
            symlinkSync("c.js", res(retired, "same/link"));
            const webBefore = inode(res(retired, "web"));
            const sameBefore = inode(res(retired, "same"));

            const report = shareBundleResources({ bundles: [installed, retired], apply: true });

            expect(report).toMatchObject({ files: 6, shared: 3, errors: [] });
            // A link that points elsewhere, or exists only here, makes its folder differ: the folder is entered.
            expect(readlinkSync(res(retired, "web/current"))).toBe("b.js");
            expect(readlinkSync(res(retired, "docs/latest"))).toBe("b.md");
            expect(inode(res(retired, "web"))).toBe(webBefore);
            expect(sameClone(res(installed, "web/a.js"), res(retired, "web/a.js"))).toBe(true);
            expect(sameClone(res(installed, "docs/b.md"), res(retired, "docs/b.md"))).toBe(true);
            expect(inode(res(retired, "same"))).not.toBe(sameBefore);
            expect(readlinkSync(res(retired, "same/link"))).toBe("c.js");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.getuid?.() === 0)(
        "a folder with a part it cannot read is never replaced as a whole, and what it holds stays",
        () => {
            const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));
            const res = (bundle: string, rel: string) => join(bundle, "Contents/Resources", rel);
            const locked: string[] = [];

            try {
                const installed = bundleIn(root, "installed", { "Resources/lib/a.wav": bytes(1) });
                mkdirSync(res(installed, "lib/unlisted"));
                mkdirSync(res(installed, "lib/unsized"));
                const retired = bundleIn(root, "100", {
                    "Resources/lib/a.wav": bytes(1),
                    "Resources/lib/unlisted/x.wav": bytes(2),
                    "Resources/lib/unsized/y.wav": bytes(3),
                });
                const unlisted = res(retired, "lib/unlisted");
                const unsized = res(retired, "lib/unsized");
                // No read bit: listing it fails. Read without search: it lists, but no entry in it can be stat'ed.
                // Read in part, each looks like the installed bundle's empty folder.
                chmodSync(unlisted, 0o000);
                chmodSync(unsized, 0o444);
                locked.push(unlisted, unsized);
                const libBefore = inode(res(retired, "lib"));

                const report = shareBundleResources({ bundles: [installed, retired], apply: true });

                for (const dir of locked.splice(0)) {
                    chmodSync(dir, 0o755);
                }

                expect(report.errors.map((error) => error.path).sort()).toEqual([unlisted, join(unsized, "y.wav")]);
                expect(inode(res(retired, "lib"))).toBe(libBefore);
                expect(readdirSync(res(retired, "lib")).sort()).toEqual(["a.wav", "unlisted", "unsized"]);
                expect(readFileSync(join(unlisted, "x.wav"))).toEqual(bytes(2));
                expect(readFileSync(join(unsized, "y.wav"))).toEqual(bytes(3));
                // What it could read is still shared, one file at a time.
                expect(report.shared).toBe(1);
                expect(sameClone(res(installed, "lib/a.wav"), res(retired, "lib/a.wav"))).toBe(true);
            } finally {
                for (const dir of locked) {
                    chmodSync(dir, 0o755);
                }

                rmSync(root, { recursive: true, force: true });
            }
        }
    );

    it("an apply pass first puts right what an interrupted pass left; a dry run leaves it", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));

        try {
            const files = { "Resources/ClickyLibrary/a.wav": bytes(1), "Resources/web/b.js": bytes(2) };
            const installed = bundleIn(root, "installed", files);
            const retired = bundleIn(root, "100", files);
            const resources = join(retired, "Contents/Resources");
            // The two-rename swap died between its renames: the folder exists only under its set-aside name.
            renameSync(join(resources, "ClickyLibrary"), join(resources, "ClickyLibrary.gtshare-old-1-2"));
            // A swap died before it removed the copy it set aside; the folder itself is intact.
            mkdirSync(join(resources, "web.gtshare-1-2"));
            writeFileSync(join(resources, "web.gtshare-1-2/b.js"), bytes(2));
            const leftovers = ["ClickyLibrary.gtshare-old-1-2", "web", "web.gtshare-1-2"];

            shareBundleResources({ bundles: [installed, retired], apply: false });
            expect(readdirSync(resources).sort()).toEqual(leftovers);

            const report = shareBundleResources({ bundles: [installed, retired], apply: true });

            expect(report).toMatchObject({ shared: 2, errors: [] });
            expect(readdirSync(resources).sort()).toEqual(["ClickyLibrary", "web"]);
            expect(readFileSync(join(resources, "ClickyLibrary/a.wav"))).toEqual(bytes(1));
            expect(
                sameClone(
                    join(installed, "Contents/Resources/ClickyLibrary/a.wav"),
                    join(resources, "ClickyLibrary/a.wav")
                )
            ).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("a folder swap that fails leaves the folder in place with no copy beside it, and shares its files one by one", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));
        const swap = spyOn(apfs, "swapPaths").mockImplementation(() => {
            throw new Error("swap refused");
        });

        try {
            const files = { "Resources/ClickyLibrary/a.wav": bytes(1) };
            const installed = bundleIn(root, "installed", files);
            const retired = bundleIn(root, "100", files);
            const library = join(retired, "Contents/Resources/ClickyLibrary");
            const before = inode(library);

            const report = shareBundleResources({ bundles: [installed, retired], apply: true });

            expect(swap).toHaveBeenCalledTimes(1);
            expect(report.errors).toEqual([{ path: library, message: "swap refused" }]);
            expect(inode(library)).toBe(before);
            expect(readdirSync(join(retired, "Contents/Resources"))).toEqual(["ClickyLibrary"]);
            expect(report.shared).toBe(1);
            expect(sameClone(join(installed, "Contents/Resources/ClickyLibrary/a.wav"), join(library, "a.wav"))).toBe(
                true
            );
        } finally {
            swap.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("skips a bundle that is missing or has no Resources folder", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-share-resources-"));

        try {
            const installed = bundleIn(root, "installed", { "Resources/AppIcon.icns": bytes(2) });
            const bare = bundleIn(root, "100", { "MacOS/GenesisTools": bytes(7) });

            const report = shareBundleResources({ bundles: [installed, bare, join(root, "gone.app")], apply: true });

            expect(report).toMatchObject({ bundles: 3, files: 1, shared: 0, errors: [] });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
