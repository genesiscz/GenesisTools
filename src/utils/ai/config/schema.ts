import { z } from "zod";

/**
 * v4 unified AI config. Lives at the same path as v3 (`~/.genesis-tools/ai/config.json`)
 * so the existing migration runner, file locking and atomic writes all apply unchanged.
 */
export const CONFIG_VERSION = 4;

/** Task vocabulary. `classify` and `sentiment` come from v3's AITask and must not be dropped. */
export const TASK_NAMES = [
    "chat",
    "embed",
    "transcribe",
    "tts",
    "summarize",
    "translate",
    "classify",
    "sentiment",
    "image",
    "realtime",
] as const;
export type TaskName = (typeof TASK_NAMES)[number];

export const secureRefSchema = z.object({
    type: z.literal("secure"),
    path: z.string().min(1),
});

/** A credential field: a literal value (discouraged) or a vault pointer. */
export const maybeSecretSchema = z.union([z.string(), secureRefSchema]);
export type MaybeSecretValue = z.infer<typeof maybeSecretSchema>;

export const accountBillingSchema = z.object({
    mode: z.enum(["subscription", "metered", "free"]),
    plan: z.string().optional(),
    /** Billing-cycle anchor from the provider profile; drives renewal display. */
    anchor: z.string().optional(),
});

export const secondaryLoginSchema = z.object({
    accountUuid: z.string().optional(),
    accessToken: maybeSecretSchema.optional(),
    refreshToken: maybeSecretSchema.optional(),
    expiresAt: z.number().optional(),
    scopes: z.array(z.string()).optional(),
    subscriptionType: z.string().nullable().optional(),
    rateLimitTier: z.string().nullable().optional(),
    emailAddress: z.string().optional(),
    organizationUuid: z.string().optional(),
});

export const accountCredentialsSchema = z.object({
    apiKey: maybeSecretSchema.optional(),
    accessToken: maybeSecretSchema.optional(),
    refreshToken: maybeSecretSchema.optional(),
    longLivedToken: maybeSecretSchema.optional(),
    /**
     * Path to a subscription CLI's auth file (grok-sub, openai-sub). A live
     * reference read on demand, never copied into this config.
     */
    authFile: z.string().optional(),
    dataDir: z.string().optional(),
    expiresAt: z.number().optional(),
    refreshExpiresAt: z.number().optional(),
    longLivedTokenExpiresAt: z.number().optional(),
    secondary: secondaryLoginSchema.optional(),
});

/**
 * Env fallback policy. `false` for new accounts; the migration seeds it ENABLED
 * for every provider that resolves keys from the environment today, so nothing
 * silently loses its key (see vault doc `grandfather-env-keys`).
 */
export const useEnvApiKeySchema = z.union([z.boolean(), z.string(), z.array(z.string())]);

export const accountEntrySchema = z.object({
    /** Immutable. Refs and vault paths are built from this, so renaming is safe. */
    id: z.string().regex(/^acc_[a-z0-9][a-z0-9_-]*$/),
    /** Human handle shown in CLIs; renameable without rewriting refs. */
    name: z.string().min(1),
    provider: z.string().min(1),
    enabled: z.boolean(),
    label: z.string().optional(),
    tags: z.array(z.string()).optional(),
    billing: accountBillingSchema,
    credentials: accountCredentialsSchema,
    useEnvApiKey: useEnvApiKeySchema.default(false),
    /** Escape hatch for selector exceptions; empty in the common case. */
    overrides: z.record(z.string(), z.unknown()).optional(),
    subscriptionCreatedAt: z.string().optional(),
});

export const accountRefSchema = z.string().regex(/^@account\/acc_[a-z0-9][a-z0-9_-]*$/);

export const taskDefaultSchema = z.object({
    model: z.string().optional(),
    provider: z.string().optional(),
});

/**
 * Per-app overrides: one optional block per task, plus generation knobs.
 * Task keys are spelled out rather than a catchall so `app.chat.model` is typed
 * for consumers instead of collapsing into a union with the numeric knobs.
 */
export const appDefaultSchema = z.object({
    ...(Object.fromEntries(TASK_NAMES.map((task) => [task, taskDefaultSchema.optional()])) as Record<
        TaskName,
        z.ZodOptional<typeof taskDefaultSchema>
    >),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    streaming: z.boolean().optional(),
});

export const aiConfigSchema = z.object({
    version: z.literal(CONFIG_VERSION),
    accounts: z.array(accountEntrySchema),
    defaults: z
        .object({
            account: z.record(z.string(), accountRefSchema).optional(),
            task: z.record(z.string(), taskDefaultSchema).optional(),
            app: z.record(z.string(), appDefaultSchema).optional(),
        })
        .default({}),
    models: z
        .object({
            aliases: z.record(z.string(), z.string()).optional(),
            hidden: z.array(z.string()).optional(),
        })
        .optional(),
    discovery: z
        .object({
            ttl: z.string().optional(),
            sources: z
                .object({
                    litellm: z.boolean().optional(),
                    openrouter: z.boolean().optional(),
                    liveProbe: z.boolean().optional(),
                })
                .optional(),
        })
        .optional(),
});

export type AccountBilling = z.infer<typeof accountBillingSchema>;
export type AccountCredentials = z.infer<typeof accountCredentialsSchema>;
export type AccountEntry = z.infer<typeof accountEntrySchema>;
export type TaskDefault = z.infer<typeof taskDefaultSchema>;
export type AppDefault = z.infer<typeof appDefaultSchema>;
export type AiConfigData = z.infer<typeof aiConfigSchema>;
export type UseEnvApiKey = z.infer<typeof useEnvApiKeySchema>;

export function emptyConfig(): AiConfigData {
    return { version: CONFIG_VERSION, accounts: [], defaults: {} };
}

export function isTaskName(value: string): value is TaskName {
    return (TASK_NAMES as readonly string[]).includes(value);
}
