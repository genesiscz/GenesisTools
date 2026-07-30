import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProviderPlugin } from "./plugin-types";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "./plugins";
import {
    _resetPluginsForTest,
    allProviderPlugins,
    pluginsByCapability,
    providerPlugin,
    registeredProviderIds,
    registerPlugin,
    UnknownProviderError,
} from "./registry";

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
    // listed in plugins.ts would otherwise just not exist at runtime.
    test("every plugin file is reachable through the barrel", async () => {
        registerBuiltInPlugins();
        const registered = new Set(registeredProviderIds());

        const glob = new Bun.Glob("*.ts");
        const files: string[] = [];
        for await (const file of glob.scan({ cwd: `${import.meta.dir}/plugins` })) {
            files.push(file.replace(/\.ts$/, ""));
        }

        for (const file of files) {
            // api-key.ts contributes several ids; check it by one of them.
            const ids = file === "api-key" ? ["openai", "xai", "groq", "google", "openrouter", "anthropic"] : [file];
            for (const id of ids) {
                expect(registered.has(id)).toBe(true);
            }
        }
    });
});
