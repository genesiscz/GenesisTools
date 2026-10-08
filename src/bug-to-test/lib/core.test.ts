import { describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactBrowserText } from "@app/chrome-devtools/lib/action-recording";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { recordingSnapshot } from "./capture";
import { EXPECTATION_MARKER, generateRepro } from "./generate";
import { type BugRecording, parseExpectation, parseRecording } from "./types";
import {
    classifyReport,
    exportWorkspace,
    generateWorkspace,
    inspectWorkspace,
    testHash,
    verifyWorkspace,
} from "./workspace";

const recording: BugRecording = {
    version: 1,
    id: "fixture",
    title: "Cart count",
    initialUrl: "http://localhost:1234/cart",
    actions: [{ id: "action", kind: "click", locator: { kind: "testId", value: "add" }, excluded: false, at: 1 }],
    evidence: [],
    expectation: {
        description: "Adding one item shows count 1",
        kind: "text",
        locator: { kind: "testId", value: "count" },
        expected: "1",
    },
};
const report = (status: string, message?: string) => ({
    suites: [
        {
            specs: [
                {
                    tests: [
                        {
                            results: [
                                {
                                    status,
                                    errors: message ? [{ message }] : [],
                                    attachments: [{ name: "trace", path: "trace.zip" }],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
});

describe("bug repro contract", () => {
    test("requires a concrete user expectation", () => {
        expect(() =>
            parseExpectation({
                kind: "text",
                expected: "1",
                description: "",
                locator: { kind: "css", value: "#count" },
            })
        ).toThrow("explicitly");
        expect(() => generateRepro({ ...recording, expectation: undefined })).toThrow();
    });
    test("rejects executable navigation and invalid input recordings", () => {
        expect(() => parseRecording({ ...recording, initialUrl: "javascript:alert(1)" })).toThrow("HTTP");
        expect(() => parseRecording({ ...recording, actions: [{ ...recording.actions[0], kind: "eval" }] })).toThrow(
            "invalid action"
        );
        expect(() => parseRecording({ ...recording, actions: [{ ...recording.actions[0], kind: "fill" }] })).toThrow(
            "value"
        );
    });
    test("escapes source strings and keeps user assertion separate from action preflight", () => {
        const source = generateRepro({
            ...recording,
            title: "quote'\n${evil}",
            expectation: { ...recording.expectation!, expected: "\"; throw new Error('injected')" },
        });
        expect(source).toContain('test("quote\'\\n${evil}"');
        expect(source).toContain("Assertion target must resolve uniquely");
        expect(source).toContain(EXPECTATION_MARKER);
        expect(source).toContain('toHaveText("\\"; throw new Error(\'injected\')")');
    });
    test("hidden assertions allow removed elements while rejecting multiple targets", () => {
        const hidden = generateRepro({
            ...recording,
            expectation: { ...recording.expectation!, kind: "visible", expected: "false" },
        });
        expect(hidden).toContain("Assertion target must not be ambiguous");
        expect(hidden).toContain("toBeLessThanOrEqual(1)");
        expect(hidden).toContain("'BUG_TO_TEST_EXPECTATION').toBeHidden()");
        expect(hidden).not.toContain("Assertion target must resolve uniquely");
        const visible = generateRepro({
            ...recording,
            expectation: { ...recording.expectation!, kind: "visible", expected: "true" },
        });
        expect(visible).toContain("Assertion target must resolve uniquely').toHaveCount(1)");
    });
    test("excluded actions never become executable steps", () => {
        expect(generateRepro({ ...recording, actions: [{ ...recording.actions[0], excluded: true }] })).not.toContain(
            "step0"
        );
    });
    test("only the intended matcher failure proves the bug", () => {
        expect(
            classifyReport({
                report: report("failed", `Error: ${EXPECTATION_MARKER}\nexpect(locator).toHaveText(expected)`),
                exitCode: 1,
            }).status
        ).toBe("intended-failure");
        expect(
            classifyReport({
                report: report("failed", "Recorded action 1 must resolve uniquely\nexpect(locator).toHaveCount"),
                exitCode: 1,
            }).status
        ).toBe("infrastructure-error");
        expect(classifyReport({ report: report("timedOut", EXPECTATION_MARKER), exitCode: 1 }).status).toBe(
            "infrastructure-error"
        );
        expect(classifyReport({ report: {}, exitCode: 0 }).status).toBe("infrastructure-error");
    });
    test("a marker inside a failing selector and a closed browser cannot prove the assertion", () => {
        expect(
            classifyReport({
                report: report(
                    "failed",
                    `Error: Recorded action must resolve uniquely\nLocator: ${EXPECTATION_MARKER}\nexpect(locator).toHaveCount`
                ),
                exitCode: 1,
            }).status
        ).toBe("infrastructure-error");
        expect(
            classifyReport({
                report: report(
                    "failed",
                    `Error: ${EXPECTATION_MARKER}\nexpect(locator).toHaveText\nTarget page, context or browser has been closed`
                ),
                exitCode: 1,
            }).status
        ).toBe("infrastructure-error");
        expect(generateRepro({ ...recording, expectation: { ...recording.expectation!, kind: "value" } })).toContain(
            "Value assertion requires a form control"
        );
    });
    test("successful execution has a passed assertion and stable source fingerprint", () => {
        expect(classifyReport({ report: report("passed"), exitCode: 0 }).status).toBe("passed");
        expect(testHash(generateRepro(recording))).toBe(testHash(generateRepro(structuredClone(recording))));
        expect(testHash(generateRepro(recording))).not.toBe(
            testHash(generateRepro({ ...recording, expectation: { ...recording.expectation!, expected: "2" } }))
        );
    });
    test("imported workspaces cannot replace generated code or module dependencies", async () => {
        const root = await mkdtemp(join(tmpdir(), "bug-to-test-guard-"));
        const changedSource = await generateWorkspace({ recording, directory: join(root, "source") });
        await Bun.write(join(changedSource, "repro.spec.ts"), "throw new Error('imported code');");
        await expect(verifyWorkspace({ directory: changedSource })).rejects.toThrow("Generated test changed");
        await expect(exportWorkspace({ directory: changedSource, destination: join(root, "export") })).rejects.toThrow(
            "Generated test changed"
        );
        const changedModules = await generateWorkspace({ recording, directory: join(root, "modules") });
        await mkdir(join(changedModules, "node_modules"));
        await expect(verifyWorkspace({ directory: changedModules })).rejects.toThrow("Imported dependencies");
    });
    test("capture keeps non-HTTP navigation as evidence without losing valid actions", async () => {
        const invalidUrls = [
            "about:blank",
            "data:text/plain,fixture",
            "chrome-error://chromewebdata/",
            "https://[redacted]@site.test/",
        ];
        const evidence = invalidUrls.map((text, index) => ({
            id: `e${index}`,
            kind: "navigation" as const,
            text,
            excluded: false,
            at: index,
        }));
        const snapshot = recordingSnapshot({
            id: recording.id,
            title: recording.title,
            snapshot: {
                initialUrl: recording.initialUrl,
                actions: [
                    ...invalidUrls.map((url, index) => ({
                        id: `n${index}`,
                        kind: "navigate" as const,
                        url,
                        excluded: false,
                        at: index,
                    })),
                    { ...recording.actions[0], sourceUrl: "about:blank" },
                    {
                        id: "valid",
                        kind: "navigate",
                        url: "https://site.test/cart",
                        sourceUrl: "https://site.test/",
                        excluded: false,
                        at: 5,
                    },
                ],
                evidence,
            },
        });
        expect(parseRecording(snapshot).actions).toHaveLength(2);
        expect(snapshot.actions[0].sourceUrl).toBeUndefined();
        expect(snapshot.actions[1].sourceUrl).toBe("https://site.test/");
        expect(snapshot.evidence).toEqual(evidence);
        const root = await mkdtemp(join(tmpdir(), "bug-to-test-capture-"));
        const directory = await generateWorkspace({
            recording: { ...snapshot, expectation: recording.expectation },
            directory: join(root, "workspace"),
        });
        expect(await readFile(join(directory, "repro.spec.ts"), "utf8")).toContain(
            'page.goto(remap("https://site.test/cart"))'
        );
    });
    test("imported output symlinks are refused before spawning and preserve external data", async () => {
        const root = await mkdtemp(join(tmpdir(), "bug-to-test-output-"));
        const outside = join(root, "outside");
        await mkdir(outside);
        const sentinel = join(outside, "sentinel.txt");
        await Bun.write(sentinel, "preserve fixture");
        for (const name of ["runs", "runner.log", "verification.json"]) {
            const directory = await generateWorkspace({ recording, directory: join(root, name) });
            await symlink(name === "runs" ? outside : sentinel, join(directory, name));
            let spawned = false;
            await expect(
                verifyWorkspace({
                    directory,
                    onSpawn: () => {
                        spawned = true;
                    },
                })
            ).rejects.toThrow("never symlinks");
            expect(spawned).toBe(false);
            expect(await readFile(sentinel, "utf8")).toBe("preserve fixture");
        }
    });
    test("imported TypeScript aliases cannot redirect trusted Playwright imports", async () => {
        const root = await mkdtemp(join(tmpdir(), "bug-to-test-alias-"));
        const directory = await generateWorkspace({ recording, directory: join(root, "workspace") });
        await Bun.write(
            join(directory, "tsconfig.json"),
            '{"compilerOptions":{"paths":{"@playwright/test":["./evil.ts"]}}}'
        );
        await expect(verifyWorkspace({ directory })).rejects.toThrow("imported module aliases");
    });
    test("restored workspaces match the current executable recording and verified hash", async () => {
        const root = await mkdtemp(join(tmpdir(), "bug-to-test-restore-"));
        const directory = await generateWorkspace({ recording, directory: join(root, "workspace") });
        const result = {
            status: "passed",
            testHash: testHash(generateRepro(recording)),
            report: "fixture.json",
            message: "passed",
            durationMs: 1,
            exitCode: 0,
        };
        await Bun.write(join(directory, "verification.json"), SafeJSON.stringify(result));
        expect((await inspectWorkspace({ directory, recording })).result?.status).toBe("passed");
        await expect(
            inspectWorkspace({
                directory,
                recording: { ...recording, expectation: { ...recording.expectation!, expected: "2" } },
            })
        ).rejects.toThrow("does not match");
        await expect(inspectWorkspace({ directory, recording: { ...recording, actions: [] } })).rejects.toThrow(
            "does not match"
        );
        await Bun.write(join(directory, "verification.json"), SafeJSON.stringify({ ...result, testHash: "stale" }));
        expect((await inspectWorkspace({ directory, recording })).result).toBeUndefined();
    });
    test("imported package scripts never enter a portable executable bundle", async () => {
        const root = await mkdtemp(join(tmpdir(), "bug-to-test-package-"));
        const directory = await generateWorkspace({ recording, directory: join(root, "workspace") });
        await Bun.write(join(directory, "package.json"), '{"scripts":{"postinstall":"execute-untrusted"}}');
        await expect(exportWorkspace({ directory, destination: join(root, "export") })).rejects.toThrow(
            "Imported package scripts"
        );
        await expect(verifyWorkspace({ directory })).rejects.toThrow("Imported package scripts");
    });
    test.skipIf(process.platform === "win32")(
        "cancellation kills a TERM-resistant descendant after its leader exits",
        async () => {
            await mkdir("/tmp/cc/GenesisTools/bug-to-test", { recursive: true });
            const root = await mkdtemp("/tmp/cc/GenesisTools/bug-to-test/cancel-regression-");
            const directory = await generateWorkspace({ recording, directory: join(root, "workspace") });
            const childPidFile = join(root, "child.pid");
            const nodeBinary = Bun.which("node")!;
            const runner = join(root, "owned-runner.cjs");
            await Bun.write(
                runner,
                `#!${nodeBinary}\n
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} });
child.once('message', () => { require('node:fs').writeFileSync(${SafeJSON.stringify(childPidFile)}, String(child.pid)); child.disconnect(); });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`
            );
            await chmod(runner, 0o700);
            const which = spyOn(Bun, "which").mockImplementation((name) => (name === "node" ? runner : null));
            const controller = new AbortController();
            let childPid: number | undefined;
            const alive = isProcessAlive;
            const pending = verifyWorkspace({ directory, signal: controller.signal });
            try {
                await waitForPath(childPidFile, { timeoutMs: 5000 });
                childPid = Number(await readFile(childPidFile, "utf8"));
                expect(alive(childPid)).toBe(true);
                controller.abort();
                expect((await pending).status).toBe("cancelled");
                expect(alive(childPid)).toBe(false);
            } finally {
                controller.abort();
                await pending.catch((error) =>
                    logger.debug({ error }, "cancel regression teardown settled failed runner")
                );
                which.mockRestore();
                if (childPid && alive(childPid)) {
                    process.kill(childPid, "SIGKILL");
                }
            }
        },
        10000
    );
    test.skipIf(process.platform === "win32")(
        "ordinary completed verification still returns the reported assertion",
        async () => {
            await mkdir("/tmp/cc/GenesisTools/bug-to-test", { recursive: true });
            const root = await mkdtemp("/tmp/cc/GenesisTools/bug-to-test/normal-regression-");
            const directory = await generateWorkspace({ recording, directory: join(root, "workspace") });
            const runner = join(root, "ordinary-runner.cjs");
            await Bun.write(
                runner,
                `#!${Bun.which("node")}\nrequire('node:fs').writeFileSync(require('node:path').join(process.env.BUG_TO_TEST_RUN_DIR, 'report.json'), ${SafeJSON.stringify(SafeJSON.stringify(report("passed")))});\n`
            );
            await chmod(runner, 0o700);
            const which = spyOn(Bun, "which").mockImplementation((name) => (name === "node" ? runner : null));
            try {
                const result = await verifyWorkspace({ directory });
                expect(result.status).toBe("passed");
                expect(result.testHash).toBe(testHash(generateRepro(recording)));
            } finally {
                which.mockRestore();
            }
        }
    );
    test("redacts common credentials and refuses visibility ambiguity", () => {
        expect(redactBrowserText("Bearer secret123 https://site.test/?token=abc&password=xyz")).not.toContain(
            "secret123"
        );
        expect(redactBrowserText("https://user:password@site.test/")).not.toContain("password@");
        expect(redactBrowserText('api_key="fixture-secret" token: "fixture-token"')).not.toContain("fixture-secret");
        expect(redactBrowserText('api_key="fixture-secret" token: "fixture-token"')).not.toContain("fixture-token");
        expect(() => parseExpectation({ ...recording.expectation, kind: "visible", expected: "maybe" })).toThrow(
            "true or false"
        );
    });
});
