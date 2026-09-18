import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildPreflightReport, runCapturePlan } from "../lib/capture-runner";
import { ComputerReplEngine } from "../lib/computer-use/repl";
import { type ComputerState, ComputerUse } from "../lib/computer-use/session";
import { assistTask } from "../lib/decision/assist";
import { judgeOutcome } from "../lib/decision/decisions";
import { fillForm } from "../lib/decision/fill";
import { NativeControlDriver } from "../lib/decision/native";
import { NativeVisualDriver, visualObservationSchema, visualTask } from "../lib/decision/visual";
import { axCommandLine, ensureBinary } from "../lib/runner";

interface Element {
    index: number;
    role: string;
    AXTitle?: string;
    AXDescription?: string;
    AXValue?: string;
    AXIdentifier?: string;
    AXSubrole?: string;
    visible: boolean;
    actions: string[];
}

interface State {
    ok: boolean;
    error?: string;
    snapshot: string;
    elements: Element[];
    window: { id: number; x: number; y: number; width: number; height: number };
    windows?: { index: number }[];
    screenshot: { path: string };
}

const root = resolve(import.meta.dir, "../../..");
const backgroundOnly = Bun.argv.includes("--background-only");
const semantic = Bun.argv.includes("--semantic");
const cursorProof = Bun.argv.includes("--cursor-proof");
const verifyPointer = Bun.argv.includes("--verify-pointer");
const computerApi = Bun.argv.includes("--computer-api");
const visual = Bun.argv.includes("--visual");
const visualJev = Bun.argv.includes("--visual-jev");
if (visual && !backgroundOnly) {
    throw new Error("--visual requires --background-only for this fixture probe.");
}
if (visualJev && !visual) {
    throw new Error("--visual-jev requires --visual.");
}

if (Bun.argv.includes("--help")) {
    out.print(
        "Usage: bun src/control/scripts/live-smoke.ts [--background-only] [--verify-pointer] [--semantic] [--cursor-proof] [--visual] [--visual-jev]\n--visual requires --background-only and tests OCR/pixel guards; --visual-jev additionally enables one Jev target choice.\n--cursor-proof records five seconds of native cursor feedback on a disposable fixture (foreground).\n--semantic tests Jev fill/assist/judge with TYPESAFE_API_KEY (paid requests).\n--background-only avoids focus/keyboard tests and opens the fixture in the background.\n--verify-pointer asserts the physical pointer stays unchanged; keep mouse and keyboard idle during measurement.\nBuilds and opens a temporary two-window test app. Exercises see/act, then terminates only that app. Requires Accessibility and Screen Recording. Uses no Codex, Sky or Peekaboo.\n"
    );
    process.exit(0);
}

const native = ensureBinary();

