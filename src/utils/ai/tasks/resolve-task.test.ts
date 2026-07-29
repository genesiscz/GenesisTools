import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore } from "../config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../config/schema";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../providers/plugin-types";
import { _resetBuiltInPluginsForTest } from "../providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "../providers/registry";
import { NoProviderForTaskError, resolveForTask } from "./resolve-task";

/**
 * The chain is tested with fake plugins rather than the real ones: what matters
 * is the ORDER a candidate is tried in and whether an unusable one is skipped,
 * and pinning that against real bindings would mean owning an API key.
 */

let home: string;
const disposed: string[] = [];

function account(id: string, provider: string, enabled = true): AccountEntry {
    return {
        id,
        name: `${provider}-acct`,
        provider,
        enabled,
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: false,
    };
}

function writeConfig(accounts: AccountEntry[], defaults: AiConfigData["defaults"] = {}): void {
    const full: AiConfigData = { version: CONFIG_VERSION, accounts, defaults };
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(full, null, 2));
    AiConfigStore.invalidate();
}

function fakePlugin(id: string, opts: { transcription?: boolean; bindThrows?: boolean } = {}): ProviderPlugin {
    return {
        id,
        kind: "api-key",
        capabilities: new Set(["transcribe"]),
        credential: { fields: [], envKeys: [] },
        async bind(ctx: BindContext): Promise<ProviderBinding> {
            if (opts.bindThrows) {
                throw new Error(`${id} cannot bind`);
            }

            return {
                accountId: ctx.account.id,
                providerId: id,
                billed: true,
                language: () => {
                    throw new Error("no chat");
                },
                ...(opts.transcription
                    ? { transcription: () => ({ specificationVersion: "v3", provider: id, modelId: "m" }) }
                    : {}),
                dispose: () => {
                    disposed.push(id);
                },
            } as ProviderBinding;
        },
    };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-resolve-task-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    disposed.length = 0;
    AiConfigStore.invalidate();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(true);
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

describe("resolveForTask availability chain", () => {
    test("degrades past a provider that cannot bind, in fallback order", async () => {
        registerPlugin(fakePlugin("deepgram", { bindThrows: true }));
        registerPlugin(fakePlugin("groq", { transcription: true }));
        writeConfig([account("acc_dg", "deepgram"), account("acc_groq", "groq")]);

        const resolved = await resolveForTask({ task: "transcribe", needs: "transcription" });

        expect(resolved.plugin.id).toBe("groq");
        expect(resolved.model.id).toBe("whisper-large-v3");
    });

    test("skips a candidate whose binding has no method for the task, and disposes it", async () => {
        registerPlugin(fakePlugin("groq", { transcription: false }));
        registerPlugin(fakePlugin("deepgram", { transcription: true }));
        writeConfig([account("acc_groq", "groq"), account("acc_dg", "deepgram")]);

        const resolved = await resolveForTask({ task: "transcribe", needs: "transcription" });

        expect(resolved.plugin.id).toBe("deepgram");
        expect(disposed).toContain("groq");
    });

    test("an explicit ref never degrades — it throws instead", async () => {
        registerPlugin(fakePlugin("deepgram", { bindThrows: true }));
        registerPlugin(fakePlugin("groq", { transcription: true }));
        writeConfig([account("acc_dg", "deepgram"), account("acc_groq", "groq")]);

        await expect(resolveForTask({ task: "transcribe", model: "deepgram/nova-3" })).rejects.toThrow(/cannot bind/);
    });

    test("names what it tried when nothing on the chain answers", async () => {
        registerPlugin(fakePlugin("deepgram", { bindThrows: true }));
        writeConfig([account("acc_dg", "deepgram")]);

        await expect(resolveForTask({ task: "transcribe", needs: "transcription" })).rejects.toThrow(
            NoProviderForTaskError
        );
    });

    test("a disabled account is not a fallback candidate", async () => {
        registerPlugin(fakePlugin("deepgram", { transcription: true }));
        registerPlugin(fakePlugin("groq", { transcription: true }));
        writeConfig([account("acc_dg", "deepgram", false), account("acc_groq", "groq")]);

        const resolved = await resolveForTask({ task: "transcribe", needs: "transcription" });

        expect(resolved.plugin.id).toBe("groq");
    });
});
