import { createDeepgram } from "@ai-sdk/deepgram";
import type { TranscriptionModel } from "ai";
import { resolveCredential } from "../credentials";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * The three transcription-only vendors.
 *
 * They were the last providers whose keys were read inline
 * (`env.ai.deepgram.getKey()` at transcription/TranscriptionManager.ts:377 and
 * the `ASSEMBLYAI_API_KEY`/`DEEPGRAM_API_KEY`/`GLADIA_API_KEY` table at :281),
 * which is exactly the pattern Phase 2 removed everywhere else: a key that
 * arrives without an account is a key nobody can audit, disable or attribute.
 *
 * Declaring the same variables as `credential.envKeys` is what makes the flip
 * safe rather than a breaking change. `resolveProviderApiKey` tries configured
 * accounts first and only then the declared variables, with a warning — so a
 * machine that has only ever had `DEEPGRAM_API_KEY` exported keeps transcribing,
 * and is told once how to make it explicit.
 *
 * Only Deepgram ships in this repo's dependency set. AssemblyAI and Gladia are
 * loaded on demand and fail with the install command rather than at import time,
 * which is how `TranscriptionManager` already treated them
 * (TranscriptionManager.ts:461-495) — the difference is that the failure now
 * names the fix.
 */

interface AsrVendorSpec {
    id: string;
    envKeys: readonly string[];
    /** Undefined for vendors whose SDK package is optional. */
    create?: (options: { apiKey: string }) => { transcriptionModel: (id: string) => TranscriptionModel };
    /** Package to import lazily when `create` is absent, and the export to read off it. */
    optionalPackage?: { name: string; exportName: string };
}

const SPECS: AsrVendorSpec[] = [
    {
        id: "deepgram",
        envKeys: ["DEEPGRAM_API_KEY"],
        create: (options) =>
            createDeepgram(options) as unknown as { transcriptionModel: (id: string) => TranscriptionModel },
    },
    {
        id: "assemblyai",
        envKeys: ["ASSEMBLYAI_API_KEY"],
        optionalPackage: { name: "@ai-sdk/assemblyai", exportName: "createAssemblyAI" },
    },
    {
        id: "gladia",
        envKeys: ["GLADIA_API_KEY"],
        optionalPackage: { name: "@ai-sdk/gladia", exportName: "createGladia" },
    },
];

type TranscriptionFactory = (options: { apiKey: string }) => {
    transcriptionModel: (id: string) => TranscriptionModel;
};

async function loadOptionalFactory(pkg: { name: string; exportName: string }): Promise<TranscriptionFactory> {
    let module: Record<string, unknown>;

    try {
        // String-typed specifier so the type checker skips module resolution for a
        // package that is legitimately absent from node_modules.
        module = (await import(pkg.name as string)) as Record<string, unknown>;
    } catch (err) {
        throw new Error(
            `${pkg.name} is not installed, so this provider cannot transcribe. Install it with: bun add ${pkg.name}`,
            { cause: err }
        );
    }

    const factory = module[pkg.exportName];

    if (typeof factory !== "function") {
        throw new Error(`${pkg.name} exports no ${pkg.exportName}()`);
    }

    return factory as TranscriptionFactory;
}

async function factoryFor(spec: AsrVendorSpec): Promise<TranscriptionFactory> {
    if (spec.create) {
        return spec.create;
    }

    if (!spec.optionalPackage) {
        throw new Error(`${spec.id} declares neither a factory nor an optional package`);
    }

    return loadOptionalFactory(spec.optionalPackage);
}

function buildPlugin(spec: AsrVendorSpec): ProviderPlugin {
    return {
        id: spec.id,
        kind: "api-key",
        capabilities: new Set(["transcribe"]),
        credential: { fields: ["apiKey"], envKeys: spec.envKeys, required: ["apiKey"] },

        async bind(ctx: BindContext): Promise<ProviderBinding> {
            const { apiKey } = await resolveCredential(ctx.account, this.credential);

            if (!apiKey) {
                throw new Error(`No API key resolved for ${spec.id}`);
            }

            const provider = await factoryFor(spec).then((create) => create({ apiKey }));

            return {
                accountId: ctx.account.id,
                providerId: spec.id,
                billed: true,
                language: (modelId: string) => {
                    throw new Error(`${spec.id} transcribes only; it has no chat model (${modelId}).`);
                },
                transcription: (modelId: string) => provider.transcriptionModel(modelId),
            } as ProviderBinding;
        },
    };
}

export const asrVendorPlugins: ProviderPlugin[] = SPECS.map(buildPlugin);