async function command(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
    const commandLine = argv[0] === native ? axCommandLine(native, argv.slice(1)) : argv;
    const proc = Bun.spawn(commandLine, { cwd: root, env: env.getProcessEnv(), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 120_000);
    try {
        const [stdout, stderr, exit] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { stdout, stderr, exit };
    } finally {
        clearTimeout(timer);
    }
}

const directory = realpathSync(mkdtempSync(join(tmpdir(), "control-live-")));
logger.info({ directory }, "fixture artifacts");
const bundle = join(directory, "ControlFixture.app");
const executableDir = join(bundle, "Contents", "MacOS");
mkdirSync(executableDir, { recursive: true });
const fixtureBinary = join(executableDir, "control-fixture");
writeFileSync(
    join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>control-fixture</string>
<key>CFBundleIdentifier</key><string>com.genesiscz.control-fixture</string>
<key>CFBundleName</key><string>ControlFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
);
const readyPath = join(directory, "ready.log");
const errorPath = join(directory, "stderr.log");
const build = await command([
    "swiftc",
    join(root, "native/ax-tool/Fixtures/ControlFixture.swift"),
    "-o",
    fixtureBinary,
]);
assert.equal(build.exit, 0, build.stderr);
const launcher = Bun.spawn(
    [
        "open",
        "-n",
        "-W",
        ...(backgroundOnly ? ["-g"] : []),
        "--stdout",
        readyPath,
        "--stderr",
        errorPath,
        bundle,
        "--args",
        ...(backgroundOnly ? ["--background"] : []),
        ...(semantic ? ["--semantic"] : []),
        ...(cursorProof ? ["--cursor-proof"] : []),
        ...(visual ? ["--visual"] : []),
    ],
    {
        env: env.getProcessEnv(),
        stdout: "ignore",
        stderr: "pipe",
    }
);
const launcherErrors = new Response(launcher.stderr).text();
let fixturePid = 0;
const checks: string[] = [];
let windowIndex = 0;
let selectedWindowId: number | undefined;

async function run(args: string[], succeeds = true): Promise<State> {
    logger.debug({ command: args[0], completedChecks: checks.length }, "live control step");
    const result = await command([native, ...args]);
    // Exit code first: a crashed or timed-out binary leaves stdout empty, and parsing that
    // throws a JSON syntax error that buries the real stderr diagnostic.
    assert.equal(result.exit, succeeds ? 0 : 1, result.stdout || result.stderr);
    const data = SafeJSON.parse(result.stdout, { strict: true }) as State;
    assert.equal(data.ok, succeeds, result.stdout);
    return data;
}

async function see(): Promise<State> {
    return run([
        "see",
        "--app",
        String(fixturePid),
        ...(selectedWindowId === undefined
            ? ["--window-index", String(windowIndex)]
            : ["--window-id", String(selectedWindowId)]),
    ]);
}

async function act(
    state: State,
    element: number,
    action: string,
    extra: string[] = [],
    succeeds = true
): Promise<State> {
    return run(
        [
            "act",
            "--app",
            String(fixturePid),
            "--snapshot",
            state.snapshot,
            "--element",
            String(element),
            "--action",
            action,
            ...extra,
        ],
        succeeds
    );
}

function find(state: State, identifier: string): Element {
    const element = state.elements.find((element) => element.AXIdentifier === identifier);
    assert.ok(element, `missing ${identifier}`);
    return element;
}

function assertOnePageScrollFraction(value: string | undefined): void {
    const actual = Number(value);
    const expected = 160 / (600 - 160);
    assert.ok(Number.isFinite(actual), `scrollbar value is not numeric: ${value}`);
    assert.ok(Math.abs(actual - expected) < 0.08, `expected one 160px page near ${expected}, received ${actual}`);
}

try {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline && !fixturePid) {
        if (existsSync(readyPath)) {
            const match = readFileSync(readyPath, "utf8").match(/ready:(\d+)/);

            if (match) {
                fixturePid = Number(match[1]);
            }
        }

        if (!fixturePid) {
            await Bun.sleep(100);
        }
    }

    assert.ok(fixturePid > 0, "fixture startup timed out");
    const ambiguous = await run(["see", "--app", String(fixturePid)], false);
    assert.equal(ambiguous.windows?.length, 2, SafeJSON.stringify(ambiguous));
    checks.push("multiwindow inspection refuses an implicit selection");

    let state = await see();
    if (cursorProof) {
        buildPreflightReport(String(fixturePid));
        if (!state.elements.some((row) => row.AXIdentifier === "cursor-proof")) {
            windowIndex = 1;
            state = await see();
        }
        const { x, y, width, height } = state.window;
        const proof = await runCapturePlan({
            capture: {
                backend: "native",
                mode: "region",
                region: [x, y, width + 180, height].join(","),
                duration: 5,
                activeFps: 15,
                idleFps: 5,
                threshold: 0.05,
                videoOut: join(directory, "cursor-proof.mp4"),
            },
            actions: [
                { atMs: 700, do: "ax-press", app: String(fixturePid), axId: "cursor-proof" },
                {
                    atMs: 1900,
                    do: "ax-set",
                    app: String(fixturePid),
                    axId: "cursor-proof-input",
                    value: "Animated cursor",
                },
                { atMs: 3400, do: "ax-press", app: String(fixturePid), axId: "cursor-proof" },
            ],
        });
        assert.equal(proof.captureFailed, false, SafeJSON.stringify(proof));
        assert.ok(
            proof.actions.every((action) => action.ok),
            SafeJSON.stringify(proof)
        );
        const proofPath = join(directory, "cursor-proof.json");
        await Bun.write(proofPath, SafeJSON.stringify(proof, null, 2));
        out.result({ cursorProof: proofPath, sessionDir: proof.sessionDir, warnings: proof.warnings });
        checks.push("Cua cursor animation recorded during native press/set/press on the dedicated fixture");
        windowIndex = 0;
        state = await see();
    }
    if (semantic) {
        const evaluate = await createEvaluator({ provider: "typesafe" });
        const driver = new NativeControlDriver({ app: String(fixturePid), windowId: state.window.id });
        const filled = await fillForm({ driver, data: { input: "Semantic fixture value" }, evaluate });
        assert.equal(filled.status, "filled", SafeJSON.stringify(filled));
        const assisted = await assistTask({
            driver,
            goal: "Enable Show line numbers",
            exact: { identifier: "line-numbers", value: "1" },
            evaluate,
            limits: { maxActions: 2, maxRequests: 4, timeoutMs: 30000 },
        });
        assert.equal(assisted.status, "verified", SafeJSON.stringify(assisted));
        const judgment = await judgeOutcome({
            observation: await driver.observe({}),
            expect: "The Show line numbers checkbox is enabled (checked).",
            evaluate,
        });
        assert.notEqual(judgment.status, "refuted", SafeJSON.stringify(judgment));
        assert.equal(judgment.basis, "semantic");
        const witness = judgment.evaluation?.answers.witness;
        assert.equal(
            witness?.type === "choice" ? witness.choice : undefined,
            `e${(await driver.observe({})).elements.find((row) => row.AXIdentifier === "line-numbers")?.index}`
        );
        checks.push(
            "Direct TypeSafe maps an input, native AX set reads back exactly, bounded assist enables line numbers, semantic judge identifies the observed checkbox (unknown remains valid below the confidence gate)"
        );
        out.result({
            semantic: {
                fill: filled.metrics,
                assist: assisted.metrics,
                judgment: { status: judgment.status, probabilities: judgment.probabilities },
            },
        });
        state = await see();
        await act(state, find(state, "input").index, "set", ["--value", "seed"]);
        state = await see();
    }
    if (!cursorProof) {
        const duplicates = state.elements.filter((element) => element.AXTitle === "Increment");
        assert.equal(duplicates.length, 2);
        assert.ok(duplicates.every((element) => !element.AXIdentifier));
        await act(state, duplicates[1].index, "press");
        const stale = await act(state, duplicates[1].index, "press", [], false);
        assert.match(stale.error ?? "", /UI changed/);
        state = await see();
        assert.equal(find(state, "counter").AXValue, "10");
        checks.push("anonymous duplicate button resolves exactly; stale replay refuses before increment");
        const other = await run(
            ["act", "--app", String(process.pid), "--snapshot", state.snapshot, "--element", "0", "--action", "press"],
            false
        );
        assert.match(other.error ?? "", /different app|launch identity|app not found|running process/);
        checks.push("wrong app does not receive the action");

        const invalid = await act(state, 99999, "press", [], false);
        assert.match(invalid.error ?? "", /index outside/);
        const disabled = state.elements.find((element) => element.AXTitle === "Disabled") as
            | (Element & { x: number; y: number; width: number; height: number })
            | undefined;
        assert.ok(disabled);
        await act(state, disabled.index, "press", [], false);
        const disabledCoordinate = await run(
            [
                "act",
                "--app",
                String(fixturePid),
                "--snapshot",
                state.snapshot,
                "--action",
                "move",
                "--background",
                "--coords",
                `${disabled.x + disabled.width / 2},${disabled.y + disabled.height / 2}`,
            ],
            false
        );
        assert.match(disabledCoordinate.error ?? "", /element is disabled/);
        assert.equal(find(await see(), "counter").AXValue, "10");
        checks.push("invalid index plus element and cursor coordinate actions refuse a disabled button");

        windowIndex = 1;
        const second = await see();
        assert.notEqual(second.window.id, state.window.id);
        assert.equal(find(second, "counter").AXValue, "0");
        checks.push("identically titled second window stays untouched");
        if (!backgroundOnly) {
            await act(second, 0, "focus");
        }
        windowIndex = 0;
        selectedWindowId = state.window.id;
        state = await see();
        const button = state.elements.find((element) => element.AXTitle === "Increment");
        assert.ok(button);
        const wrongWindow = await act(state, button.index, "click", [], false);
        const pointerBeforeResult = await command([native, "snapshot"]);
        const pointerBefore = SafeJSON.parse(pointerBeforeResult.stdout, { strict: true }) as {
            mouse: { x: number; y: number };
            pid: number;
        };
        const targetButton = state.elements.find((element) => element.AXTitle === "Increment") as
            | (Element & { x: number; y: number; width: number; height: number })
            | undefined;
        assert.ok(targetButton);
        await run([
            "act",
            "--app",
            String(fixturePid),
            "--snapshot",
            state.snapshot,
            "--action",
            "click",
            "--background",
            "--coords",
            `${targetButton.x + targetButton.width / 2},${targetButton.y + targetButton.height / 2}`,
        ]);
        const pointerAfterResult = await command([native, "snapshot"]);
        const pointerAfter = SafeJSON.parse(pointerAfterResult.stdout, { strict: true }) as {
            mouse: { x: number; y: number };
            pid: number;
        };
        if (verifyPointer) {
            assert.deepEqual(pointerAfter.mouse, pointerBefore.mouse);
        }
        assert.equal(pointerAfter.pid, pointerBefore.pid);
        state = await see();
        assert.equal(find(state, "counter").AXValue, "11");
        if (backgroundOnly) {
            const stillWrongWindow = await act(state, button.index, "click", [], false);
            assert.match(stillWrongWindow.error ?? "", /wrong frontmost app\/window/);
        }
        checks.push(
            verifyPointer
                ? "background coordinate click preserves the idle pointer and foreground app"
                : "background coordinate click activates the control and preserves the foreground app"
        );
        assert.match(wrongWindow.error ?? "", /wrong frontmost app\/window/);
        checks.push("click refuses when another window of the same app is focused");

        if (backgroundOnly) {
            await act(state, button.index, "click", ["--background", "--button", "right"]);
            state = await see();
            assert.equal(find(state, "counter").AXValue, "111");
            checks.push("background right-click delivers the secondary mouse button");
            const drag = find(state, "drag") as Element & { x: number; y: number; width: number; height: number };
            await act(state, drag.index, "drag", [
                "--background",
                "--to",
                `${drag.x + drag.width / 2 + 30},${drag.y + drag.height / 2}`,
            ]);
            state = await see();
            assert.equal(find(state, "dragStatus").AXValue, "dragged");
            checks.push("window-addressed drag delivers down, movement and release");
            const scrollChild = state.elements.find(
                (element) => element.role === "AXStaticText" && element.AXValue === "Row 0"
            );
            assert.ok(scrollChild);
            const before = state.elements.find((element) => element.role === "AXScrollBar")?.AXValue;
            await act(state, scrollChild.index, "scroll", ["--background", "--direction", "down", "--pages", "1"]);
            state = await see();
            const afterChildPage = state.elements.find((element) => element.role === "AXScrollBar")?.AXValue;
            assert.notEqual(afterChildPage, before);
            assertOnePageScrollFraction(afterChildPage);
            checks.push("background page scroll from a child uses its receiving 160px viewport");
            await act(state, find(state, "input").index, "select", ["--text", "ee"]);
            state = await see();
            assert.equal((find(state, "input") as Element & { AXSelectedText?: string }).AXSelectedText, "ee");
            checks.push("semantic selection selects the unique observed text");
        }

        if (!backgroundOnly) {
            await act(state, 0, "focus");
            state = await see();
            await act(state, find(state, "input").index, "set", ["--value", "checked"]);
            state = await see();
            assert.equal(find(state, "input").AXValue, "checked");
            await act(state, find(state, "input").index, "focus");
            state = await see();
            await act(state, find(state, "input").index, "key", ["--keys", "cmd,a"]);
            state = await see();
            await act(state, find(state, "input").index, "type", ["--text", "Příliš žluťoučký 🐈"]);
            state = await see();
            assert.equal(find(state, "input").AXValue, "Příliš žluťoučký 🐈");
            checks.push("AX set read-back, explicit focus, targeted key and Unicode typing update only the test input");
            await act(state, find(state, "input").index, "select", ["--text", "Příliš žluťoučký 🐈"]);
            state = await see();
            const pasted = await act(state, find(state, "input").index, "paste", [
                "--text",
                "pasted 🐈",
                "--format",
                "text",
            ]);
            assert.equal((pasted as State & { clipboardRestore?: string }).clipboardRestore, "restored");
            state = await see();
            assert.equal(find(state, "input").AXValue, "pasted 🐈");
            checks.push("paste replaces the selected text and restores the clipboard");
            await act(state, find(state, "input").index, "select", ["--text", "pasted 🐈"]);
            state = await see();
            await act(state, find(state, "input").index, "type", ["--text", "--background"]);
            state = await see();
            assert.equal(find(state, "input").AXValue, "--background");
            checks.push("option-looking text stays literal input and cannot enable background dispatch");
            const clickButton = state.elements.find((element) => element.AXTitle === "Increment");
            assert.ok(clickButton);
            await act(state, clickButton.index, "click");
            state = await see();
            assert.equal(find(state, "counter").AXValue, "12");
            const doubleButton = state.elements.find((element) => element.AXTitle === "Increment");
            assert.ok(doubleButton);
            await act(state, doubleButton.index, "click", ["--double"]);
            state = await see();
            assert.equal(find(state, "counter").AXValue, "14");
            const performButton = state.elements.find((element) => element.AXTitle === "Increment");
            assert.ok(performButton);
            await act(state, performButton.index, "perform", ["--ax-action", "AXPress"]);
            state = await see();
            assert.equal(find(state, "counter").AXValue, "15");
            checks.push("physical click, double-click and exposed perform action change the expected counter");

            const offscreen = state.elements.find((element) => element.AXTitle === "Offscreen");
            assert.ok(offscreen && !offscreen.visible);
            const clipped = await act(state, offscreen.index, "click", [], false);
            assert.match(clipped.error ?? "", /outside.*clip/);
            const coordinateRow = state.elements.find(
                (element) => element.role === "AXStaticText" && element.AXValue === "Row 0"
            ) as (Element & { x: number; y: number; width: number; height: number }) | undefined;
            assert.ok(coordinateRow);
            const scrollbar = state.elements.find((element) => element.role === "AXScrollBar");
            assert.ok(scrollbar);
            const beforeScroll = scrollbar.AXValue;
            const pageResult = await command([
                native,
                "act",
                "--app",
                String(fixturePid),
                "--snapshot",
                state.snapshot,
                "--action",
                "scroll",
                "--coords",
                `${coordinateRow.x + coordinateRow.width / 2},${coordinateRow.y + coordinateRow.height / 2}`,
                "--direction",
                "down",
            ]);
            const page = SafeJSON.parse(pageResult.stdout, { strict: true }) as State;
            assert.equal(pageResult.exit, page.ok ? 0 : 1);
            state = await see();
            const afterPage = state.elements.find((element) => element.role === "AXScrollBar")?.AXValue;
            assert.equal(page.ok, true, page.error);
            assert.notEqual(afterPage, beforeScroll);
            assertOnePageScrollFraction(afterPage);
            checks.push("coordinate page scroll uses the receiving 160px viewport");
            await act(state, find(state, "scroll").index, "scroll", ["--direction", "down", "--pixels", "80"]);
            state = await see();
            assert.notEqual(state.elements.find((element) => element.role === "AXScrollBar")?.AXValue, afterPage);
            assert.equal(find(state, "counter").AXValue, "15");
            checks.push("offscreen click refuses; explicitly requested pixel scroll changes the viewport");

            const expiredData = SafeJSON.parse(Buffer.from(state.snapshot, "base64").toString("utf8")) as {
                created: number;
            };
            expiredData.created = 1;
            const expiredState = {
                ...state,
                snapshot: Buffer.from(SafeJSON.stringify(expiredData)).toString("base64"),
            };
            const expired = await act(expiredState, 0, "focus", [], false);
            assert.match(expired.error ?? "", /expired/);
            checks.push("expired snapshot refuses before focus");

            const lastShot = state.screenshot.path;
            const close = state.elements.find((element) => element.AXSubrole === "AXCloseButton");
            assert.ok(close);
            await act(state, close.index, "press");
            const closed = await act(state, 0, "get", [], false);
            assert.match(closed.error ?? "", /closed|offscreen|missing/);
            const missing = await run(
                ["see", "--app", String(fixturePid), "--window-id", String(state.window.id)],
                false
            );
            assert.match(missing.error ?? "", /closed|offscreen|missing/);
            checks.push("closed window token and stable-ID refresh refuse without selecting the remaining window");
            state.screenshot.path = lastShot;
        }
    }
    if (visual) {
        state = await see();
        const countBefore = find(state, "counter").AXValue;
        const oldCapture = state;
        await act(state, find(state, "paint").index, "press");
        await Bun.sleep(100);
        const fresh = await see();
        const oldToken = SafeJSON.parse(Buffer.from(oldCapture.snapshot, "base64").toString("utf8")) as {
            digest: string;
            visual: { pixelHash: string };
        };
        const freshToken = SafeJSON.parse(Buffer.from(fresh.snapshot, "base64").toString("utf8")) as {
            digest: string;
            visual: { pixelHash: string };
        };
        assert.equal(oldToken.digest, freshToken.digest, "canvas changed without changing AX evidence");
        assert.notEqual(oldToken.visual.pixelHash, freshToken.visual.pixelHash);
        const increment = oldCapture.elements.find((row) => row.AXTitle === "Increment") as Element & {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        const refused = await run(
            [
                "act",
                "--app",
                String(fixturePid),
                "--snapshot",
                oldCapture.snapshot,
                "--action",
                "click",
                "--background",
                "--coords",
                `${increment.x + increment.width / 2},${increment.y + increment.height / 2}`,
            ],
            false
        );
        assert.match(refused.error ?? "", /pixels changed/);
        assert.equal(find(await see(), "counter").AXValue, countBefore);
        checks.push("changed canvas pixels refuse an old coordinate click even when AX digest is identical");

        state = await see();
        const quietPoint = `${state.window.x + state.window.width - 8},${state.window.y + state.window.height - 8}`;
        const move = [
            "act",
            "--app",
            String(fixturePid),
            "--snapshot",
            state.snapshot,
            "--action",
            "move",
            "--background",
            "--coords",
            quietPoint,
        ];
        await run(move);
        const reused = await run(move, false);
        assert.match(reused.error ?? "", /already used/);
        checks.push("a visual capture is consumed once across separate native processes");

        const capture = visualObservationSchema.parse(
            await run([
                "see",
                "--app",
                String(fixturePid),
                "--window-id",
                String(state.window.id),
                "--perception",
                "ocr",
            ])
        );
        assert.ok(
            capture.perception.regions.some((region) => region.text.trim() === "Paint"),
            SafeJSON.stringify(capture.perception.regions)
        );
        assert.ok(
            !capture.perception.regions.some((region) => region.text.includes("seed")),
            "Known AX input text is excluded from OCR candidates"
        );
        const paint = find(await see(), "paint") as Element & { x: number; y: number; width: number; height: number };
        const scaleX = capture.screenshot.width / capture.window.width;
        const scaleY = capture.screenshot.height / capture.window.height;
        const crop = [
            Math.max(0, Math.floor((paint.x - capture.window.x) * scaleX) - 4),
            Math.max(0, Math.floor((paint.y - capture.window.y) * scaleY) - 4),
            Math.ceil(paint.width * scaleX) + 8,
            Math.ceil(paint.height * scaleY) + 8,
        ].join(",");
        const driver = new NativeVisualDriver({
            app: String(fixturePid),
            windowId: state.window.id,
            crop,
            width: 400,
            background: true,
        });
        const beforeVisual = SafeJSON.parse(Buffer.from((await see()).snapshot, "base64").toString("utf8")) as {
            visual: { pixelHash: string };
        };
        const result = await visualTask({
            driver,
            intent: visualJev ? "Click the Paint control" : "Paint",
            chooser: visualJev ? "jev" : "exact",
            execute: true,
            evaluate: visualJev ? await createEvaluator({ provider: "typesafe" }) : undefined,
        });
        assert.equal(result.choice.status, "resolved", SafeJSON.stringify(result.choice));
        assert.equal(result.action?.ok, true, SafeJSON.stringify(result.action));
        await Bun.sleep(100);
        state = await see();
        const afterVisual = SafeJSON.parse(Buffer.from(state.snapshot, "base64").toString("utf8")) as {
            visual: { pixelHash: string };
        };
        assert.notEqual(beforeVisual.visual.pixelHash, afterVisual.visual.pixelHash);
        assert.equal(find(state, "counter").AXValue, countBefore);
        writeFileSync(join(directory, "visual-proof.json"), SafeJSON.stringify(result, null, 2));
        checks.push(
            `native OCR crop/resize region maps to its exact screen control; ${visualJev ? "Jev" : "exact"} choice clicks it with changed pixels and unchanged counter`
        );
    }
    if (computerApi) {
        const app = String(fixturePid);
        const originalFront = SafeJSON.parse((await command([native, "snapshot"])).stdout) as { pid: number };
        const computer = new ComputerUse({ timeoutMs: 30000 });
        try {
            let observed = await computer.get_app_state({ app, window_index: 0, image: false });
            const named = (id: string) => {
                const row = observed.elements.find((element) => element.identifier === id);
                assert.ok(row, id);
                return row;
            };
            const counterBefore = Number(named("counter").value);
            const firstButton = () => {
                const row = observed.elements.find((element) => element.label === "Increment");
                assert.ok(row);
                return row;
            };
            let result = await computer.click({ app, element_ref: firstButton().ref });
            assert.ok(result.ok && result.state);
            observed = result.state;
            assert.equal(Number(named("counter").value), counterBefore + 1);
            result = await computer.set_value({ app, element_ref: named("input").ref, value: "API fixture" });
            assert.ok(result.ok && result.state);
            observed = result.state;
            assert.equal(named("input").value, "API fixture");
            result = await computer.focus({ app, element_ref: named("input").ref });
            assert.ok(result.ok && result.state);
            observed = result.state;
            result = await computer.press_key({ app, revision: observed.revision, key: "super+a" });
            assert.ok(result.ok && result.state);
            observed = result.state;
            result = await computer.type_text({ app, revision: observed.revision, text: "Native 🐈" });
            assert.ok(result.ok && result.state);
            observed = result.state;
            assert.equal(named("input").value, "Native 🐈");
            result = await computer.select_text({ app, element_ref: named("input").ref, text: "Native 🐈" });
            assert.ok(result.ok && result.state);
            observed = result.state;
            result = await computer.paste({ app, revision: observed.revision, text: "API pasted", format: "text" });
            assert.ok(result.ok && result.state);
            assert.equal(result.clipboardRestore, "restored");
            observed = result.state;
            assert.equal(named("input").value, "API pasted");
            result = await computer.perform_secondary_action({ app, element_ref: firstButton().ref, action: "press" });
            assert.ok(result.ok && result.state);
            observed = result.state;
            assert.equal(Number(named("counter").value), counterBefore + 2);
            result = await computer.scroll({ app, element_ref: named("scroll").ref, direction: "down", pixels: 60 });
            assert.ok(result.ok && result.state);
            observed = result.state;
            observed = await computer.get_app_state({ app, window_id: observed.window.id, image: true });
            const drag = named("drag");
            assert.ok(drag.bounds && observed.screenshot);
            const x = (drag.bounds.x - observed.window.x + drag.bounds.width / 2) * observed.screenshot.scaleX;
            const y = (drag.bounds.y - observed.window.y + drag.bounds.height / 2) * observed.screenshot.scaleY;
            result = await computer.drag({
                app,
                revision: observed.revision,
                from_x: x,
                from_y: y,
                to_x: x + 30 * observed.screenshot.scaleX,
                to_y: y,
            });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            observed = result.state;
            assert.equal(named("dragStatus").value, "dragged");
            checks.push(
                "independent API reads/diffs, clicks, sets, focuses, keys, types Unicode, selects, pastes with restoration, performs AX actions, scrolls and drags"
            );

            const transport = new StdioClientTransport({
                command: process.execPath,
                args: [join(root, "src/computer-use/index.ts"), "mcp"],
                stderr: "pipe",
            });
            transport.stderr?.on("data", (chunk) =>
                logger.debug({ stderr: String(chunk).slice(0, 2000) }, "Computer MCP stderr")
            );
            const client = new Client({ name: "native-fixture", version: "1" });
            await client.connect(transport);
            try {
                const response = await client.callTool({
                    name: "get_app_state",
                    arguments: { app, window_id: observed.window.id, image: false },
                });
                assert.ok("content" in response && Array.isArray(response.content));
                const text = response.content.find((item) => item.type === "text");
                assert.ok(text && "text" in text && typeof text.text === "string");
                const mcpState = SafeJSON.parse(text.text) as ComputerState;
                const field = mcpState.elements.find((element) => element.identifier === "input");
                assert.ok(field);
                const set = await client.callTool({
                    name: "set_value",
                    arguments: { app, element_ref: field.ref, value: "MCP verified" },
                });
                assert.ok(!set.isError);
            } finally {
                await client.close();
            }
            state = await run(["see", "--app", app, "--window-id", String(observed.window.id), "--no-image"]);
            assert.equal(find(state, "input").AXValue, "MCP verified");
            checks.push("standalone stdio MCP process observes and edits the native fixture without Codex or Sky");

            const engine = new ComputerReplEngine();
            try {
                const first = await engine.run(
                    `const appState = await computer.get_app_state({app:${SafeJSON.stringify(app)},window_id:${observed.window.id},image:false}); appState.elements.length`
                );
                assert.ok(first.ok, first.error);
                const second = await engine.run(
                    `const edited = await computer.set_value({app:${SafeJSON.stringify(app)},element_ref:appState.elements.find(e=>e.identifier==="input").ref,value:"REPL verified"}); edited.ok`
                );
                assert.ok(second.ok && second.text === "true", second.error ?? second.text);
            } finally {
                engine.dispose();
            }
            state = await run(["see", "--app", app, "--window-id", String(observed.window.id)]);
            assert.equal(find(state, "input").AXValue, "REPL verified");
            checks.push("independent REPL preserves the observed app state across cells and performs a native edit");
        } finally {
            computer.close_session();
            const currentFront = SafeJSON.parse((await command([native, "snapshot"])).stdout) as { pid: number };
            if (currentFront.pid === fixturePid && originalFront.pid !== fixturePid) {
                const restored = await command([native, "focus", "--app", String(originalFront.pid)]);
                if (restored.exit !== 0) {
                    logger.warn({ stderr: restored.stderr }, "Could not restore original front app");
                }
            }
        }
    }
    out.result({ ok: true, checks, screenshot: state.screenshot.path, directory });
} finally {
    if (fixturePid > 0) {
        const identity = classifyPid(fixturePid, (command) => {
            const trimmed = command.trim();
            return trimmed === fixtureBinary || trimmed.startsWith(fixtureBinary.concat(" "));
        });

        if (identity.status === "live") {
            try {
                // pid-verified: classifyPid matched the exact temporary fixtureBinary path before cleanup signalling
                process.kill(fixturePid, "SIGTERM");
            } catch (err) {
                logger.warn({ err, fixturePid }, "control fixture cleanup signal failed");
            }
        } else {
            logger.warn({ fixturePid, status: identity.status }, "skipping unverified control fixture signal");
        }
    }

    try {
        launcher.kill();
    } catch (err) {
        logger.warn({ err }, "control fixture launcher cleanup failed");
    }
    await launcher.exited;
    const errors = await launcherErrors;

    if (errors.trim()) {
        logger.debug({ errors }, "control fixture stderr");
    }
}
