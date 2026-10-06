import { mkdir, mkdtemp, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchHeadlessChrome } from "@app/chrome-devtools/lib/headless";
import { env } from "@genesiscz/utils/env";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { connectSession, Refusal } from "../lib/browser";
import { startReportFixture } from "../lib/fixture";
import { parseRecipe } from "../lib/recipe";
import { ShowOnceService } from "../lib/service";

const scratch = join(tmpdir(), "cc", "GenesisTools", "show-once", "evidence");
await mkdir(scratch, { recursive: true });
const root = await realpath(await mkdtemp(join(scratch, "acceptance-")));
const downloadDirectory = join(root, "demonstrated-downloads");
const destinationDirectory = join(root, "demonstrated-destination");
await mkdir(downloadDirectory);
await mkdir(destinationDirectory);
const fixture = startReportFixture();
const chrome = await launchHeadlessChrome();
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
const context = browser.contexts()[0];
const page = await context.newPage();
let downloadCaptured: () => void = () => {};
let captureTimer: ReturnType<typeof setTimeout>;
const captureReady = new Promise<void>((resolveCaptured, reject) => {
    captureTimer = setTimeout(() => reject(new Error("Recording download content was not captured")), 20000);
    downloadCaptured = () => {
        clearTimeout(captureTimer);
        resolveCaptured();
    };
});
const service = new ShowOnceService((event) => {
    if (z.object({ type: z.literal("download") }).safeParse(event).success) {
        downloadCaptured();
    }
});
const receipts: unknown[] = [];
const client = new Client({ name: "show-once-acceptance", version: "1.0.0" });
try {
    await page.goto(fixture.url);
    const tabs = z
        .array(z.object({ id: z.string(), url: z.string() }))
        .parse(await service.dispatch({ op: "tabs", port: chrome.port }));
    const targetId = tabs.find((tab) => tab.url === fixture.url)?.id;
    if (!targetId) {
        throw new Error("Fixture tab missing");
    }
    await service.dispatch({
        op: "record-start",
        port: chrome.port,
        targetId,
        downloadDirectory,
        destinationDirectory,
    });
    const rejectedDownloads = join(root, "rejected-recording-downloads");
    await mkdir(rejectedDownloads);
    const competing = new ShowOnceService();
    try {
        try {
            await competing.dispatch({
                op: "record-start",
                port: chrome.port,
                targetId,
                downloadDirectory: rejectedDownloads,
                destinationDirectory,
            });
            throw new Error("Concurrent recorder was accepted");
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("Another recording owns")) {
                throw error;
            }
        }
        const refusal = z
            .object({ status: z.literal("failed"), events: z.array(z.object({ status: z.string() })) })
            .parse(
                await competing.dispatch({
                    op: "run",
                    recipe: {
                        version: 1,
                        id: "rejected-replay",
                        title: "Rejected competing replay",
                        createdAt: new Date().toISOString(),
                        allowedOrigins: [new URL(fixture.url).origin],
                        parameters: [],
                        steps: [
                            {
                                id: "refuse",
                                title: "Must not change customer",
                                kind: "fill",
                                enabled: true,
                                locator: { kind: "testId", value: "customer" },
                                pageUrl: fixture.url,
                                value: "not-applied",
                                evidence: {
                                    eventId: "explicit-test",
                                    url: fixture.url,
                                    at: Date.now(),
                                    detail: "Rejected replay control",
                                },
                            },
                        ],
                    },
                    inputs: {},
                    port: chrome.port,
                    targetId,
                })
            );
        if (
            refusal.events.some((event) => event.status === "dispatched") ||
            (await page.getByTestId("customer").inputValue()) !== "shop"
        ) {
            throw new Error("Competing replay reached the input");
        }
    } finally {
        await competing.close();
    }
    console.log("Verified competing recording/replay refusal before routing or input");
    await page.getByTestId("customer").fill("personal");
    await page.getByTestId("month").fill("2026-09");
    await page.getByTestId("report").focus();
    await page.keyboard.press("o");
    await page.keyboard.press("Tab");
    await page.getByTestId("download").click();
    await captureReady;
    const selectedReport = await page.getByTestId("report").inputValue();
    const demonstratedFilename = `personal-2026-09-${selectedReport}.csv`;
    const source = join(downloadDirectory, demonstratedFilename);
    if (!(await waitForPath(source, { timeoutMs: 10000 }))) {
        throw new Error("Demonstrated download missing");
    }
    // A real filesystem rename models the Finder move here. The later native desktop gate separately exercises Finder.
    await rename(source, join(destinationDirectory, "demonstrated-renamed.csv"));
    const stopped = z
        .object({ recipe: z.unknown() })
        .parse(await service.dispatch({ op: "record-stop", title: "Customer monthly report" }));
    const recorded = parseRecipe(stopped.recipe);
    await Bun.write(join(root, "recorded.json"), SafeJSON.stringify(recorded, null, 2));
    console.log(
        "Recorded steps",
        recorded.steps.map((step) => `${step.kind}:${step.title}`)
    );
    const recipe = parseRecipe({
        ...recorded,
        parameters: [
            { name: "customer", label: "Customer", secret: false },
            { name: "month", label: "Month", secret: false },
            { name: "report", label: "Report", secret: false },
            { name: "destination", label: "Destination", secret: false },
        ],
        steps: recorded.steps.map((step) => {
            if (
                (step.kind === "fill" || step.kind === "select") &&
                step.locator.kind === "testId" &&
                ["customer", "month", "report"].includes(step.locator.value)
            ) {
                return { ...step, value: `{{${step.locator.value}}}` };
            }
            if (step.kind === "download") {
                return {
                    ...step,
                    filename: "{{customer}}-{{month}}-{{report}}.csv",
                    contains: ["{{customer}},{{month}},{{report}},42"],
                };
            }
            if (step.kind === "move") {
                return {
                    ...step,
                    destination: "{{destination}}",
                    filename: "{{customer}}-{{month}}-{{report}}.csv",
                    contains: ["{{customer}},{{month}},{{report}},42"],
                };
            }
            return step;
        }),
    });
    if (!recipe.steps.some((step) => step.kind === "select" && step.locator.value === "report")) {
        throw new Error("Trusted report selection was not recorded");
    }
    if (!recipe.steps.some((step) => step.kind === "move")) {
        throw new Error("Demonstrated file move was not observed");
    }
    const recipeFile = join(root, "report.showonce.json");
    await service.dispatch({ op: "save", recipe, file: recipeFile });
    const reopened = parseRecipe(await service.dispatch({ op: "open", file: recipeFile }));
    for (const [index, inputs] of [
        { customer: "shop", month: "2026-10", report: "sales", destination: join(root, "cli-output") },
        { customer: "work", month: "2026-11", report: "orders", destination: join(root, "mcp-output") },
    ].entries()) {
        await mkdir(inputs.destination);
        if (index === 0) {
            const inputFile = join(root, "cli-inputs.json");
            await Bun.write(inputFile, SafeJSON.stringify(inputs));
            const child = Bun.spawn(
                [
                    process.execPath,
                    "run",
                    resolve(import.meta.dirname, "../index.ts"),
                    "run",
                    recipeFile,
                    "--port",
                    String(chrome.port),
                    "--target",
                    targetId,
                    "--inputs",
                    inputFile,
                ],
                {
                    cwd: resolve(import.meta.dirname, "../../.."),
                    stdout: "pipe",
                    stderr: "pipe",
                    signal: AbortSignal.timeout(40000),
                }
            );
            const [code, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            await Bun.write(join(root, "cli.log"), `${stderr}\n${stdout}`);
            if (code !== 0) {
                throw new Error(`CLI replay failed: ${stderr} ${stdout}`);
            }
            receipts.push(SafeJSON.parse(stdout, { strict: true }));
        } else {
            const transport = new StdioClientTransport({
                command: process.execPath,
                args: ["run", resolve(import.meta.dirname, "../index.ts"), "mcp"],
                env: Object.fromEntries(
                    Object.entries(env.getProcessEnv()).filter(
                        (entry): entry is [string, string] => typeof entry[1] === "string"
                    )
                ),
            });
            await client.connect(transport);
            const response = await client.callTool({
                name: "show_once",
                arguments: { op: "run", recipe: reopened, inputs, port: chrome.port, targetId },
            });
            await Bun.write(join(root, "mcp-result.json"), SafeJSON.stringify(response, null, 2));
            if (response.isError) {
                throw new Error(`MCP replay failed: ${SafeJSON.stringify(response)}`);
            }
            receipts.push(response);
        }
        const output = join(inputs.destination, `${inputs.customer}-${inputs.month}-${inputs.report}.csv`);
        const text = await Bun.file(output).text();
        if (!text.includes(`${inputs.customer},${inputs.month},${inputs.report},42`)) {
            throw new Error("Actual output content differs");
        }
        console.log("Verified output", output, text.trim());
    }
    const session = await connectSession({ port: chrome.port, targetId, directory: downloadDirectory });
    let dispatched = 0;
    const dispatchCount = () => dispatched;
    const refusals: string[] = [];
    try {
        const action = {
            kind: "fill" as const,
            value: "safe",
            expectedUrl: fixture.url,
            onDispatch: () => {
                dispatched++;
            },
        };
        const refuse = async (label: string, operation: () => Promise<unknown>) => {
            try {
                await operation();
                throw new Error(`Expected refusal: ${label}`);
            } catch (error) {
                if (!(error instanceof Refusal)) {
                    throw error;
                }
                refusals.push(label);
            }
        };
        await refuse("missing target", () =>
            session.action({ ...action, locator: { kind: "testId", value: "missing" } })
        );
        await page.evaluate(() => {
            const original = document.querySelector('[data-testid="customer"]');
            if (original) {
                document.body.append(original.cloneNode());
            }
        });
        await refuse("ambiguous target", () =>
            session.action({ ...action, locator: { kind: "testId", value: "customer" } })
        );
        await page.evaluate(() => document.querySelectorAll('[data-testid="customer"]')[1]?.remove());
        await page.evaluate(() => {
            const overlay = document.createElement("div");
            overlay.id = "blocking-overlay";
            overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:black";
            document.body.append(overlay);
        });
        await refuse("covered target", () =>
            session.action({ ...action, locator: { kind: "testId", value: "customer" } })
        );
        await page.evaluate(() => document.getElementById("blocking-overlay")?.remove());
        await refuse("stale page", () =>
            session.action({
                ...action,
                expectedUrl: `${fixture.url}?stale`,
                locator: { kind: "testId", value: "customer" },
            })
        );
        await page.evaluate(() => {
            const el = document.createElement("input");
            el.id = "repairable";
            el.setAttribute("aria-label", "Renamed");
            document.body.append(el);
        });
        await page.locator("#repairable").scrollIntoViewIfNeeded();
        await refuse("changed identity", () =>
            session.action({
                ...action,
                locator: {
                    kind: "css",
                    value: "#repairable",
                    fingerprint: { tag: "INPUT", role: "textbox", name: "Original" },
                },
            })
        );
        if (dispatchCount() !== 0) {
            throw new Error("A refused action reached dispatch");
        }
        await session.action({
            ...action,
            locator: {
                kind: "css",
                value: "#repairable",
                fingerprint: { tag: "INPUT", role: "textbox", name: "Renamed" },
            },
        });
        if (dispatchCount() !== 1 || (await page.locator("#repairable").inputValue()) !== "safe") {
            throw new Error("Explicit target repair did not work");
        }
        const controller = new AbortController();
        const started = performance.now();
        const wait = session.waitDownload({
            after: 0,
            filename: "never.csv",
            timeoutMs: 20000,
            signal: controller.signal,
        });
        controller.abort();
        try {
            await wait;
            throw new Error("Cancelled download wait unexpectedly completed");
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("cancelled")) {
                throw error;
            }
        }
        if (performance.now() - started > 1000) {
            throw new Error("Download cancellation exceeded one second");
        }
    } finally {
        await session.close();
    }
    let checkpointReady: () => void = () => {};
    const ready = new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error("Checkpoint not reached")), 10000);
        checkpointReady = () => {
            clearTimeout(timer);
            resolveReady();
        };
    });
    const cancellationService = new ShowOnceService((raw) => {
        const event = z.object({ type: z.string(), event: z.object({ status: z.string() }).optional() }).safeParse(raw);
        if (event.success && event.data.event?.status === "checkpoint") {
            checkpointReady();
        }
    });
    try {
        const step = {
            id: "check",
            title: "Inspect actual output",
            kind: "checkpoint",
            enabled: true,
            message: "Confirm output",
            evidence: recorded.steps[0].evidence,
        };
        const run = cancellationService.dispatch({
            op: "run",
            recipe: { ...recorded, steps: [step] },
            inputs: {},
            port: chrome.port,
            targetId,
        });
        await ready;
        try {
            await cancellationService.dispatch({ op: "resume", runId: "stale", stepId: "check" });
            throw new Error("Stale checkpoint was accepted");
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("stale")) {
                throw error;
            }
        }
        const started = performance.now();
        await cancellationService.dispatch({ op: "cancel" });
        const result = z.object({ status: z.literal("cancelled") }).parse(await run);
        if (performance.now() - started > 3000) {
            throw new Error("Run cancellation exceeded three seconds");
        }
        receipts.push({ cancellation: result, refusals, explicitRepair: "value readback matched", dispatched });
    } finally {
        await cancellationService.close();
    }
    console.log("Verified refusals and explicit repair", refusals, "dispatch count", dispatched);

    await Bun.write(
        join(root, "receipt.json"),
        SafeJSON.stringify({ root, recordedSteps: recorded.steps.length, receipts }, null, 2)
    );
    const bridgeChild = Bun.spawn([process.execPath, "run", resolve(import.meta.dirname, "../index.ts"), "bridge"], {
        cwd: resolve(import.meta.dirname, "../../.."),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    const bridgeErrors = new Response(bridgeChild.stderr).text();
    const reader = bridgeChild.stdout.getReader();
    try {
        bridgeChild.stdin.write(
            `${SafeJSON.stringify({ id: "record", command: { op: "record-start", port: chrome.port, targetId, downloadDirectory, destinationDirectory } }, { strict: true })}\n`
        );
        let buffer = "";
        let started = false;
        const readUntilStarted = async () => {
            while (!started) {
                const chunk = await reader.read();
                if (chunk.done) {
                    throw new Error("Bridge exited before recording acknowledgement");
                }
                buffer += new TextDecoder().decode(chunk.value);
                let newline = buffer.indexOf("\n");
                while (newline >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    const envelope = z
                        .object({
                            id: z.string().optional(),
                            error: z.string().optional(),
                            result: z.unknown().optional(),
                        })
                        .parse(SafeJSON.parse(line, { strict: true }));
                    if (envelope.id === "record") {
                        if (envelope.error) {
                            throw new Error(envelope.error);
                        }
                        started = true;
                    }
                    newline = buffer.indexOf("\n");
                }
            }
        };
        let ackTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                readUntilStarted(),
                new Promise<never>((_resolve, reject) => {
                    ackTimer = setTimeout(() => reject(new Error("Bridge acknowledgement deadline")), 10000);
                }),
            ]);
        } finally {
            clearTimeout(ackTimer);
        }
        if ((await page.evaluate(() => typeof Reflect.get(window, "__genesisRecordingCleanup"))) !== "function") {
            throw new Error("Bridge recorder listener missing");
        }
        const stoppedAt = performance.now();
        const ownedPid = bridgeChild.pid;
        bridgeChild.stdin.end();
        bridgeChild.kill("SIGTERM");
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        let code: number;
        try {
            code = await Promise.race([
                bridgeChild.exited,
                new Promise<never>((_resolve, reject) => {
                    stopTimer = setTimeout(() => reject(new Error("Owned bridge child did not stop")), 5000);
                }),
            ]);
        } finally {
            clearTimeout(stopTimer);
        }
        if (
            code !== 0 ||
            (await page.evaluate(() => typeof Reflect.get(window, "__genesisRecordingCleanup"))) !== "undefined"
        ) {
            throw new Error("Bridge shutdown did not clean its recorder");
        }
        const cleanup = { ownedPid, exit: code, elapsedMs: performance.now() - stoppedAt, listenersRemoved: true };
        receipts.push({ bridgeCleanup: cleanup });
        console.log("Verified owned bridge shutdown", cleanup);
    } finally {
        reader.releaseLock();
        if (bridgeChild.exitCode === null) {
            bridgeChild.kill("SIGKILL");
            await bridgeChild.exited;
        }
        await Bun.write(join(root, "bridge.stderr.log"), await bridgeErrors);
    }

    const history = z
        .array(
            z.object({ recipeId: z.string(), recipeSha256: z.string(), receiptFile: z.string(), status: z.string() })
        )
        .parse(await new ShowOnceService().dispatch({ op: "history", recipeId: recipe.id }));
    if (history.length < 2 || history.some((entry) => entry.recipeId !== recipe.id)) {
        throw new Error("Run outcomes did not survive service reopen");
    }
    for (const entry of history) {
        if (!(await Bun.file(entry.receiptFile).exists())) {
            throw new Error("Run receipt file missing");
        }
    }
    console.log("Verified retained run receipts after service reopen", history.length);
    console.log("SHOW_ONCE_ACCEPTANCE_PASS", root);
} finally {
    await client.close();
    clearTimeout(captureTimer!);
    await service.close();
    await browser.close();
    chrome.close();
    fixture.close();
}
