import { describe, expect, test } from "bun:test";
import { GRANDFATHERED_ENV_PROVIDERS } from "../../config/migrations/2026-08-seedEnvAccounts";
import { asrVendorPlugins } from "./asr-vendors";

/**
 * The grandfather contract, pinned.
 *
 * `TranscriptionManager` used to read `ASSEMBLYAI_API_KEY` / `DEEPGRAM_API_KEY` /
 * `GLADIA_API_KEY` inline. Those variables keep working only because each plugin
 * DECLARES them, which is what lets `resolveProviderApiKey` fall back to them
 * (with a warning) when no account exists. A typo in one of these strings is a
 * silent "transcription stopped working after the upgrade", so the names are
 * asserted against the seed migration's list rather than repeated by hand.
 */

const seeded = new Map(GRANDFATHERED_ENV_PROVIDERS.map((entry) => [entry.provider, entry.envKeys]));

describe("ASR vendor plugins", () => {
    test("cover exactly the three transcription-only vendors", () => {
        expect(asrVendorPlugins.map((plugin) => plugin.id).sort()).toEqual(["assemblyai", "deepgram", "gladia"]);
    });

    for (const plugin of asrVendorPlugins) {
        test(`${plugin.id} declares the env keys its seeded account uses`, () => {
            expect([...plugin.credential.envKeys]).toEqual([...(seeded.get(plugin.id) ?? [])]);
            expect(plugin.credential.required).toEqual(["apiKey"]);
        });

        test(`${plugin.id} declares transcribe and nothing it cannot do`, () => {
            expect([...plugin.capabilities]).toEqual(["transcribe"]);
            expect(plugin.kind).toBe("api-key");
        });
    }
});
