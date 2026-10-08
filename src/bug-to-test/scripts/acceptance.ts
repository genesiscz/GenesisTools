import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startActionRecording } from "@app/chrome-devtools/lib/action-recording";
import { targets } from "@app/chrome-devtools/lib/cdp";
import { launchHeadlessChrome } from "@app/chrome-devtools/lib/headless";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { batchPsInfo, collectProcessTree, listPsTable } from "@genesiscz/utils/process/ps";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { chromium } from "@playwright/test";
import { recordBug } from "../lib/capture";
import type { BugRecording } from "../lib/types";
import {
    exportWorkspace,
    generateWorkspace,
    minimizeWorkspace,
    saveRecording,
    testHash,
    verifyWorkspace,
} from "../lib/workspace";

const destination = process.argv[2];
if (!destination) {
    throw new Error("Pass an explicit acceptance evidence folder.");
}
await mkdir(destination, { recursive: true });
const browserBinary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let fixed = false;
let hiddenFixed = false;
let hiddenAmbiguous = false;
const fixture = `<!doctype html><html><head><title>Invented cart bug</title></head><body>
<label>API key <input id="api-key" name="api_key" type="text"></label>
<h1>Fixture shop</h1><button data-testid="theme" onclick="document.body.style.background='aliceblue'">Change theme</button>
<button data-testid="add" onclick="fetch('/api/cart').then(r=>r.json()).then(x=>{document.querySelector('[data-testid=count]').textContent=x.count;console.error('Cart count displayed:', x.count)})">Add one item</button>
<p>Cart count: <span data-testid="count">0</span></p></body></html>`;
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/delete") {
            const remove = hiddenFixed ? "document.querySelector('[data-testid=row]').remove()" : "void 0";
            return new Response(
                `<button data-testid="delete" onclick="${remove}">Delete row</button><div data-testid="row">Fixture item</div>${hiddenAmbiguous ? '<div data-testid="row">Duplicate item</div>' : ""}`,
                { headers: { "content-type": "text/html" } }
            );
        }
        if (url.pathname === "/slow") {
            await Bun.sleep(10_000);
        }
        if (url.pathname === "/api/cart") {
            return Response.json({ count: fixed ? 1 : 0 });
        }
        return new Response(fixture, { headers: { "content-type": "text/html" } });
    },
});
await Bun.write(join(destination, "fixture.html"), fixture);
const chrome = await launchHeadlessChrome({ binary: browserBinary });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
try {
    const page = browser.contexts()[0].pages()[0];
    await page.goto(server.url.toString());
    const target = (await targets(chrome.port)).find((item) => item.url === page.url());
    if (!target) {
        throw new Error("Disposable fixture target missing.");
    }
    const capture = recordBug({
        port: chrome.port,
        targetId: target.id,
        output: join(destination, "live-checkpoint.json"),
        stopPath: join(destination, "stop"),
        title: "Invented cart capture",
        seconds: 30,
        signal: new AbortController().signal,
    });
    await page.waitForFunction(
        () =>
            typeof (window as Window & { __genesisRecordingCleanup?: unknown }).__genesisRecordingCleanup === "function"
    );
    const simultaneous = await startActionRecording({ port: chrome.port, targetId: target.id }).then(
        (recorder) => {
            void recorder.stop();
            return "unexpectedly admitted";
        },
        (error) => String(error)
    );
    if (!simultaneous.includes("Another recording owns")) {
        throw new Error(`A second recorder silently took over the active tab: ${simultaneous}`);
    }
    await page.getByLabel("API key").fill("fixture-secret-value");
    await page.getByLabel("API key").press("Tab");
    await page.getByTestId("theme").click();
    const response = page.waitForResponse((response) => response.url().endsWith("/api/cart"));
    await page.getByTestId("add").click();
    await response;
    await page.waitForFunction(() => document.querySelector('[data-testid="count"]')?.textContent === "0");
    const checkpointDeadline = Date.now() + 5000;
    let checkpointActions = 0;
    while (Date.now() < checkpointDeadline) {
        const checkpoint = SafeJSON.parse(await Bun.file(join(destination, "live-checkpoint.json")).text(), {
            strict: true,
        }) as { actions: unknown[] };
        checkpointActions = checkpoint.actions.length;
        if (checkpointActions === 2) {
            break;
        }
        await Bun.sleep(Math.min(200, checkpointDeadline - Date.now()));
    }
    if (checkpointActions !== 2) {
        throw new Error("Live recording actions were not checkpointed before Stop.");
    }
    await Bun.write(join(destination, "stop"), "stop");
    const snapshot = await capture;
    if (
        await page.evaluate(
            () =>
                typeof (window as Window & { __genesisRecordingCleanup?: unknown }).__genesisRecordingCleanup !==
                "undefined"
        )
    ) {
        throw new Error("Recorder left its page listeners installed after Stop.");
    }
    const restarted = await startActionRecording({ port: chrome.port, targetId: target.id });
    await page.getByTestId("theme").click();
    const restartedSnapshot = await restarted.stop();
    if (restartedSnapshot.actions.length !== 1) {
        throw new Error("A new recorder did not acquire the tab after the prior owner stopped.");
    }
    if (
        snapshot.actions.filter((action) => action.kind === "click").length !== 2 ||
        !snapshot.evidence.some((item) => item.kind === "network" && item.text.includes("/api/cart")) ||
        !snapshot.evidence.some((item) => item.kind === "console" && item.text.includes("Cart count"))
    ) {
        throw new Error("Actual browser recording did not capture actions/network/console.");
    }
    if (
        SafeJSON.stringify(snapshot, { strict: true }).includes("fixture-secret-value") ||
        !snapshot.evidence.some((item) => item.kind === "warning" && item.text.includes("Credential input omitted"))
    ) {
        throw new Error("A plainly labeled credential field was not omitted from the recording.");
    }
    const recording: BugRecording = {
        ...snapshot,
        id: "invented-cart-bug",
        title: "Adding one cart item updates count",
        triggerActionId: snapshot.actions.at(-1)?.id,
        expectation: {
            description: "After adding one item, the cart count is 1",
            kind: "text",
            locator: { kind: "testId", value: "count" },
            expected: "1",
        },
    };
    await saveRecording({ path: join(destination, "recording.json"), recording });
    const directory = await generateWorkspace({ recording });
    const red = await verifyWorkspace({ directory, browserBinary });
    if (red.status !== "intended-failure" || !red.trace) {
        throw new Error(`The real bug did not fail at the intended Playwright assertion: ${SafeJSON.stringify(red)}`);
    }
    await exportWorkspace({ directory, destination: join(destination, "red-original") });
    const missingRecording = {
        ...recording,
        actions: [{ ...recording.actions[0], locator: { kind: "testId" as const, value: "missing" } }],
    };
    const missingDirectory = await generateWorkspace({ recording: missingRecording });
    const missing = await verifyWorkspace({ directory: missingDirectory, browserBinary });
    if (missing.status !== "infrastructure-error") {
        throw new Error("Missing selector was falsely classified as the bug.");
    }
    const minimized = await minimizeWorkspace({ recording, browserBinary });
    if (minimized.recording.actions.length !== 1 || minimized.recording.actions[0].locator?.value !== "add") {
        throw new Error("Minimization did not retain the trigger and remove the unrelated theme action.");
    }
    await Bun.write(
        join(destination, "fixture-server.mjs"),
        `import { createServer } from 'node:http';
const html = ${SafeJSON.stringify(fixture, { strict: true })};
const server = createServer((request, response) => {
    if (request.url === '/api/cart') { response.setHeader('content-type','application/json'); response.end(JSON.stringify({count:process.env.FIXTURE_FIXED === '1' ? 1 : 0})); }
    else { response.setHeader('content-type','text/html'); response.end(html); }
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`
    );
    const exported = await exportWorkspace({
        directory: minimized.directory,
        destination: join(destination, "portable-bundle"),
        fixtures: [join(destination, "fixture.html"), join(destination, "fixture-server.mjs")],
    });
    const runProcess = async (command: string, args: string[], extraEnv: Record<string, string> = {}) => {
        const child = spawn(command, args, {
            cwd: exported,
            env: { ...env.getProcessEnv(), ...extraEnv },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            output += chunk.toString();
        });
        const timer = setTimeout(() => {
            if (child.pid) {
                // pid-verified: group created by this live detached child, never loaded from durable state.
                process.kill(-child.pid, "SIGKILL");
            }
        }, 60_000);
        const exit = await new Promise<number>((accept, reject) => {
            child.once("error", reject);
            child.once("close", (code) => accept(code ?? -1));
        }).finally(() => clearTimeout(timer));
        return { exit, output };
    };
    const install = await runProcess("bun", ["install", "--ignore-scripts"]);
    await Bun.write(join(destination, "portable-install.log"), install.output);
    if (install.exit !== 0) {
        throw new Error("Fresh exported bundle dependencies did not install.");
    }
    const launchExportedFixture = async (isFixed: boolean) => {
        const child = spawn("node", [join(exported, "fixtures", "2-fixture-server.mjs")], {
            env: { ...env.getProcessEnv(), FIXTURE_FIXED: isFixed ? "1" : "0" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const url = await new Promise<string>((accept, reject) => {
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error("Exported fixture did not start within 10 seconds."));
            }, 10_000);
            child.stdout.once("data", (chunk) => {
                clearTimeout(timer);
                accept(String(chunk).trim());
            });
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("exit", (code) => {
                clearTimeout(timer);
                reject(new Error(`Exported fixture exited ${code}`));
            });
        });
        return {
            child,
            url,
            close: async () => {
                child.kill("SIGTERM");
                await new Promise<void>((accept) => child.once("exit", () => accept()));
            },
        };
    };
    const exportedBug = await launchExportedFixture(false);
    const portableRed = await runProcess("bun", ["run", "test"], {
        BUG_TO_TEST_BROWSER: browserBinary,
        BUG_TO_TEST_BASE_URL: exportedBug.url,
    });
    await exportedBug.close();
    await Bun.write(join(destination, "portable-red.log"), portableRed.output);
    if (
        portableRed.exit !== 1 ||
        !(await readFile(join(exported, "report.json"), "utf8")).includes("BUG_TO_TEST_EXPECTATION")
    ) {
        throw new Error("Ordinary portable Playwright repro did not fail for its assertion.");
    }
    const before = testHash(await readFile(join(minimized.directory, "repro.spec.ts"), "utf8"));
    fixed = true;
    const green = await verifyWorkspace({ directory: minimized.directory, browserBinary });
    const after = testHash(await readFile(join(minimized.directory, "repro.spec.ts"), "utf8"));
    if (green.status !== "passed" || before !== after || green.testHash !== minimized.result.testHash) {
        throw new Error("Fixed fixture did not pass the unchanged assertion.");
    }
    const exportedFixed = await launchExportedFixture(true);
    const portableGreen = await runProcess("bun", ["run", "test"], {
        BUG_TO_TEST_BROWSER: browserBinary,
        BUG_TO_TEST_BASE_URL: exportedFixed.url,
    });
    await exportedFixed.close();
    await Bun.write(join(destination, "portable-green.log"), portableGreen.output);
    if (portableGreen.exit !== 0) {
        throw new Error("Portable test did not turn green after fixture fix.");
    }
    const remapRecording: BugRecording = {
        version: 1,
        id: "path-remap-fixture",
        title: "Fixed deployment preserves double-slash paths",
        initialUrl: "http://original.invalid//fixture-cart?item=1#row",
        actions: [],
        evidence: [],
        expectation: {
            description: "The fixed deployment preserves the exact URL path",
            kind: "url",
            expected: "http://original.invalid//fixture-cart?item=1#row",
        },
    };
    const remapDirectory = await generateWorkspace({ recording: remapRecording });
    const networkPathRemap = await verifyWorkspace({
        directory: remapDirectory,
        baseUrl: server.url.toString(),
        browserBinary,
    });
    if (networkPathRemap.status !== "passed") {
        throw new Error("Fixed deployment remapping treated a double-slash path as another hostname.");
    }
    const hiddenRecording: BugRecording = {
        version: 1,
        id: "hidden-delete-fixture",
        title: "Deleting removes the fixture row",
        initialUrl: new URL("/delete", server.url).toString(),
        actions: [
            { id: "delete", kind: "click", locator: { kind: "testId", value: "delete" }, excluded: false, at: 1 },
        ],
        evidence: [],
        expectation: {
            description: "Deleting the item hides or removes its row",
            kind: "visible",
            locator: { kind: "testId", value: "row" },
            expected: "false",
        },
    };
    const hiddenDirectory = await generateWorkspace({ recording: hiddenRecording });
    const hiddenRed = await verifyWorkspace({ directory: hiddenDirectory, browserBinary });
    hiddenFixed = true;
    const hiddenGreen = await verifyWorkspace({ directory: hiddenDirectory, browserBinary });
    hiddenFixed = false;
    hiddenAmbiguous = true;
    const hiddenDuplicate = await verifyWorkspace({ directory: hiddenDirectory, browserBinary });
    if (
        hiddenRed.status !== "intended-failure" ||
        hiddenGreen.status !== "passed" ||
        hiddenDuplicate.status !== "infrastructure-error" ||
        hiddenRed.testHash !== hiddenGreen.testHash
    ) {
        throw new Error("Hidden deletion did not turn the same assertion green or allowed ambiguous selectors.");
    }
    const cancellationDirectory = await generateWorkspace({
        recording: { ...recording, initialUrl: new URL("/slow", server.url).toString() },
    });
    const controller = new AbortController();
    let ownedPid = 0;
    let observedChildPids: number[] = [];
    let observationError: unknown;
    const cancelled = await verifyWorkspace({
        directory: cancellationDirectory,
        browserBinary,
        signal: controller.signal,
        onSpawn: (pid) => {
            ownedPid = pid;
            setTimeout(async () => {
                try {
                    observedChildPids = collectProcessTree(pid, await listPsTable()).filter((child) => child !== pid);
                } catch (error) {
                    observationError = error;
                } finally {
                    controller.abort();
                }
            }, 1000);
        },
    });
    const alive = isProcessAlive(ownedPid);
    if (observationError) {
        throw observationError;
    }
    const childDeadline = Date.now() + 3000;
    let remainingChildren = [...batchPsInfo(observedChildPids).values()]
        .filter((row) => !row.stat.startsWith("Z"))
        .map((row) => row.pid);
    while (remainingChildren.length > 0 && Date.now() < childDeadline) {
        await Bun.sleep(Math.min(200, childDeadline - Date.now()));
        remainingChildren = [...batchPsInfo(observedChildPids).values()]
            .filter((row) => !row.stat.startsWith("Z"))
            .map((row) => row.pid);
    }
    if (remainingChildren.length > 0) {
        throw new Error(`Cancellation left observed owned children alive: ${remainingChildren.join(",")}`);
    }
    if (cancelled.status !== "cancelled" || alive) {
        throw new Error(`Cancellation did not settle the pending run: status=${cancelled.status}, ownerAlive=${alive}`);
    }
    const receipt = {
        actions: snapshot.actions.length,
        checkpointActions,
        recorderCleanupObserved: true,
        credentialInputOmitted: !SafeJSON.stringify(snapshot, { strict: true }).includes("fixture-secret-value"),
        concurrentRecordingRefused: simultaneous.includes("Another recording owns"),
        recordingRestarted: restartedSnapshot.actions.length === 1,
        observedChildPids,
        remainingChildren,
        network: snapshot.evidence.filter((item) => item.kind === "network").length,
        console: snapshot.evidence.filter((item) => item.kind === "console").length,
        red,
        missing,
        minimized: {
            actions: minimized.recording.actions.length,
            removed: minimized.recording.removedActionIds,
            result: minimized.result,
        },
        portableRedExit: portableRed.exit,
        green,
        portableGreenExit: portableGreen.exit,
        networkPathRemap,
        unchangedHash: before === after,
        cancelled,
        hiddenDeletion: {
            red: hiddenRed,
            green: hiddenGreen,
            ambiguous: hiddenDuplicate,
            unchangedHash: hiddenRed.testHash === hiddenGreen.testHash,
        },
        ownedPidAlive: alive,
        exported,
    };
    await Bun.write(join(destination, "acceptance.json"), SafeJSON.stringify(receipt, { strict: true }, 2));
    await exportWorkspace({ directory: minimized.directory, destination: join(destination, "green-final") });
    out.result(receipt);
} finally {
    await browser.close();
    chrome.close();
    server.stop(true);
}
