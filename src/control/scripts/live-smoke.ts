import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
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
import { judgeOutcome } from "../lib/decision/decisions";
import { fillForm } from "../lib/decision/fill";
import { NativeControlDriver } from "../lib/decision/native";
import { NativeVisualDriver, visualObservationSchema, visualTask } from "../lib/decision/visual";
import { axCommandLine, ensureBinary, setCursorFeedbackEnabled } from "../lib/runner";
import { benchmarkNativeRefresh } from "./native-refresh-benchmark";
import { benchmarkControlTask } from "./task-benchmark";

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
    snapshot: string;
    error?: string;
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
const dropdown = Bun.argv.includes("--dropdown");
const benchmark = Bun.argv.includes("--benchmark");
const taskBenchmark = Bun.argv.includes("--task-benchmark");
const hostPaced = Bun.argv.includes("--host-paced");
const guardRecovery = Bun.argv.includes("--guard-recovery");
const visual = Bun.argv.includes("--visual");
const visualJev = Bun.argv.includes("--visual-jev");
if (guardRecovery && [cursorProof, benchmark, taskBenchmark, computerApi, semantic, dropdown, visual].some(Boolean)) {
    throw new Error("Run --guard-recovery separately from other fixture modes.");
}
if (hostPaced && !taskBenchmark) {
    throw new Error("--host-paced requires --task-benchmark.");
}
if (taskBenchmark && (benchmark || visual || cursorProof || semantic || computerApi || dropdown)) {
    throw new Error("Run --task-benchmark separately; it explicitly spends TypeSafe Jev requests.");
}
if (benchmark && (visual || cursorProof || semantic || computerApi)) {
    throw new Error("Run --benchmark separately from interaction/visual modes.");
}
if (visual && !backgroundOnly) {
    throw new Error("--visual requires --background-only for this fixture probe.");
}
if (visualJev && !visual) {
    throw new Error("--visual-jev requires --visual.");
}

