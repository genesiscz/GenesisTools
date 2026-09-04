import { afterEach, describe, expect, test } from "bun:test";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest } from "@genesiscz/utils/ai/providers/registry";
import { usagePlugins } from "./poll";

/**
 * The registry is per-process and starts EMPTY. Every other consumer in the repo calls
 * `registerBuiltInPlugins()` at its own entry point, which is exactly why the poll core
 * failed silently: the launchd `ai-usage-poll` daemon imports nothing else, so it read an
 * empty registry, polled nobody, and reported success. `tools ai usage` masked it, because
 * registering the `config` commands registers the plugins as a side effect.
 *
 * Both resets are needed to reach that state, and they must stay paired: the registry map
 * lives in `registry.ts` while the "already registered" latch lives in `plugins.ts`, so
 * clearing only the map leaves `registerBuiltInPlugins()` believing its work is done.
 * A test with fake plugins cannot see this bug at all.
 */

function freshProcess(): void {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
}

afterEach(() => {
    freshProcess();
    // Leave the registry populated for whatever runs next in this process.
    usagePlugins();
});

describe("usagePlugins", () => {
    test("registers the built-in plugins itself, so a fresh process is not empty", () => {
        freshProcess();

        expect(
            usagePlugins()
                .map((entry) => entry.plugin.id)
                .sort()
        ).toEqual(["anthropic-sub", "grok-sub", "openai-sub"]);
    });

    test("every entry carries the narrowed usage feature and its poll floor", () => {
        freshProcess();

        for (const entry of usagePlugins()) {
            expect(typeof entry.usage.poll).toBe("function");
            expect(entry.usage.minIntervalMs).toBeGreaterThan(0);
            expect(entry.features.presentation.prominentLimits.length).toBeGreaterThan(0);
        }
    });

    // Idempotence is what lets the call sit at the read site rather than at one entry
    // point: a second read must not duplicate a provider.
    test("a second call does not register a provider twice", () => {
        freshProcess();

        const first = usagePlugins().map((entry) => entry.plugin.id);
        const second = usagePlugins().map((entry) => entry.plugin.id);

        expect(second).toEqual(first);
        expect(new Set(second).size).toBe(second.length);
    });
});
