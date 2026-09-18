import { callTool, toolText } from "@app/chrome-devtools/lib/mcp";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { runBrowserGoal } from "../lib/browser/goal";
import { emitBrowserClickOverlay } from "../lib/browser/overlay";
import { parseSnapshotText } from "../lib/browser/snapshot";
import type { BrowserAction, BrowserDriver } from "../lib/browser/types";

export function registerBrowser(program: Command): void {
    program
        .command("browser")
        .description("Drive a CDP browser from a goal using chrome-devtools + Jev")
        .argument("<goal>", "What to accomplish in the page")
        .option("--url <url>", "Navigate first")
        .option("--port <n>", "CDP port", "9222")
        .option("--inputs <json>", "User-supplied fill values")
        .option("--snapshot <file>", "Offline snapshot instead of MCP")
        .option("--max-steps <n>", "Action cap", "15")
        .action(
            async (
                goal: string,
                options: { url?: string; port: string; inputs?: string; snapshot?: string; maxSteps: string }
            ) => {
                const inputs = options.inputs ? SafeJSON.parse(options.inputs) : {};
                const driver = options.snapshot
                    ? await fileDriver(options.snapshot, options.url)
                    : mcpDriver(Number(options.port), options.url);
                const result = await runBrowserGoal({
                    goal,
                    driver,
                    inputs,
                    evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                    limits: { maxActions: Number(options.maxSteps), maxRequests: 20, timeoutMs: 120000 },
                });
                out.result(result);
            }
        );
}

async function fileDriver(file: string, url?: string): Promise<BrowserDriver> {
    const observation = parseSnapshotText(await Bun.file(file).text(), url ?? "fixture:browser", "Fixture");
    return {
        async observe() {
            return observation;
        },
        async dispatch() {
            return { ok: true, overlay: false, after: observation };
        },
    };
}

function mcpDriver(port: number, startUrl?: string): BrowserDriver {
    const cdp = { port };
    let opened = false;
    return {
        async observe() {
            if (startUrl && !opened) {
                await callTool("navigate_page", { url: startUrl }, cdp).catch(() =>
                    callTool("navigate_page", { type: "url", url: startUrl }, cdp)
                );
                opened = true;
            }
            const text = toolText(await callTool("take_snapshot", {}, cdp));
            return parseSnapshotText(text, startUrl ?? "", "");
        },
        async dispatch(action: BrowserAction) {
            if (action.verb === "click" && action.uid) {
                await callTool("click", { uid: action.uid }, cdp).catch(() =>
                    callTool("click", { ref: action.uid }, cdp)
                );
                return { ok: true, overlay: emitBrowserClickOverlay(0, 0) };
            }
            if (action.verb === "fill" && action.uid && action.text !== undefined) {
                await callTool("fill", { uid: action.uid, value: action.text }, cdp).catch(() =>
                    callTool("fill", { ref: action.uid, value: action.text }, cdp)
                );
                return { ok: true, overlay: false };
            }
            if (action.verb === "back") {
                await callTool("evaluate_script", { function: "() => history.back()" }, cdp);
                return { ok: true, overlay: false };
            }
            return { ok: true, overlay: false };
        },
    };
}
