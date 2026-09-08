import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runTool } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";

interface Element {
    index: number;
    depth: number;
    role: string;
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
    AXSelected?: string;
    AXValue?: string;
}
interface Observation {
    ok: boolean;
    error?: string;
    snapshot: string;
    window: { id: number; y: number };
    elements: Element[];
}
interface Result {
    ok?: boolean;
    error?: string;
    mouse?: { x: number; y: number };
}
interface Options {
    app: string;
    windowId: string;
    cursor: string;
    proof?: string;
}
const root = resolve(import.meta.dir, "../../..");

async function control(args: string[]): Promise<string> {
    const process = Bun.spawn([resolve(root, "tools"), "control", ...args], {
        cwd: root,
        env: env.getProcessEnv(),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);
    const result = SafeJSON.parse(stdout, { strict: true }) as Result;
    if (exit !== 0 || result.ok === false) {
        throw new Error(result.error ?? stderr ?? `control exited ${exit}`);
    }
    return stdout;
}

function tabs(state: Observation): Element[] {
    const candidates = state.elements.filter(
        (item) => item.role === "AXTabGroup" && item.visible && item.y <= state.window.y + 80 && item.width > 500
    );
    assert.equal(candidates.length, 1, "cannot uniquely identify the browser tab strip");
    const group = candidates[0];
    const start = state.elements.indexOf(group) + 1;
    const result: Element[] = [];
    for (const item of state.elements.slice(start)) {
        if (item.depth <= group.depth) {
            break;
        }
        if (item.depth === group.depth + 1 && item.role === "AXRadioButton") {
            result.push(item);
        }
    }
    assert.ok(result.length > 0, "tab strip exposes no tabs");
    return result;
}

async function verifyAll(options: Options): Promise<void> {
    const see = async (): Promise<Observation> => {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                return SafeJSON.parse(
                    await control(["see", "--app", options.app, "--window-id", options.windowId, "--scope", "chrome"]),
                    { strict: true }
                ) as Observation;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (!lastError.message.includes("UI changed")) {
                    throw lastError;
                }
                await Bun.sleep(100);
            }
        }
        throw lastError;
    };
    const pointer = async () => {
        const point = (SafeJSON.parse(await control(["snapshot", "--json"]), { strict: true }) as Result).mouse;
        assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), "hardware pointer unavailable");
        return point;
    };
    let state = await see();
    const initialTabs = tabs(state);
    const original = initialTabs.findIndex((tab) => tab.AXSelected === "1" || tab.AXValue === "1");
    const visited: {
        ordinal: number;
        selectedVerified: boolean;
        pointerUnchanged: boolean;
        hardwareBefore: { x: number; y: number };
        hardwareAfter: { x: number; y: number };
    }[] = [];
    const select = async (ordinal: number) => {
        for (let attempt = 0; attempt < 5; attempt++) {
            state = await see();
            const target = tabs(state)[ordinal];
            assert.ok(target?.visible, `tab ${ordinal + 1} is not currently visible`);
            const x = target.x + target.width / 2;
            const y = target.y + target.height / 2;
            const before = await pointer();
            try {
                await control([
                    "cursor",
                    "move",
                    "--name",
                    options.cursor,
                    "--app",
                    options.app,
                    "--snapshot",
                    state.snapshot,
                    "--coords",
                    `${x},${y}`,
                ]);
                state = await see();
                const refreshed = tabs(state)[ordinal];
                if (!refreshed || refreshed.x + refreshed.width / 2 !== x || refreshed.y + refreshed.height / 2 !== y) {
                    continue;
                }
                await control(["cursor", "click", "--name", options.cursor, "--snapshot", state.snapshot]);
            } catch (error) {
                if (error instanceof Error && error.message.startsWith("UI changed;")) {
                    continue;
                }
                throw error;
            }
            const after = await pointer();
            for (let poll = 0; poll < 10; poll++) {
                state = await see();
                const selected = tabs(state).findIndex((tab) => tab.AXSelected === "1" || tab.AXValue === "1");
                if (selected === ordinal) {
                    return {
                        ordinal: ordinal + 1,
                        selectedVerified: true,
                        pointerUnchanged: before.x === after.x && before.y === after.y,
                        hardwareBefore: before,
                        hardwareAfter: after,
                    };
                }
                await Bun.sleep(100);
            }
            throw new Error(`tab ${ordinal + 1} did not become selected; action will not be blindly repeated`);
        }
        throw new Error(`tab ${ordinal + 1} kept changing before dispatch`);
    };
    for (let ordinal = 0; ordinal < initialTabs.length; ordinal++) {
        visited.push(await select(ordinal));
        logger.info({ tab: ordinal + 1, total: initialTabs.length }, "verified Brave tab with software cursor");
    }
    assert.equal(
        tabs(state).length,
        initialTabs.length,
        "tab inventory changed during verification; rerun against current tabs"
    );
    const restoration = original >= 0 ? await select(original) : null;
    assert.ok(
        visited.every((visit) => visit.pointerUnchanged),
        "hardware pointer changed during measurement; no pointer-preservation proof can be issued"
    );
    assert.ok(
        restoration === null || restoration.pointerUnchanged,
        "hardware pointer changed during original-tab restoration"
    );
    const proof = {
        ok: true,
        finishedAt: new Date().toISOString(),
        app: options.app,
        windowId: Number(options.windowId),
        cursor: options.cursor,
        tabCount: initialTabs.length,
        visited,
        restoredOriginalTab: restoration !== null,
        restoration,
        evidence:
            "Every tab was clicked through tools control cursor and selected state was re-inspected; no page controls were clicked.",
    };
    if (options.proof) {
        await Bun.write(options.proof, SafeJSON.stringify(proof, { strict: true }, 2));
    }
    out.result(proof);
}

const program = new Command()
    .name("control-brave-tabs")
    .description(
        "Click every visible tab in an existing Brave window using the independent software cursor, verify selection, and restore the initial tab. Does not submit page forms or click page controls."
    )
    .option("--app <bundle>", "browser app", "com.brave.Browser")
    .requiredOption("--window-id <id>", "exact CG window ID from tools control see")
    .option("--cursor <name>", "independent cursor name", "brave-verification")
    .option("--proof <path>", "write counts and verification results without page titles or URLs")
    .action(verifyAll);
await runTool(program, { tool: "control" });
