import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import {
    harnessDriver,
    harnessDrivers,
    harnessLaunch,
    harnessLocate,
    harnessTurnState,
} from "@genesiscz/utils/ai/providers/harness-index";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { allProviderPlugins } from "@genesiscz/utils/ai/providers/registry";
import { defaultTranscriptRoots, directReads } from "@genesiscz/utils/ai/transcripts/resolve";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { HARNESS_SWIFT_PATH, renderHarnessSwift } from "../../../scripts/gen-harness-swift";
import { HARNESS_WEB_PATH, renderHarnessWeb } from "../../../scripts/gen-harness-web";
import { HARNESS_PARTS, type HarnessDriver, isPartNote } from "./types";

/**
 * The conformance suite of the harness drivers (plan `.claude/plans/2026-10-30-PlugenizeHarnesses.md`, P0). For every
 * provider plugin that is a coding agent and every part, the part either loads or the driver says why it is not
 * there. A fourth harness gets every check by adding its plugin; nothing here names one.
 *
 * Contract tests per part (locate finds a fixture by prefix, turnState reads RUNNING on a fixture, ...) join this file
 * in the phase that moves the part, and P8 turns a `pending` note into a failure.
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

describe("every part of every driver loads or says why not", () => {
    for (const plugin of codingAgents) {
        for (const part of HARNESS_PARTS) {
            test(`${plugin.id} ${part}`, async () => {
                const slot = driverOf(plugin.id).parts[part];

                if (isPartNote(slot)) {
                    expect(slot.reason.trim().length).toBeGreaterThan(0);

                    if (slot.kind === "tool-owned") {
                        expect(existsSync(join(REPO_ROOT, slot.owner))).toBe(true);
                    }

                    return;
                }

                // A lazy part is a loader; an eager part (launch, exit, host, process) is the value itself.
                const loaded = typeof slot === "function" ? await slot() : slot;
                expect(loaded).toBeTruthy();
            });
        }
    }

    test("the history part is the plugin's own coding agent reader", async () => {
        for (const plugin of codingAgents) {
            const slot = driverOf(plugin.id).parts.history;

            if (isPartNote(slot)) {
                throw new Error(`${plugin.id} declares no history part, but its plugin has a reader`);
            }

            const reader: unknown = await slot();
            const own: unknown = plugin.codingAgent;
            expect(reader).toBe(own);
            expect(plugin.codingAgent?.kind).toBe(driverOf(plugin.id).id);
        }
    });
});

describe("launch: the resume command of every harness", () => {
    for (const driver of harnessDrivers()) {
        test(`${driver.id} resumes with its own binary, and through tools when an account is pinned`, () => {
            const launch = harnessLaunch(driver.id);

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
            const reader = harnessTurnState(driver.id);
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

describe("locate: the deferred finders of every harness", () => {
    for (const driver of harnessDrivers()) {
        test(`${driver.id} loads its finders on the first call and finds nothing under empty roots`, () => {
            const locate = harnessLocate(driver.id);
            const empty = join(REPO_ROOT, ".no-such-transcript-root");
            const resolved = Object.fromEntries(
                Object.entries(defaultTranscriptRoots()).map(([key, value]) => [
                    key,
                    Array.isArray(value) ? [empty] : empty,
                ])
            );
            const roots = { injected: {}, resolved: { ...defaultTranscriptRoots(), ...resolved } };

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

    test("the dashboard's harness-meta.generated.ts is what scripts/gen-harness-web.ts writes from today's drivers", () => {
        expect(readFileSync(HARNESS_WEB_PATH, "utf8")).toBe(renderHarnessWeb());
    });
});
