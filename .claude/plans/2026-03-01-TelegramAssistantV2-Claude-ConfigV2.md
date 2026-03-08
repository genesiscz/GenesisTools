# Phase 3: Config V2 & Model Selection

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the contact configuration schema to support per-contact per-mode AI settings (autoReply, assistant, suggestions), style profiles, watch config, and group/channel support. Provide backward compatibility with V1 configs. Integrate Ask's interactive provider/model selection into Telegram's configure flow.

**Architecture:** New `TelegramContactV2` type with nested mode configs. V1→V2 migration normalizer runs on config load. `configure.ts` updated with richer interactive flows. Ask's `ModelSelector` reused for provider/model picking.

**Tech Stack:** @clack/prompts, Commander, AI SDK providers

**Prerequisites:** Phase 1 complete (schema), Phase 2 complete (sync)

---

## Task 1: Define V2 Config Types

**Files:**
- Modify: `src/telegram/lib/types.ts`

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/configV2.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type {
    TelegramContactV2,
    AskModeConfig,
    SuggestionModeConfig,
    StyleProfileConfig,
    StyleSourceRule,
    WatchConfig,
    ContactModesConfig,
    TelegramConfigDataV2,
} from "../types";
import { DEFAULT_MODE_CONFIG, DEFAULT_WATCH_CONFIG, DEFAULT_STYLE_PROFILE } from "../types";

