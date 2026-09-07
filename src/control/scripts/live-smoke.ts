import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { ensureBinary } from "../lib/runner";

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
    window: { id: number };
    windows?: { index: number }[];
    screenshot: { path: string };
}

const root = resolve(import.meta.dir, "../../..");
const backgroundOnly = Bun.argv.includes("--background-only");
const verifyPointer = Bun.argv.includes("--verify-pointer");

if (Bun.argv.includes("--help")) {
    out.print(
        "Usage: bun src/control/scripts/live-smoke.ts [--background-only] [--verify-pointer]\n--background-only avoids focus/keyboard tests and opens the fixture in the background.\n--verify-pointer asserts the physical pointer stays unchanged; keep mouse and keyboard idle during measurement.\nBuilds and opens a temporary two-window test app. Exercises see/act, then terminates only that app. Requires Accessibility and Screen Recording. Uses no Codex, Sky or Peekaboo.\n"
    );
    process.exit(0);
}

const native = ensureBinary();

async function command(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(argv, { cwd: root, env: env.getProcessEnv(), stdout: "pipe", stderr: "pipe" });
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

const directory = mkdtempSync(join(tmpdir(), "control-live-"));
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
    const data = SafeJSON.parse(result.stdout) as State;
    assert.equal(result.exit, succeeds ? 0 : 1, result.stdout || result.stderr);
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
    const disabled = state.elements.find((element) => element.AXTitle === "Disabled");
    assert.ok(disabled);
    await act(state, disabled.index, "press", [], false);
    assert.equal(find(await see(), "counter").AXValue, "10");
    checks.push("invalid index and disabled button do not mutate the counter");

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
    const pointerBefore = SafeJSON.parse(pointerBeforeResult.stdout) as {
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
    const pointerAfter = SafeJSON.parse(pointerAfterResult.stdout) as { mouse: { x: number; y: number }; pid: number };
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
        const scroll = find(state, "scroll");
        const before = state.elements.find((element) => element.role === "AXScrollBar")?.AXValue;
        await act(state, scroll.index, "scroll", ["--background", "--direction", "down", "--pages", "1"]);
        state = await see();
        assert.notEqual(state.elements.find((element) => element.role === "AXScrollBar")?.AXValue, before);
        checks.push("background page-sized wheel scrolling changes the test viewport");
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
        const scroll = state.elements.find((element) => element.role === "AXScrollArea");
        assert.ok(scroll);
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
            "--element",
            String(scroll.index),
            "--action",
            "scroll",
            "--direction",
            "down",
        ]);
        const page = SafeJSON.parse(pageResult.stdout) as State;
        assert.equal(pageResult.exit, page.ok ? 0 : 1);
        state = await see();
        const afterPage = state.elements.find((element) => element.role === "AXScrollBar")?.AXValue;
        assert.equal(page.ok, true, page.error);
        assert.notEqual(afterPage, beforeScroll);
        checks.push("page-sized wheel scroll changes the observed scrollbar");
        await act(state, find(state, "scroll").index, "scroll", ["--direction", "down", "--pixels", "80"]);
        state = await see();
        assert.notEqual(state.elements.find((element) => element.role === "AXScrollBar")?.AXValue, afterPage);
        assert.equal(find(state, "counter").AXValue, "15");
        checks.push("offscreen click refuses; explicitly requested pixel scroll changes the viewport");

        const expiredData = SafeJSON.parse(Buffer.from(state.snapshot, "base64").toString("utf8")) as {
            created: number;
        };
        expiredData.created = 1;
        const expiredState = { ...state, snapshot: Buffer.from(SafeJSON.stringify(expiredData)).toString("base64") };
        const expired = await act(expiredState, 0, "focus", [], false);
        assert.match(expired.error ?? "", /expired/);
        checks.push("expired snapshot refuses before focus");

        const lastShot = state.screenshot.path;
        const close = state.elements.find((element) => element.AXSubrole === "AXCloseButton");
        assert.ok(close);
        await act(state, close.index, "press");
        const closed = await act(state, 0, "get", [], false);
        assert.match(closed.error ?? "", /closed|offscreen|missing/);
        const missing = await run(["see", "--app", String(fixturePid), "--window-id", String(state.window.id)], false);
        assert.match(missing.error ?? "", /closed|offscreen|missing/);
        checks.push("closed window token and stable-ID refresh refuse without selecting the remaining window");
        state.screenshot.path = lastShot;
    }
    out.result({ ok: true, checks, screenshot: state.screenshot.path, directory });
} finally {
    if (fixturePid > 0) {
        process.kill(fixturePid, "SIGTERM");
    }

    launcher.kill();
    await launcher.exited;
    const errors = await launcherErrors;

    if (errors.trim()) {
        logger.debug({ errors }, "control fixture stderr");
    }
}
