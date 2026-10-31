import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import { harnessDriver, harnessDrivers } from "@genesiscz/utils/ai/providers/harness-index";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { allProviderPlugins } from "@genesiscz/utils/ai/providers/registry";
import { directReads } from "@genesiscz/utils/ai/transcripts/resolve";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { HARNESS_PLUGIN_PATH, renderHarnessPlugin } from "../../../scripts/gen-harness-plugin";
import { HARNESS_SWIFT_PATH, renderHarnessSwift } from "../../../scripts/gen-harness-swift";
import { HARNESS_WEB_PATH, renderHarnessWeb } from "../../../scripts/gen-harness-web";
import { toolPartsComplete, toolPartsRegistered } from "./tool-parts";
import { HARNESS_PART_LOADING, HARNESS_PARTS, type HarnessDriver } from "./types";

/**
 * The conformance suite of the harness drivers (plan `.claude/plans/2026-10-30-PlugenizeHarnesses.md`, P0). For every
 * provider plugin that is a coding agent, every part loads, and the contract tests below run each part's code on a
 * fixture (locate finds nothing under empty roots, turnState reads an empty tail, the history part is the plugin's
 * reader). A fourth harness gets every check by adding its plugin; nothing here names one.
 */
registerBuiltInPlugins();

const REPO_ROOT = join(moduleDir(import.meta), "..", "..", "..");

const codingAgents = allProviderPlugins().filter((plugin) => plugin.codingAgent !== undefined);

function driverOf(pluginId: string): HarnessDriver {
    const driver = allProviderPlugins().find((plugin) => plugin.id === pluginId)?.harness;

    if (!driver) {
        throw new Error(`${pluginId} has a codingAgent but no harness driver`);
    }

    return driver;
}

describe("harness drivers hang off the provider plugins", () => {
    test("a plugin has a harness driver exactly when it has a coding agent", () => {
        const withDriver = allProviderPlugins()
            .filter((plugin) => plugin.harness !== undefined)
            .map((plugin) => plugin.id);

        expect(withDriver.sort()).toEqual(codingAgents.map((plugin) => plugin.id).sort());
    });

    test("each driver's id is its plugin's alias, and every alias has one driver", () => {
        const ids = codingAgents.map((plugin) => {
            const id: string = driverOf(plugin.id).id;
            expect(id).toBe(providerAliasOf(plugin.id));
            return id;
        });

        expect(ids.sort()).toEqual([...ACCOUNT_PROVIDER_ALIASES].sort());
    });

    test("identity is filled in", () => {
        for (const plugin of codingAgents) {
            const { identity } = driverOf(plugin.id);

            expect(identity.label.length).toBeGreaterThan(0);
            expect(identity.binary.length).toBeGreaterThan(0);
            expect(identity.aliases).not.toContain(driverOf(plugin.id).id);
            expect(identity.plugin).toBe(plugin.id);
            expect(identity.mark.letter).toHaveLength(1);

            for (const channel of Object.values(identity.mark.color)) {
                expect(channel).toBeGreaterThanOrEqual(0);
                expect(channel).toBeLessThanOrEqual(1);
            }
        }
    });

    test("the light index holds the very driver each plugin carries, and nothing else", () => {
        for (const plugin of codingAgents) {
            const driver = driverOf(plugin.id);
            const indexed: unknown = harnessDriver(driver.id);

            expect(indexed).toBe(driver);
        }

        expect(harnessDrivers().map((driver) => driver.id)).toEqual([...ACCOUNT_PROVIDER_ALIASES]);
    });
});

describe("every part of every driver loads", () => {
    for (const plugin of codingAgents) {
        for (const part of HARNESS_PARTS) {
            test(`${plugin.id} ${part}`, async () => {
                const slot: unknown = driverOf(plugin.id).parts[part];

                // A lazy part is a loader, so reading the driver loads no parser; an eager part is the value itself.
                expect(typeof slot === "function").toBe(HARNESS_PART_LOADING[part] === "lazy");
                const loaded: unknown = typeof slot === "function" ? await slot() : slot;
                expect(loaded).toBeTruthy();
            });
        }
    }

    test("each plugin's coding agent reader is of the kind its harness driver names", () => {
        for (const plugin of codingAgents) {
            expect(plugin.codingAgent?.kind).toBe(driverOf(plugin.id).id);
        }
    });
});

describe("dialog: the keys of every harness's question dialog, or why it has none", () => {
    for (const driver of harnessDrivers()) {
        test(`${driver.id} picks option 2 within its option count, or names the reason it cannot`, () => {
            const dialog = driver.parts.dialog;

            if (!dialog.supported) {
                expect(dialog.reason.trim().length).toBeGreaterThan(0);
                return;
            }

            expect(dialog.maxOptions).toBeGreaterThanOrEqual(2);
            expect(dialog.select(1).length).toBeGreaterThan(0);
        });
    }
});