if (Bun.argv.includes("--help")) {
    out.print(
        "--guard-recovery runs a disposable input whose first AX focus request is deflected; proves one bounded native retry and exactly one paste."
    );
    out.print(
        "Task comparison: --task-benchmark [--host-paced] explicitly spends TypeSafe Jev requests on a disposable checkbox task. Interleaved stepwise/compound modes verify exact state. --host-paced reads next commands from stdin to measure real host dispatch boundaries."
    );
    out.print(
        "Usage: bun src/control/scripts/live-smoke.ts [--background-only] [--verify-pointer] [--semantic] [--dropdown] [--cursor-proof] [--visual] [--visual-jev] [--computer-api] [--benchmark]\n--visual requires --background-only and tests OCR/pixel guards; --visual-jev additionally enables one Jev target choice.\n--cursor-proof records five seconds of native cursor feedback on a disposable fixture (foreground).\n--semantic tests Jev fill/assist/judge with TYPESAFE_API_KEY (paid requests).\n--dropdown tests exact native options with cursor feedback disabled; with --semantic also tests Jev form mapping.\n--background-only avoids baseline focus/keyboard tests and opens the fixture in the background; semantic/API modes may prepare targets.\n--verify-pointer asserts the physical pointer stays unchanged; keep mouse and keyboard idle during measurement.\nBuilds and opens a temporary two-window test app. Exercises see/act, then terminates only that app. Requires Accessibility and Screen Recording. Uses no Codex, Sky or Peekaboo.\n"
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
        ...(guardRecovery ? ["--guard-recovery"] : []),
        ...(taskBenchmark && !semantic ? ["--semantic"] : []),
        ...(visual ? ["--visual"] : []),
        ...(computerApi ? ["--delayed-save"] : []),
        ...(dropdown ? ["--dropdown"] : []),
        ...(!cursorProof && !benchmark && !taskBenchmark && !computerApi ? ["--anonymous-buttons"] : []),
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
let lastCapture: State | undefined;

async function run(args: string[], succeeds = true): Promise<State> {
    logger.debug({ command: args[0], completedChecks: checks.length }, "live control step");
    const result = await command([native, ...args]);
    if (succeeds && result.exit !== 0 && lastCapture && result.stdout.includes("window pixels changed")) {
        const fresh = await command([
            native,
            "see",
            "--app",
            String(fixturePid),
            "--window-id",
            String(lastCapture.window.id),
        ]);
        await Bun.write(
            join(directory, "pixel-refusal.json"),
            SafeJSON.stringify(
                {
                    prior: lastCapture,
                    fresh: fresh.stdout,
                    refusal: result.stdout,
                    checks,
                },
                null,
                2
            )
        );
        logger.warn({ directory }, "Saved before/after evidence for the pixel refusal");
    }
    // Exit code first: a crashed or timed-out binary leaves stdout empty, and parsing that
    // throws a JSON syntax error that buries the real stderr diagnostic.
    assert.equal(result.exit, succeeds ? 0 : 1, result.stdout || result.stderr);
    const data = SafeJSON.parse(result.stdout, { strict: true }) as State;
    assert.equal(data.ok, succeeds, result.stdout);
    if (data.screenshot) {
        lastCapture = data;
    }
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
    if (guardRecovery) {
        const computer = new ComputerUse();
        try {
            const app = String(fixturePid);
            const observed = await computer.get_app_state({ app, window_id: state.window.id, image: false });
            const field = observed.elements.find((row) => row.identifier === "input");
            assert.ok(field);
            const result = await computer.paste({
                app,
                element_ref: field.ref,
                text: "Recovered once",
                replace: true,
                prepare: true,
            });
            if (!result.ok || !result.state) {
                const fresh = await computer.get_app_state({ app, window_id: state.window.id, image: false });
                writeFileSync(join(directory, "recovery-failure.json"), SafeJSON.stringify({ result, fresh }, null, 2));
            }
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            assert.deepEqual(
                result.recovery && typeof result.recovery === "object"
                    ? Reflect.get(result.recovery, "refusals")
                    : undefined,
                ["focus_mismatch"]
            );
            assert.equal(result.state.elements.find((row) => row.identifier === "input")?.value, "Recovered once");
            assert.equal(result.state.elements.find((row) => row.identifier === "recovery-decoy")?.value, "untouched");
            assert.equal(result.state.elements.find((row) => row.identifier === "counter")?.value, "1");
            writeFileSync(join(directory, "recovery-proof.json"), SafeJSON.stringify(result, null, 2));
            out.result({
                recovery: result.recovery,
                targetValue: "Recovered once",
                decoyValue: "untouched",
                inputEvents: 1,
                jevRequests: 0,
            });
            checks.push(
                "real native focus refusal recovers in the same action; one paste, unchanged decoy, no AI call"
            );
        } finally {
            computer.close_session();
        }
    }
    if (dropdown) {
        setCursorFeedbackEnabled(false);
        await command([native, "cursor-feedback", "--hide"]);
        selectedWindowId = state.window.id;
        const computer = new ComputerUse();
        try {
            const app = String(fixturePid);
            let observed = await computer.get_app_state({ app, window_id: state.window.id, image: false });
            const field = observed.elements.find((row) => row.identifier === "priority");
            assert.ok(field);
            const chosen = await computer.set_value({ app, element_ref: field.ref, value: "High" });
            assert.ok(chosen.ok && chosen.state, SafeJSON.stringify(chosen));
            assert.equal(chosen.state.elements.find((row) => row.identifier === "priority")?.value, "High");
            observed = await computer.get_app_state({ app, window_id: state.window.id, image: false });
            const current = observed.elements.find((row) => row.identifier === "priority");
            assert.ok(current);
            const rejected = await computer.set_value({ app, element_ref: current.ref, value: "Missing choice" });
            assert.equal(rejected.ok, false);
            observed = await computer.get_app_state({ app, window_id: state.window.id, image: false });
            assert.equal(observed.elements.find((row) => row.identifier === "priority")?.value, "High");
            out.result({ dropdown: { selected: "High", exactReadback: true, missingOptionRejected: true } });
            checks.push(
                "public dropdown set selects one exact option, verifies value and refuses a missing option without changing it"
            );
        } finally {
            computer.close_session();
        }
        selectedWindowId = undefined;
        state = await see();
    }
    if (cursorProof) {
        buildPreflightReport(String(fixturePid));
        if (!state.elements.some((row) => row.AXIdentifier === "cursor-proof")) {
            windowIndex = 1;
            state = await see();
        }
        selectedWindowId = state.window.id;
        await run([
            "act",
            "--app",
            String(fixturePid),
            "--snapshot",
            state.snapshot,
            "--element",
            "0",
            "--action",
            "focus",
            "--refresh",
            "--no-image",
        ]);
        state = await see();
        if (env.get("GENESIS_CONTROL_CURSOR_WAIT") === "required") {
            const target = state.elements.find((row) => row.AXIdentifier === "cursor-proof");
            assert.ok(target);
            const refused = await run(
                [
                    "act",
                    "--app",
                    String(fixturePid),
                    "--snapshot",
                    state.snapshot,
                    "--element",
                    String(target.index),
                    "--action",
                    "press",
                    "--no-cursor",
                ],
                false
            );
            assert.equal(refused.ok, false, "Required feedback must reject disabled feedback");
            assert.match(refused.error ?? "", /Required cursor feedback/);
            state = await see();
            assert.equal(state.elements.find((row) => row.AXIdentifier === "cursor-proof")?.AXValue, "0");
            checks.push("required cursor feedback refuses before the fixture checkbox changes");
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
        selectedWindowId = undefined;
        windowIndex = 0;
        state = await see();
    }
    if (semantic) {
        const previousFront = SafeJSON.parse((await command([native, "snapshot"])).stdout) as { pid: number };
        try {
            const evaluate = await createEvaluator({ provider: "typesafe" });
            const driver = new NativeControlDriver({ app: String(fixturePid), windowId: state.window.id });
            const filled = await fillForm({ driver, data: { input: "Semantic fixture value" }, evaluate });
            assert.equal(filled.status, "filled", SafeJSON.stringify(filled));
            const computer = new ComputerUse({ evaluate });
            const dropdownFill = dropdown
                ? await computer.fill_form({
                      app: String(fixturePid),
                      window_id: state.window.id,
                      data: { Priority: "Low" },
                      jev: true,
                      provider: "typesafe",
                      max_requests: 1,
                      timeout_ms: 10000,
                  })
                : undefined;
            if (dropdownFill) {
                assert.equal(dropdownFill.status, "filled", SafeJSON.stringify(dropdownFill));
                checks.push("public Jev form fill maps Priority to a native dropdown and verifies the selected option");
            }
            const beforeAssist = SafeJSON.parse((await command([native, "snapshot"])).stdout) as { pid: number };
            const assisted = await computer.assist_task({
                app: String(fixturePid),
                window_id: state.window.id,
                goal: "Enable Show line numbers",
                exact: { identifier: "line-numbers", value: "1" },
                chooser: "jev",
                jev: true,
                provider: "typesafe",
                max_steps: 2,
                max_requests: 4,
                timeout_ms: 30000,
            });
            computer.close_session();
            assert.equal(assisted.status, "verified", SafeJSON.stringify(assisted));
            const afterAssist = SafeJSON.parse((await command([native, "snapshot"])).stdout) as { pid: number };
            assert.equal(afterAssist.pid, beforeAssist.pid, "native assist must preserve the foreground app");
            checks.push("public native Jev assist verifies its action without changing the foreground app");
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
                    dropdownFill: dropdownFill?.metrics,
                    assist: assisted.metrics,
                    judgment: { status: judgment.status, probabilities: judgment.probabilities },
                },
            });
            state = await see();
            await act(state, find(state, "input").index, "set", ["--value", "seed"]);
            state = await see();
        } finally {
            const currentFront = SafeJSON.parse((await command([native, "snapshot"])).stdout) as { pid: number };
            if (currentFront.pid === fixturePid && previousFront.pid !== fixturePid) {
                const restored = await command([native, "focus", "--app", String(previousFront.pid)]);
                if (restored.exit !== 0) {
                    logger.warn({ stderr: restored.stderr }, "Could not restore foreground after semantic proof");
                }
            }
        }
    }
    if (!guardRecovery && !cursorProof && !benchmark && !taskBenchmark && !computerApi) {
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
            await act(state, find(state, "input").index, "select", [
                "--text",
                "ee",
                ...(semantic ? ["--prepare"] : []),
            ]);
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
        const paint = find(await see(), "paint") as Element & {
            x: number;
            y: number;
            width: number;
            height: number;
        };
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
    if (taskBenchmark) {
        const result = await benchmarkControlTask({
            app: String(fixturePid),
            windowId: state.window.id,
            hostPaced,
        });
        writeFileSync(join(directory, "task-benchmark.json"), SafeJSON.stringify(result, null, 2));
        out.result({ taskBenchmark: result, directory });
        assert.equal(result.ok, true, "Task benchmark stopped; retained all attempts");
        checks.push("end-to-end native task benchmark verified exact state in both orchestration modes");
    }
    if (benchmark) {
        const result = await benchmarkNativeRefresh({
            app: String(fixturePid),
            windowId: state.window.id,
            fieldId: "input",
        });
        writeFileSync(join(directory, "native-refresh-benchmark.json"), SafeJSON.stringify(result, null, 2));
        checks.push(
            "interleaved native refresh benchmark verified every field write; CPU/count/latency results retained"
        );
    }
    if (computerApi) {
        setCursorFeedbackEnabled(false);
        await command([native, "cursor-feedback", "--hide"]);
        const app = String(fixturePid);
        const originalFront = SafeJSON.parse((await command([native, "snapshot"])).stdout) as { pid: number };
        const fixtureEvaluator: Evaluator = async (call) => {
            const input = evaluationSchema.parse(call.input);
            const target = input.questions.target;
            if (target.type !== "choice") {
                throw new Error("Fixture evaluator expected one target choice.");
            }
            const choices = Object.keys(target.criteria);
            const choice = choices.find((value) => value !== "abstain") ?? "abstain";
            return {
                model: "fixture",
                answers: {
                    target: {
                        type: "choice",
                        choice,
                        probabilities: Object.fromEntries(choices.map((value) => [value, value === choice ? 1 : 0])),
                    },
                },
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                warnings: [],
                rounding: undefined,
                providerMetadata: undefined,
            };
        };
        const computer = new ComputerUse({ timeoutMs: 30000, evaluate: fixtureEvaluator });
        try {
            const windows = await computer.list_windows({ app });
            assert.equal(windows.windows.length, 2);
            assert.equal(new Set(windows.windows.map((window) => window.window_id)).size, 2);
            assert.ok(windows.windows.every((window) => window.window_id !== undefined));
            assert.ok(windows.windows.every((window, index) => window.window_index === index && window.width > 0));
            const launched = await computer.launch_app({ path: bundle, activate: false });
            assert.equal(launched.pid, fixturePid);
            checks.push("native NSWorkspace opens the exact fixture bundle without replacing its running process");
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
            observed = await computer.get_app_state({ app, window_id: observed.window.id, image: true });
            const drag = named("drag");
            assert.ok(drag.bounds && observed.screenshot);
            const x = (drag.bounds.x - observed.window.x + drag.bounds.width / 2) * observed.screenshot.scaleX;
            const y = (drag.bounds.y - observed.window.y + drag.bounds.height / 2) * observed.screenshot.scaleY;
            let result = await computer.drag({
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
            result = await computer.click({ app, element_ref: firstButton().ref });
            assert.ok(result.ok && result.state);
            observed = result.state;
            assert.equal(Number(named("counter").value), counterBefore + 1);
            result = await computer.click({ app, element_ref: firstButton().ref, prepare: true });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            observed = result.state;
            assert.equal(Number(named("counter").value), counterBefore + 2);
            result = await computer.set_value({
                app,
                element_ref: named("input").ref,
                value: "API fixture",
                prepare: true,
            });
            assert.ok(result.ok && result.state);
            observed = result.state;
            assert.equal(named("input").value, "API fixture");
            result = await computer.focus({ app, element_ref: named("input").ref });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            observed = result.state;
            result = await computer.press_key({ app, revision: observed.revision, key: "super+a" });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            observed = result.state;
            result = await computer.type_text({
                app,
                element_ref: named("input").ref,
                text: "Native 🐈",
                prepare: true,
            });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            observed = result.state;
            assert.equal(named("input").value, "Native 🐈");
            result = await computer.select_text({ app, element_ref: named("input").ref, text: "Native 🐈" });
            assert.ok(result.ok && result.state);
            observed = result.state;
            result = await computer.paste({
                app,
                element_ref: named("input").ref,
                text: "API pasted",
                format: "text",
                prepare: true,
            });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            assert.equal(result.clipboardRestore, "restored");
            observed = result.state;
            assert.equal(named("input").value, "API pasted");
            result = await computer.press_key({ app, element_ref: named("input").ref, key: "End", prepare: true });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            observed = result.state;
            result = await computer.press_key({
                app,
                element_ref: named("input").ref,
                key: "Shift+Home",
                prepare: true,
            });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            observed = result.state;
            result = await computer.perform_secondary_action({
                app,
                element_ref: firstButton().ref,
                action: "press",
            });
            assert.ok(result.ok && result.state);
            observed = result.state;
            assert.equal(Number(named("counter").value), counterBefore + 3);
            result = await computer.scroll({
                app,
                element_ref: named("scroll").ref,
                direction: "down",
                pixels: 60,
            });
            assert.ok(result.ok && result.state);
            observed = result.state;
            checks.push(
                "independent API reads/diffs, prepared clicks and form writes, keys, Unicode typing, selection, clipboard-safe paste, exposed AX actions, scrolls and drags"
            );

            const filled = await computer.fill_form({
                app,
                window_id: observed.window.id,
                data: { name: "Semantic fixture" },
                jev: true,
                provider: "typesafe",
                max_requests: 1,
                max_fields: 1,
            });
            assert.equal(filled.status, "filled", SafeJSON.stringify(filled));
            observed = await computer.get_app_state({ app, window_id: observed.window.id, image: false });
            assert.equal(named("input").value, "Semantic fixture");
            checks.push(
                "standalone semantic fill maps a named value, prepares one exact write, verifies readback and never submits"
            );

            result = await computer.click({ app, element_ref: named("save-later").ref, prepare: true });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            const saved = await computer.await_condition({
                app,
                condition: "The asynchronous save finished",
                exact: { identifier: "save-status", value: "Saved" },
                max_requests: 0,
                timeout_ms: 10000,
            });
            assert.equal(saved.status, "ready", SafeJSON.stringify(saved));
            assert.equal(saved.metrics.requests, 0);
            assert.equal(saved.metrics.actions, 0);
            assert.ok(saved.events.some((event) => event.state === "loading"));
            out.result({ exactWait: saved.metrics });
            observed = await computer.get_app_state({ app, window_id: observed.window.id, image: false });
            checks.push(
                "standalone exact wait observes an asynchronous native save through AX events with no AI or repeated click"
            );

            const fixtureWindow = observed.elements.find((element) => element.role === "AXWindow");
            assert.ok(fixtureWindow);
            result = await computer.focus({ app, element_ref: fixtureWindow.ref });
            assert.ok(result.ok && result.state, SafeJSON.stringify(result));
            observed = result.state;
            const beforeMenu = Number(named("counter").value);
            const menuBar = await computer.get_menu({ app });
            const fixtureMenu = menuBar.items.find((item) => item.title === "Fixture");
            assert.ok(fixtureMenu);
            const openedMenu = await computer.perform_menu_action({ app, menu_ref: fixtureMenu.ref });
            assert.ok(openedMenu.ok, SafeJSON.stringify(openedMenu));
            const menu = await computer.get_menu({ app, top_menu: "Fixture" });
            const incrementItem = menu.items.find((item) => item.title === "Increment counters");
            assert.ok(incrementItem?.enabled);
            const menuResult = await computer.perform_menu_action({ app, menu_ref: incrementItem.ref });
            assert.ok(menuResult.ok, SafeJSON.stringify(menuResult));
            await assert.rejects(
                computer.perform_menu_action({ app, menu_ref: incrementItem.ref }),
                /Inspect the menu/
            );
            const menuDeadline = Date.now() + 2000;
            do {
                observed = await computer.get_app_state({ app, window_id: observed.window.id, image: false });
                if (Number(named("counter").value) === beforeMenu + 10) {
                    break;
                }
                await Bun.sleep(Math.min(100, Math.max(0, menuDeadline - Date.now())));
            } while (Date.now() < menuDeadline);
            writeFileSync(
                join(directory, "menu-proof.json"),
                SafeJSON.stringify(
                    {
                        menuBar,
                        openedMenu,
                        menu,
                        menuResult,
                        before: beforeMenu,
                        after: named("counter").value,
                    },
                    null,
                    2
                )
            );
            assert.equal(Number(named("counter").value), beforeMenu + 10);
            checks.push(
                "native window inventory and scoped menu actions verify a real counter change; consumed refs refuse reuse"
            );

            const workflow = await computer.run_workflow({
                plan: {
                    version: 1,
                    app,
                    scope: "window",
                    windowTitle: observed.window.title,
                    steps: [
                        {
                            id: "focus",
                            action: "focus",
                            selector: { identifier: "input" },
                            intent: "Focus the text field",
                            postcondition: {
                                expect: "Input focused",
                                exact: { identifier: "input", attribute: "AXFocused", value: "1" },
                            },
                        },
                        {
                            id: "all",
                            action: "key",
                            selector: { identifier: "input" },
                            intent: "Select the field contents",
                            parameters: { keys: "super+a" },
                            postcondition: {
                                expect: "Text selected",
                                exact: {
                                    identifier: "input",
                                    attribute: "AXSelectedText",
                                    value: "Semantic fixture",
                                },
                            },
                        },
                        {
                            id: "type",
                            action: "type",
                            selector: { identifier: "input" },
                            intent: "Type the supplied text",
                            valueRef: "typed",
                            postcondition: {
                                expect: "Text entered",
                                exact: { identifier: "input", valueRef: "typed" },
                            },
                        },
                        {
                            id: "select",
                            action: "select",
                            selector: { identifier: "input" },
                            intent: "Select the supplied text",
                            valueRef: "typed",
                            postcondition: {
                                expect: "Text selected",
                                exact: { identifier: "input", attribute: "AXSelectedText", valueRef: "typed" },
                            },
                        },
                        {
                            id: "paste",
                            action: "paste",
                            selector: { identifier: "input" },
                            intent: "Paste the supplied text",
                            valueRef: "pasted",
                            postcondition: {
                                expect: "Paste verified",
                                exact: { identifier: "input", valueRef: "pasted" },
                            },
                        },
                    ],
                },
                values: { typed: "Workflow typed", pasted: "Workflow pasted" },
                window_id: observed.window.id,
                max_requests: 0,
            });
            assert.equal(workflow.status, "verified", SafeJSON.stringify(workflow));
            assert.equal(workflow.metrics.requests, 0);
            assert.equal(workflow.metrics.actions, 5);
            checks.push(
                "standalone five-step focus/key/type/select/paste workflow verifies each attribute with zero AI calls"
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
            await computer.get_app_state({ app, window_id: observed.window.id, image: false });
            const quit = await computer.quit_app({ app });
            assert.equal(quit.requestAccepted, true, SafeJSON.stringify(quit));
            checks.push("native normal quit targets the observed fixture process and never force-kills it");
        } finally {
            computer.close_session();
            setCursorFeedbackEnabled(true);
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
