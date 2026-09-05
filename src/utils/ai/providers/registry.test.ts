import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProviderPlugin } from "./plugin-types";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "./plugins";
import {
    _resetPluginsForTest,
    allProviderPlugins,
    pluginsByCapability,
    pluginsWithAccounts,
    pluginsWithUsage,
    providerPlugin,
    registeredProviderIds,
    registerPlugin,
    UnknownProviderError,
} from "./registry";

function isPlugin(value: unknown): value is ProviderPlugin {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as ProviderPlugin).id === "string" &&
        typeof (value as ProviderPlugin).bind === "function"
    );
}

/** Flat plugin files plus each plugin folder's `index.ts`, never their siblings. */
async function scanPluginIds(): Promise<string[]> {
    const found: string[] = [];

    for (const pattern of ["*.ts", "*/index.ts"]) {
        for await (const file of new Bun.Glob(pattern).scan({ cwd: `${import.meta.dir}/plugins` })) {
            if (file.endsWith(".test.ts")) {
                continue;
            }

            const module: Record<string, unknown> = await import(`${import.meta.dir}/plugins/${file}`);

            for (const exported of Object.values(module)) {
                for (const candidate of Array.isArray(exported) ? exported : [exported]) {
                    if (isPlugin(candidate)) {
                        found.push(candidate.id);
                    }
                }
            }
        }
    }

    return found;
}

function fakePlugin(id: string): ProviderPlugin {
    return {
        id,
        kind: "api-key",
        capabilities: new Set(["chat"]),
        credential: { fields: ["apiKey"], envKeys: [] },
        bind: async () => {
            throw new Error("not used");
        },
    };
}

beforeEach(() => {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

afterEach(() => {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

describe("provider registry", () => {
    test("registers, looks up and lists plugins", () => {
        registerPlugin(fakePlugin("alpha"));
        registerPlugin(fakePlugin("beta"));

        expect(providerPlugin("alpha").id).toBe("alpha");
        expect(registeredProviderIds()).toEqual(["alpha", "beta"]);
        expect(allProviderPlugins().length).toBe(2);
    });

    test("an unknown provider names the ones that exist", () => {
        registerPlugin(fakePlugin("alpha"));

        expect(() => providerPlugin("nope")).toThrow(UnknownProviderError);
        expect(() => providerPlugin("nope")).toThrow("Known providers: alpha");
    });

    test("double registration is a loud error, not a silent overwrite", () => {
        registerPlugin(fakePlugin("alpha"));

        expect(() => registerPlugin(fakePlugin("alpha"))).toThrow("registered twice");
    });

    test("filters by capability", () => {
        registerPlugin(fakePlugin("alpha"));
        registerPlugin({ ...fakePlugin("tts-only"), capabilities: new Set(["tts"]) });

        expect(pluginsByCapability("chat").map((p) => p.id)).toEqual(["alpha"]);
        expect(pluginsByCapability("tts").map((p) => p.id)).toEqual(["tts-only"]);
        expect(pluginsByCapability("video")).toEqual([]);
    });

    // Presence of the member is the capability declaration, so these two filters
    // are the whole feature gate: no parallel enum, nothing to keep in sync.
    test("filters by account features, and usage separately from accounts", () => {
        const presentation = { displayName: "Alpha", alias: "alpha", limitOrder: [], prominentLimits: [] };

        registerPlugin(fakePlugin("plain"));
        registerPlugin({
            ...fakePlugin("with-accounts"),
            accounts: { presentation, logoutTargets: ["oauth"] },
        });
        registerPlugin({
            ...fakePlugin("with-usage"),
            accounts: {
                presentation,
                logoutTargets: ["oauth"],
                usage: {
                    poll: async () => {
                        throw new Error("not used");
                    },
                },
            },
        });

        expect(pluginsWithAccounts().map((p) => p.id)).toEqual(["with-accounts", "with-usage"]);
        expect(pluginsWithUsage().map((p) => p.id)).toEqual(["with-usage"]);
    });
});

describe("built-in plugins", () => {
    test("register without collisions and are idempotent", () => {
        registerBuiltInPlugins();
        const first = registeredProviderIds();

        registerBuiltInPlugins();

        expect(registeredProviderIds()).toEqual(first);
        expect(first).toContain("anthropic-sub");
        expect(first).toContain("openai");
    });

    test("every api-key plugin declares the env variables it will read", () => {
        registerBuiltInPlugins();

        for (const plugin of allProviderPlugins().filter((p) => p.kind === "api-key")) {
            expect(plugin.credential.envKeys.length).toBeGreaterThan(0);
            expect(plugin.credential.required).toContain("apiKey");
        }
    });

    test("the google plugin names the variable the bare SDK singleton used to read", () => {
        registerBuiltInPlugins();

        expect(providerPlugin("google").credential.envKeys).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    });

    // Guards the one manual step in adding a provider: a plugin file that is never
    // listed in plugins.ts would otherwise just not exist at runtime. The ids come
    // from the modules themselves rather than a list kept here, because a list
    // here would need the same manual update it is supposed to catch.
    test("every plugin file is reachable through the barrel", async () => {
        registerBuiltInPlugins();
        const registered = new Set(registeredProviderIds());

        const found = await scanPluginIds();

        expect(found.length).toBeGreaterThan(0);

        for (const id of found) {
            expect(registered.has(id)).toBe(true);
        }
    });

    /**
     * A plugin that outgrew one file becomes a FOLDER with an `index.ts`
     * (anthropic-sub, openai-sub, grok-sub carry login and discovery modules
     * beside the plugin). Two explicit scans rather than `**\/*.ts`: the siblings
     * export helpers, not plugins, and importing them would only be work.
     */
    test("a plugin folder's index.ts is scanned like a flat plugin file", async () => {
        registerBuiltInPlugins();

        const found = await scanPluginIds();

        expect(found).toContain("anthropic-sub");
        expect(found).toContain("openai-sub");
        expect(found).toContain("grok-sub");
        // The flat files must not have been dropped by the second pattern.
        expect(found).toContain("openrouter");
    });
});