describe("launch: the resume command of every harness", () => {
    for (const driver of harnessDrivers()) {
        test(`${driver.id} resumes with its own binary, and through tools when an account is pinned`, () => {
            const launch = harnessDriver(driver.id).parts.launch;

            expect(launch.resumeArgv("s-1", {})[0]).toBe(driver.identity.binary);
            expect(launch.resumeArgv("s-1", {})).toContain("s-1");
            expect(launch.resumeArgv("s-1", { account: "work" }).slice(0, 2)).toEqual(["tools", driver.id]);
            expect(Object.keys(launch.resumeFlags).length).toBeGreaterThan(0);
        });
    }
});

describe("turnState: an empty tail of every harness", () => {
    for (const driver of harnessDrivers()) {
        test(`${driver.id} reads a tail with no whole record from the modification time alone`, () => {
            const reader = harnessDriver(driver.id).parts.turnState;
            const base = { records: [], now: 600_000, stallTimeoutMs: 60_000 };
            const stale = reader.read({ ...base, lastModified: 0 });
            const fresh = reader.read({ ...base, lastModified: 599_000 });

            expect(stale.state).toBe("STALLED");
            expect(fresh.state).toBe("RUNNING");
            expect(stale.openTools).toEqual([]);
            expect(stale.lastText).toBe("");
            expect(stale.asksQuestion).toBe(false);
        });
    }
});

describe("hooks: the light door holds the drivers' own hook facts", () => {
    for (const driver of harnessDrivers()) {
        test(`${driver.id}'s harness-hooks entry is the object its driver carries`, () => {
            const own: unknown = driver.parts.hooks;
            expect(own).toBe(harnessHooks(driver.id));
        });

        test(`${driver.id}'s hook facts read the model with its reader's own currentModel`, () => {
            const reader = allProviderPlugins().find((plugin) => plugin.harness === driver)?.codingAgent;
            const own: unknown = reader?.currentModel;
            expect(own).toBe(driver.parts.hooks.currentModel);
        });
    }
});

describe("locate: the deferred finders of every harness", () => {
    for (const driver of harnessDrivers()) {
        test(`${driver.id} loads its finders on the first call and finds nothing under empty roots`, () => {
            const locate = harnessDriver(driver.id).parts.locate;
            const empty = join(REPO_ROOT, ".no-such-transcript-root");
            const roots = { native: [empty], worker: empty };
            expect(locate.defaultRoots().native.length).toBeGreaterThan(0);

            expect(locate.find("0123456789abcdef", roots, directReads)).toEqual([]);
            expect(locate.pathRoots(roots).length).toBeGreaterThan(0);
            expect(
                locate.sessionOfPath({ source: "worker", stem: "probe", filePath: join(empty, "probe.jsonl") })
            ).toMatchObject({ provider: driver.id, source: "worker" });
        });
    }
});

describe("the Swift mirror of the drivers", () => {
    test("Harness.swift is what scripts/gen-harness-swift.ts writes from today's drivers", () => {
        expect(readFileSync(HARNESS_SWIFT_PATH, "utf8")).toBe(renderHarnessSwift());
    });

    test("the plugin's Generated/harness-facts.ts is what scripts/gen-harness-plugin.ts writes from today's drivers", () => {
        expect(readFileSync(HARNESS_PLUGIN_PATH, "utf8")).toBe(renderHarnessPlugin());
    });

    test("the dashboard's harness-meta.generated.ts is what scripts/gen-harness-web.ts writes from today's drivers", () => {
        expect(readFileSync(HARNESS_WEB_PATH, "utf8")).toBe(renderHarnessWeb());
    });
});

describe("tool parts: every harness has its module in each toolParts folder", () => {
    // Found by search, so a new registry is checked without a list here (`src/utils/harness/tool-parts.ts`).
    const grep = Bun.spawnSync(["git", "grep", "-l", "-e", "toolParts<", "--", "src/*.ts"], {
        cwd: REPO_ROOT,
        env: process.env,
    });
    const callers = grep.stdout
        .toString()
        .split("\n")
        .filter((file) => file && !file.endsWith(".test.ts") && !file.endsWith("harness/tool-parts.ts"));

    test("the search finds the registries", () => {
        expect(grep.exitCode).toBe(0);
        expect(callers.length).toBeGreaterThanOrEqual(10);
    });

    for (const file of callers) {
        test(`${file}: each registry loads every harness's part through its own guard`, async () => {
            const path = join(REPO_ROOT, file);
            await import(path);
            const registries = toolPartsRegistered().filter((registration) => registration.file === path);

            expect(registries.length).toBeGreaterThan(0);

            for (const { folder, exportName, parts } of registries) {
                // `toolPartsComplete` throws for a missing module or an export its `isPart` refuses.
                expect({ folder, exportName, parts: toolPartsComplete(parts).length }).toEqual({
                    folder,
                    exportName,
                    parts: ACCOUNT_PROVIDER_ALIASES.length,
                });
            }
        });
    }
});