describe("V2 Config types", () => {
    it("default mode config has correct shape", () => {
        expect(DEFAULT_MODE_CONFIG.autoReply.enabled).toBe(false);
        expect(DEFAULT_MODE_CONFIG.assistant.enabled).toBe(true);
        expect(DEFAULT_MODE_CONFIG.suggestions.enabled).toBe(true);
        expect(DEFAULT_MODE_CONFIG.suggestions.count).toBe(3);
        expect(DEFAULT_MODE_CONFIG.suggestions.trigger).toBe("manual");
    });

    it("default watch config has correct shape", () => {
        expect(DEFAULT_WATCH_CONFIG.enabled).toBe(true);
        expect(DEFAULT_WATCH_CONFIG.contextLength).toBe(30);
        expect(DEFAULT_WATCH_CONFIG.runtimeMode).toBe("ink");
    });

    it("default style profile is disabled", () => {
        expect(DEFAULT_STYLE_PROFILE.enabled).toBe(false);
        expect(DEFAULT_STYLE_PROFILE.rules).toEqual([]);
    });

    it("TelegramContactV2 can be constructed", () => {
        const contact: TelegramContactV2 = {
            userId: "123",
            displayName: "Alice",
            username: "alice",
            chatType: "user",
            actions: ["ask", "notify"],
            watch: DEFAULT_WATCH_CONFIG,
            modes: DEFAULT_MODE_CONFIG,
            styleProfile: DEFAULT_STYLE_PROFILE,
            replyDelayMin: 2000,
            replyDelayMax: 5000,
        };
        expect(contact.displayName).toBe("Alice");
        expect(contact.modes.suggestions.count).toBe(3);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/configV2.test.ts
```

**Step 3: Add V2 config types to types.ts**

Add to `src/telegram/lib/types.ts`:

```typescript
// --- V2 Config Types ---

export type TelegramRuntimeMode = "daemon" | "light" | "ink";

export interface AskModeConfig {
    enabled: boolean;
    provider?: string;
    model?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
}

export interface SuggestionModeConfig extends AskModeConfig {
    count: number; // 3-5, default 3
    trigger: "manual" | "auto" | "hybrid";
    autoDelayMs: number; // burst debounce, default 5000
    allowAutoSend: boolean; // default false
}

export interface StyleSourceRule {
    id: string;
    sourceChatId: string;
    direction: "outgoing" | "incoming";
    limit?: number;
    since?: string; // ISO
    until?: string; // ISO
    regex?: string;
}

export interface StyleProfileConfig {
    enabled: boolean;
    refresh: "incremental";
    rules: StyleSourceRule[];
    previewInWatch: boolean;
}

export interface WatchConfig {
    enabled: boolean;
    contextLength: number;
    runtimeMode: TelegramRuntimeMode;
}

export interface ContactModesConfig {
    autoReply: AskModeConfig;
    assistant: AskModeConfig;
    suggestions: SuggestionModeConfig;
}

export interface TelegramContactV2 {
    userId: string;
    displayName: string;
    username?: string;
    chatType: ChatType;
    actions: ActionType[];
    watch: WatchConfig;
    modes: ContactModesConfig;
    styleProfile: StyleProfileConfig;
    replyDelayMin: number;
    replyDelayMax: number;
}

export interface TelegramConfigDataV2 {
    version: 2;
    apiId: number;
    apiHash: string;
    session: string;
    me?: {
        firstName: string;
        username?: string;
        phone?: string;
    };
    contacts: TelegramContactV2[];
    globalDefaults: {
        modes: ContactModesConfig;
        watch: WatchConfig;
        styleProfile: StyleProfileConfig;
    };
    configuredAt: string;
}

// --- Defaults ---

export const DEFAULT_MODE_CONFIG: ContactModesConfig = {
    autoReply: {
        enabled: false,
        provider: undefined,
        model: undefined,
        systemPrompt: undefined,
    },
    assistant: {
        enabled: true,
        provider: undefined,
        model: undefined,
        systemPrompt: undefined,
    },
    suggestions: {
        enabled: true,
        provider: undefined,
        model: undefined,
        systemPrompt: undefined,
        count: 3,
        trigger: "manual",
        autoDelayMs: 5000,
        allowAutoSend: false,
    },
};

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
    enabled: true,
    contextLength: 30,
    runtimeMode: "ink",
};

export const DEFAULT_STYLE_PROFILE: StyleProfileConfig = {
    enabled: false,
    refresh: "incremental",
    rules: [],
    previewInWatch: false,
};
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/configV2.test.ts
```

**Step 5: Commit**

```bash
git add src/telegram/lib/types.ts src/telegram/lib/__tests__/configV2.test.ts
git commit -m "feat(telegram): V2 config type definitions with defaults"
```

---

## Task 2: V1 → V2 Config Migration

**Files:**
- Modify: `src/telegram/lib/TelegramToolConfig.ts`

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/configMigration.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { migrateContactV1toV2, migrateConfigV1toV2 } from "../TelegramToolConfig";
import type { ContactConfig, TelegramConfigData } from "../types";

describe("V1 → V2 config migration", () => {
    it("migrates a V1 contact with ask config into V2 modes", () => {
        const v1: ContactConfig = {
            userId: "123",
            displayName: "Alice",
            username: "alice",
            actions: ["ask", "notify"],
            askSystemPrompt: "Be helpful",
            askProvider: "openai",
            askModel: "gpt-4o",
            replyDelayMin: 2000,
            replyDelayMax: 5000,
        };

        const v2 = migrateContactV1toV2(v1);

        expect(v2.userId).toBe("123");
        expect(v2.displayName).toBe("Alice");
        expect(v2.chatType).toBe("user");
        expect(v2.actions).toEqual(["ask", "notify"]);

        // V1 ask fields should map to autoReply mode
        expect(v2.modes.autoReply.enabled).toBe(true); // because "ask" is in actions
        expect(v2.modes.autoReply.provider).toBe("openai");
        expect(v2.modes.autoReply.model).toBe("gpt-4o");
        expect(v2.modes.autoReply.systemPrompt).toBe("Be helpful");

        // Other modes get defaults
        expect(v2.modes.assistant.enabled).toBe(true);
        expect(v2.modes.suggestions.enabled).toBe(true);
        expect(v2.modes.suggestions.count).toBe(3);
    });

    it("migrates a V1 contact without ask config", () => {
        const v1: ContactConfig = {
            userId: "456",
            displayName: "Bob",
            actions: ["notify"],
            replyDelayMin: 2000,
            replyDelayMax: 5000,
        };

        const v2 = migrateContactV1toV2(v1);

        expect(v2.modes.autoReply.enabled).toBe(false);
        expect(v2.modes.autoReply.provider).toBeUndefined();
    });

    it("migrates full V1 config to V2", () => {
        const v1: TelegramConfigData = {
            apiId: 12345,
            apiHash: "abc",
            session: "session",
            contacts: [
                { userId: "1", displayName: "A", actions: ["ask"], replyDelayMin: 2000, replyDelayMax: 5000 },
            ],
            configuredAt: "2024-01-01",
        };

        const v2 = migrateConfigV1toV2(v1);

        expect(v2.version).toBe(2);
        expect(v2.contacts.length).toBe(1);
        expect(v2.contacts[0].modes).toBeDefined();
        expect(v2.globalDefaults).toBeDefined();
    });

    it("passes through V2 config unchanged", () => {
        const v2Config = {
            version: 2,
            apiId: 12345,
            apiHash: "abc",
            session: "session",
            contacts: [],
            globalDefaults: {
                modes: { autoReply: { enabled: false }, assistant: { enabled: true }, suggestions: { enabled: true, count: 3, trigger: "manual", autoDelayMs: 5000, allowAutoSend: false } },
                watch: { enabled: true, contextLength: 30, runtimeMode: "ink" },
                styleProfile: { enabled: false, refresh: "incremental", rules: [], previewInWatch: false },
            },
            configuredAt: "2024-01-01",
        };

        // Should not throw or modify
        const result = migrateConfigV1toV2(v2Config as any);
        expect(result.version).toBe(2);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/configMigration.test.ts
```

**Step 3: Implement migration functions**

Add to `src/telegram/lib/TelegramToolConfig.ts`:

```typescript
import {
    DEFAULT_MODE_CONFIG,
    DEFAULT_WATCH_CONFIG,
    DEFAULT_STYLE_PROFILE,
    type ContactConfig,
    type TelegramConfigData,
    type TelegramContactV2,
    type TelegramConfigDataV2,
} from "./types";

export function migrateContactV1toV2(v1: ContactConfig): TelegramContactV2 {
    const hasAsk = v1.actions.includes("ask");

    return {
        userId: v1.userId,
        displayName: v1.displayName,
        username: v1.username,
        chatType: "user",
        actions: v1.actions,
        watch: { ...DEFAULT_WATCH_CONFIG },
        modes: {
            autoReply: {
                enabled: hasAsk,
                provider: v1.askProvider,
                model: v1.askModel,
                systemPrompt: v1.askSystemPrompt,
            },
            assistant: { ...DEFAULT_MODE_CONFIG.assistant },
            suggestions: { ...DEFAULT_MODE_CONFIG.suggestions },
        },
        styleProfile: { ...DEFAULT_STYLE_PROFILE },
        replyDelayMin: v1.replyDelayMin,
        replyDelayMax: v1.replyDelayMax,
    };
}

export function migrateConfigV1toV2(config: TelegramConfigData | TelegramConfigDataV2): TelegramConfigDataV2 {
    // Already V2
    if ("version" in config && config.version === 2) {
        return config as TelegramConfigDataV2;
    }

    const v1 = config as TelegramConfigData;
    return {
        version: 2,
        apiId: v1.apiId,
        apiHash: v1.apiHash,
        session: v1.session,
        me: v1.me,
        contacts: v1.contacts.map(migrateContactV1toV2),
        globalDefaults: {
            modes: { ...DEFAULT_MODE_CONFIG },
            watch: { ...DEFAULT_WATCH_CONFIG },
            styleProfile: { ...DEFAULT_STYLE_PROFILE },
        },
        configuredAt: v1.configuredAt,
    };
}
```

Update the `load()` method in `TelegramToolConfig` to auto-migrate:

```typescript
async load(): Promise<TelegramConfigDataV2 | null> {
    const raw = await this.storage.load();
    if (!raw) return null;
    this.data = migrateConfigV1toV2(raw);
    return this.data;
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/configMigration.test.ts
```

**Step 5: Commit**

```bash
git add src/telegram/lib/TelegramToolConfig.ts src/telegram/lib/__tests__/configMigration.test.ts
git commit -m "feat(telegram): V1→V2 config migration with backward compatibility"
```

---

## Task 3: Export Ask's Model Selection for Reuse

**Files:**
- Modify: `src/ask/index.lib.ts`

**Context:** `ModelSelector` in `src/ask/providers/ModelSelector.ts` has the interactive `selectModel()` flow. We need to export it (and `ProviderManager`) so Telegram's configure command can reuse them.

**Step 1: Add exports to index.lib.ts**

Add these exports to `src/ask/index.lib.ts`:

```typescript
export { ModelSelector } from "./providers/ModelSelector";
export { ProviderManager } from "./providers/ProviderManager";
export type { DetectedProvider, ModelInfo, ProviderChoice } from "./types";
```

**Step 2: Verify exports compile**

```bash
bunx tsgo --noEmit | rg "src/ask"
```

**Step 3: Commit**

```bash
git add src/ask/index.lib.ts
git commit -m "feat(ask): export ModelSelector and ProviderManager for cross-tool reuse"
```

---

## Task 4: Update Configure Command — Group/Channel Support + Model Selection

**Files:**
- Modify: `src/telegram/commands/configure.ts`

**Context:** The current configure command only discovers user dialogs. We need to:
1. Also discover groups and channels
2. Use Ask's `ModelSelector` for per-mode provider/model selection
3. Support V2 contact shape with watch/modes/style config

**Step 1: Update dialog discovery to include groups/channels**

In `src/telegram/commands/configure.ts`, find the dialog filtering logic (around where `client.getDialogs()` is called). Change the filter to include groups and channels:

```typescript
const dialogs = await client.getDialogs(200);

// Separate by type
const userDialogs = dialogs.filter((d) => d.isUser && !d.entity?.bot && d.entity?.id !== me.id);
const groupDialogs = dialogs.filter((d) => d.isGroup);
const channelDialogs = dialogs.filter((d) => d.isChannel);

// Build choices with type labels
const choices = [
    ...userDialogs.map((d) => ({
        value: { dialog: d, type: "user" as const },
        label: `👤 ${d.title}${d.entity?.username ? ` (@${d.entity.username})` : ""}`,
    })),
    ...groupDialogs.map((d) => ({
        value: { dialog: d, type: "group" as const },
        label: `👥 ${d.title}`,
    })),
    ...channelDialogs.map((d) => ({
        value: { dialog: d, type: "channel" as const },
        label: `📢 ${d.title}${d.entity?.username ? ` (@${d.entity.username})` : ""}`,
    })),
];
```

**Step 2: Add per-mode model selection**

After contact selection, for each contact, add mode configuration:

```typescript
import { ModelSelector, ProviderManager } from "@app/ask/index.lib";

// For each selected contact:
const modeChoices = await p.multiselect({
    message: `Which AI modes for ${contact.displayName}?`,
    options: [
        { value: "autoReply", label: "Auto-Reply", hint: "Automatically respond to messages" },
        { value: "assistant", label: "Chat Assistant", hint: "Ask questions about the conversation" },
        { value: "suggestions", label: "Message Suggestions", hint: "Get suggested replies to pick/edit/send" },
    ],
});

if (p.isCancel(modeChoices)) continue;

const modes = { ...DEFAULT_MODE_CONFIG };
const providerManager = new ProviderManager();
const providers = await providerManager.detectProviders();
const modelSelector = new ModelSelector(providers);

for (const mode of modeChoices as string[]) {
    const configureModel = await p.confirm({
        message: `Configure custom model for ${mode}?`,
        initialValue: false,
    });

    if (configureModel && !p.isCancel(configureModel)) {
        const choice = await modelSelector.selectModel();
        if (choice) {
            modes[mode as keyof typeof modes] = {
                ...modes[mode as keyof typeof modes],
                enabled: true,
                provider: choice.provider.name,
                model: choice.model.id,
            };
        }
    } else {
        modes[mode as keyof typeof modes] = {
            ...modes[mode as keyof typeof modes],
            enabled: true,
        };
    }
}
```

**Step 3: Add watch config**

```typescript
const contextLength = await p.text({
    message: `Context window size (number of recent messages)?`,
    initialValue: "30",
    validate: (v) => {
        const n = Number.parseInt(v, 10);
        if (Number.isNaN(n) || n < 1 || n > 500) return "Must be 1-500";
    },
});

const watchConfig: WatchConfig = {
    enabled: true,
    contextLength: Number.parseInt(contextLength as string, 10),
    runtimeMode: "ink",
};
```

**Step 4: Assemble V2 contact and save**

```typescript
const v2Contact: TelegramContactV2 = {
    userId: String(dialog.entity.id),
    displayName: dialog.title,
    username: dialog.entity?.username,
    chatType: type, // "user" | "group" | "channel"
    actions: selectedActions,
    watch: watchConfig,
    modes,
    styleProfile: { ...DEFAULT_STYLE_PROFILE },
    replyDelayMin: DEFAULTS.replyDelayMin,
    replyDelayMax: DEFAULTS.replyDelayMax,
};
```

**Step 5: Type check and commit**

```bash
bunx tsgo --noEmit | rg "src/telegram"
git add src/telegram/commands/configure.ts
git commit -m "feat(telegram): V2 configure with groups/channels and per-mode model selection"
```

---

## Task 5: Update TelegramContact Wrapper for V2

**Files:**
- Modify: `src/telegram/lib/TelegramContact.ts`

**Context:** The `TelegramContact` class wraps `ContactConfig`. It needs to also work with `TelegramContactV2`, accessing modes and watch config.

**Step 1: Update TelegramContact**

```typescript
import type { TelegramContactV2, AskModeConfig, SuggestionModeConfig, WatchConfig, StyleProfileConfig, ContactModesConfig } from "./types";
import { DEFAULT_MODE_CONFIG, DEFAULT_WATCH_CONFIG, DEFAULT_STYLE_PROFILE, DEFAULTS } from "./types";

export class TelegramContact {
    readonly userId: string;
    readonly displayName: string;
    readonly username: string | undefined;
    readonly config: TelegramContactV2;

    constructor(config: TelegramContactV2) {
        this.userId = config.userId;
        this.displayName = config.displayName;
        this.username = config.username;
        this.config = config;
    }

    get actions() { return this.config.actions; }
    get chatType() { return this.config.chatType; }
    get hasAskAction() { return this.config.actions.includes("ask"); }

    // Mode accessors
    get modes(): ContactModesConfig { return this.config.modes ?? DEFAULT_MODE_CONFIG; }
    get autoReply(): AskModeConfig { return this.modes.autoReply; }
    get assistant(): AskModeConfig { return this.modes.assistant; }
    get suggestions(): SuggestionModeConfig { return this.modes.suggestions as SuggestionModeConfig; }

    // Watch config
    get watch(): WatchConfig { return this.config.watch ?? DEFAULT_WATCH_CONFIG; }
    get contextLength(): number { return this.watch.contextLength; }

    // Style profile
    get styleProfile(): StyleProfileConfig { return this.config.styleProfile ?? DEFAULT_STYLE_PROFILE; }

    // Backward compat — resolve provider/model from mode or defaults
    get askProvider(): string {
        return this.autoReply.provider ?? DEFAULTS.askProvider;
    }
    get askModel(): string {
        return this.autoReply.model ?? DEFAULTS.askModel;
    }
    get askSystemPrompt(): string {
        return this.autoReply.systemPrompt ?? DEFAULTS.askSystemPrompt;
    }

    get replyDelayMin(): number { return this.config.replyDelayMin ?? DEFAULTS.replyDelayMin; }
    get replyDelayMax(): number { return this.config.replyDelayMax ?? DEFAULTS.replyDelayMax; }
    get randomDelay(): number {
        return this.replyDelayMin + Math.random() * (this.replyDelayMax - this.replyDelayMin);
    }

    static fromConfig(config: TelegramContactV2): TelegramContact {
        return new TelegramContact(config);
    }
}
```

**Step 2: Update all callers**

Search for `TelegramContact.fromUser` and `TelegramContact.fromConfig` and `new TelegramContact` across `src/telegram/` to ensure they pass V2 configs. The `handler.ts` and `listen.ts` build `TelegramContact` from `ContactConfig` — after migration, they receive `TelegramContactV2`.

**Step 3: Type check and commit**

```bash
bunx tsgo --noEmit | rg "src/telegram"
git add src/telegram/lib/TelegramContact.ts src/telegram/lib/handler.ts src/telegram/commands/listen.ts
git commit -m "refactor(telegram): TelegramContact uses V2 config shape"
```

---

## Task 6: Update handler.ts and listen.ts for V2 Config

**Files:**
- Modify: `src/telegram/lib/handler.ts`
- Modify: `src/telegram/commands/listen.ts`

**Context:** These files currently use `ContactConfig`. After V2, they need to use `TelegramContactV2` from the migrated config.

**Step 1: Update listen.ts**

In `listen.ts`, change the config load to use the migrated V2 config:

```typescript
const config = new TelegramToolConfig();
const data = await config.load(); // Now returns TelegramConfigDataV2
```

Since `data.contacts` is now `TelegramContactV2[]`, all downstream code (handler, actions) receives V2 contacts.

**Step 2: Update handler.ts**

The `registerHandler` function takes `contacts: ContactConfig[]`. Change to `contacts: TelegramContactV2[]`:

```typescript
interface HandlerOptions {
    contacts: TelegramContactV2[];
    myName: string;
    initialHistory?: Map<string, string[]>;
    store: TelegramHistoryStore;
}
```

**Step 3: Type check all changes flow through**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

Fix any remaining type errors from the ContactConfig → TelegramContactV2 transition.

**Step 4: Commit**

```bash
git add src/telegram/
git commit -m "refactor(telegram): all handlers use V2 config types"
```

---

## Task 7: Phase 3 Verification

**Step 1: Run all tests**

```bash
bun test src/telegram/
```

**Step 2: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
bunx tsgo --noEmit | rg "src/ask"
```

**Step 3: Lint**

```bash
bunx biome check src/telegram src/ask
```

**Step 4: Test V1 config migration manually**

If you have an existing V1 config at `~/.genesis-tools/telegram/config.json`, back it up and verify:

```bash
cp ~/.genesis-tools/telegram/config.json ~/.genesis-tools/telegram/config.json.v1.bak
tools telegram contacts
# Should load and display contacts normally (auto-migrated)
```

**Step 5: Commit fixes**

```bash
git add src/telegram/ src/ask/
git commit -m "fix(telegram): Phase 3 verification fixes"
```

---

## Summary of Phase 3 Deliverables

| Component | File | Status |
|-----------|------|--------|
| V2 config types + defaults | `src/telegram/lib/types.ts` | Task 1 |
| V1→V2 migration functions | `src/telegram/lib/TelegramToolConfig.ts` | Task 2 |
| Ask ModelSelector export | `src/ask/index.lib.ts` | Task 3 |
| Configure with groups/channels + model picker | `src/telegram/commands/configure.ts` | Task 4 |
| TelegramContact V2 wrapper | `src/telegram/lib/TelegramContact.ts` | Task 5 |
| handler/listen V2 integration | `src/telegram/lib/handler.ts`, `listen.ts` | Task 6 |
