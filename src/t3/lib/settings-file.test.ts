import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AccountEntry, accountEntrySchema } from "@genesiscz/utils/ai/config/schema";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { removeRecursive } from "@genesiscz/utils/fs";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { makeTempDir } from "@genesiscz/utils/paths";
import { upsertFor } from "../commands/shared";
import { T3_HOSTS, t3HostFor } from "./hosts";
import { buildInstance, embedAccountStatus, type InstanceRequest, instanceIdFor, syncAccounts } from "./instances";
import { scanObject, scanRoot } from "./json-splice";
import { parseLauncherCheckout, renderLauncher, writeLauncher } from "./launchers";
import { planUpserts, SettingsChangedError, upsertInstances } from "./settings-file";

// Modelled on a real T3 Code settings.json: two-space indent, a trailing newline, an integer-like key, a number
// spelled `2.50` (which JSON.stringify would respell), and keys T3 Code may add later.
const FIXTURE = `{
  "favorites": [
    {
      "provider": "grok",
      "model": "grok-4"
    }
  ],
  "defaultModelSelection": {
    "instanceId": "claudeAgent",
    "model": "claude-sonnet",
    "options": []
  },
  "futureKey": {
    "10": "ten",
    "2": "two",
    "ratio": 2.50
  },
  "providerInstances": {
    "cursor": {
      "driver": "cursor",
      "enabled": true,
      "config": {
        "binaryPath": "agent"
      }
    },
    "claudeAgent": {
      "driver": "claudeAgent",
      "enabled": true,
      "config": {
        "binaryPath": "/opt/bin/claude-tools",
        "homePath": "",
        "customModels": [],
        "launchArgs": ""
      }
    },
    "codex": {
      "driver": "codex",
      "displayName": "Codex Main"
    }
  },
  "cursorKeychainUsageEnabled": true
}
`;

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        removeRecursive(dir);
    }
});

function sandbox(text = FIXTURE): { dir: string; settingsPath: string; backupDir: string } {
    const dir = makeTempDir("t3-settings-");
    tempDirs.push(dir);
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, text);

    return { dir, settingsPath, backupDir: join(dir, "backups") };
}

function request(overrides: Partial<InstanceRequest> = {}): InstanceRequest {
    return {
        alias: "claude",
        account: "work",
        host: T3_HOSTS["claude-stream-json"],
        binaryPath: "/opt/bin/claude-tools",
        ...overrides,
    };
}

/** The text with one `providerInstances` member removed, separator included. */
function withoutInstance(text: string, id: string): string {
    const root = scanRoot(text);
    const instances = root.members.find((member) => member.key === "providerInstances");

    if (!instances) {
        throw new Error("no providerInstances");
    }

    const members = scanObject(text, instances.valueStart).members;
    const index = members.findIndex((member) => member.key === id);
    const target = members[index];
    const previous = members[index - 1];

    return text.slice(0, previous.valueEnd) + text.slice(target.valueEnd);
}

function parse(text: string): Record<string, unknown> {
    return SafeJSON.parse(text, { strict: true });
}

describe("upsertInstances", () => {
    it("adds one instance and leaves every other byte identical", async () => {
        const { settingsPath, backupDir } = sandbox();
        const result = await upsertInstances({ settingsPath, backupDir, upserts: [upsertFor(request())] });
        const after = readFileSync(settingsPath, "utf8");

        expect(result.status).toBe("written");
        expect(result.changed).toEqual(["gt-claude-work"]);
        expect(withoutInstance(after, "gt-claude-work")).toBe(FIXTURE);
        expect(after).toContain('"ratio": 2.50');

        const instance = (parse(after).providerInstances as Record<string, unknown>)["gt-claude-work"];
        expect(instance).toEqual({
            driver: "claudeAgent",
            displayName: "Claude Code (work)",
            enabled: true,
            environment: [{ name: "TOOLS_CLAUDE_EMBED_ACCOUNT", value: "work", sensitive: false }],
            config: { binaryPath: "/opt/bin/claude-tools" },
        });
        expect(after).toContain('\n    "gt-claude-work": {\n      "driver": "claudeAgent",');
    });

    it("writes a backup of the bytes it replaced", async () => {
        const { settingsPath, backupDir } = sandbox();
        const result = await upsertInstances({
            settingsPath,
            backupDir,
            upserts: [upsertFor(request())],
            now: () => new Date("2026-11-01T10:00:00Z"),
        });

        expect(result.backupPath).toBe(join(backupDir, "settings-2026-11-01T10-00-00-000Z.json"));
        expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(FIXTURE);
    });

    it("is a no-op the second time, with no write and no backup", async () => {
        const { settingsPath, backupDir } = sandbox();
        await upsertInstances({ settingsPath, backupDir, upserts: [upsertFor(request())] });
        const first = readFileSync(settingsPath, "utf8");
        const mtime = statSync(settingsPath).mtimeMs;
        const second = await upsertInstances({ settingsPath, backupDir, upserts: [upsertFor(request())] });

        expect(second.status).toBe("unchanged");
        expect(readFileSync(settingsPath, "utf8")).toBe(first);
        expect(statSync(settingsPath).mtimeMs).toBe(mtime);
        expect(readdirSync(backupDir)).toHaveLength(1);
    });

    it("never touches the claudeAgent instance or another instance", async () => {
        const { settingsPath, backupDir } = sandbox();
        await upsertInstances({
            settingsPath,
            backupDir,
            upserts: [upsertFor(request()), upsertFor(request({ account: "auto", steer: "next" }))],
        });
        const before = parse(FIXTURE).providerInstances as Record<string, unknown>;
        const after = parse(readFileSync(settingsPath, "utf8")).providerInstances as Record<string, unknown>;

        expect(Object.keys(after)).toEqual(["cursor", "claudeAgent", "codex", "gt-claude-work", "gt-claude-auto"]);

        for (const id of ["cursor", "claudeAgent", "codex"]) {
            expect(after[id]).toEqual(before[id]);
        }
    });

    it("re-merges once when the file changed after the read, keeping the other writer's change", async () => {
        const { settingsPath, backupDir } = sandbox();
        const concurrent = FIXTURE.replace('"cursorKeychainUsageEnabled": true', '"cursorKeychainUsageEnabled": false');
        const result = await upsertInstances({
            settingsPath,
            backupDir,
            upserts: [upsertFor(request())],
            beforeCommit: (attempt) => {
                if (attempt === 0) {
                    writeFileSync(settingsPath, concurrent);
                }
            },
        });
        const after = readFileSync(settingsPath, "utf8");

        expect(result.status).toBe("written");
        expect(withoutInstance(after, "gt-claude-work")).toBe(concurrent);
    });

    it("refuses when the file changes again during the re-merge, and writes nothing", async () => {
        const { settingsPath, backupDir } = sandbox();
        let edits = 0;
        const write = upsertInstances({
            settingsPath,
            backupDir,
            upserts: [upsertFor(request())],
            beforeCommit: () => {
                edits++;
                writeFileSync(settingsPath, FIXTURE.replace('"ratio": 2.50', `"ratio": ${edits}`));
            },
        });

        await expect(write).rejects.toBeInstanceOf(SettingsChangedError);
        expect(readFileSync(settingsPath, "utf8")).not.toContain("gt-claude-work");
        expect(existsSync(backupDir)).toBe(false);
    });

    it("refuses an id outside the gt- prefix", () => {
        expect(() => planUpserts(FIXTURE, [{ id: "claudeAgent", build: () => ({ driver: "claudeAgent" }) }])).toThrow(
            /owns only ids starting with "gt-"/
        );
    });

    it("adds providerInstances at the end of the root when the file has none", () => {
        const text = '{\n\t"compactIdleThreads": true\n}\n';
        const plan = planUpserts(text, [upsertFor(request())]);

        expect(
            plan.text.startsWith('{\n\t"compactIdleThreads": true,\n\t"providerInstances": {\n\t\t"gt-claude-work": {')
        ).toBe(true);
        expect(parse(plan.text).compactIdleThreads).toBe(true);
    });
});

describe("buildInstance", () => {
    it("keeps keys, variables and config values it does not own, and steer off removes the steer variable", () => {
        const existing = {
            driver: "claudeAgent",
            displayName: "Renamed in T3",
            accentColor: "#ff0000",
            enabled: false,
            environment: [
                { name: "OTHER", value: "1", sensitive: false },
                { name: "TOOLS_CLAUDE_EMBED_ACCOUNT", value: "old", sensitive: false },
                { name: "TOOLS_CLAUDE_EMBED_STEER", value: "next", sensitive: false },
            ],
            config: { binaryPath: "/old", customModels: ["m"] },
        };
        const built = buildInstance(existing, request({ steer: "off" }));

        expect(built).toEqual({
            driver: "claudeAgent",
            displayName: "Renamed in T3",
            accentColor: "#ff0000",
            enabled: false,
            environment: [
                { name: "OTHER", value: "1", sensitive: false },
                { name: "TOOLS_CLAUDE_EMBED_ACCOUNT", value: "work", sensitive: false },
            ],
            config: { binaryPath: "/opt/bin/claude-tools", customModels: ["m"] },
        });
    });
});

describe("instance ids, drivers and accounts", () => {
    it("slugs the account into a T3 instance id", () => {
        expect(instanceIdFor("claude", "work")).toBe("gt-claude-work");
        expect(instanceIdFor("codex", "proxy:work/openai")).toBe("gt-codex-proxy-work-openai");
        expect(instanceIdFor("grok", "Work Laptop!")).toBe("gt-grok-work-laptop");
        expect(instanceIdFor("claude", "x".repeat(80))).toHaveLength(64);
    });

    it("maps every agent to the T3 Code driver of its host protocol", async () => {
        const drivers = await Promise.all(
            ACCOUNT_PROVIDER_ALIASES.map(async (alias) => (await t3HostFor(alias)).driver)
        );

        expect(drivers).toEqual(["claudeAgent", "codex", "grok"]);
    });

    it("checks an embed account against the AI config under the agent's provider", async () => {
        const account = (fields: Record<string, unknown>): AccountEntry =>
            accountEntrySchema.parse({ enabled: true, billing: { mode: "subscription" }, credentials: {}, ...fields });
        const accounts = [
            account({ id: "acc_work", name: "work", provider: "anthropic-sub", credentials: { longLivedToken: "x" } }),
            account({ id: "acc_personal", name: "personal", provider: "openai-sub" }),
            account({ id: "acc_gate", name: "gate", provider: "openai-sub", tags: ["gate-only"] }),
            account({ id: "acc_short", name: "short", provider: "anthropic-sub" }),
        ];
        const embed = (alias: HarnessId, value: string) => ({ alias, variable: "", value });

        expect(embedAccountStatus(embed("claude", "work"), accounts)).toBe("exists");
        expect(embedAccountStatus(embed("claude", "personal"), accounts)).toBe("wrong-provider");
        expect(embedAccountStatus(embed("codex", "nobody"), accounts)).toBe("missing");
        expect(embedAccountStatus(embed("codex", "auto"), accounts)).toBe("auto");
        expect(embedAccountStatus(embed("codex", "proxy:"), accounts)).toBe("invalid");
        expect((await syncAccounts(accounts)).map(({ alias, account }) => `${alias}:${account.name}`)).toEqual([
            "claude:work",
            "codex:personal",
        ]);
    });
});

describe("launchers", () => {
    it("renders the env-driven and the per-account launcher and reads the checkout back", () => {
        const plain = renderLauncher({ spec: { alias: "codex", account: null }, checkout: "/opt/GenesisTools" });
        const pinned = renderLauncher({
            spec: { alias: "claude", account: "it's work" },
            checkout: "/opt/Genesis Tools",
        });

        expect(plain).toBe(
            "#!/bin/zsh\n" +
                "# codex for apps that embed it (T3 Code). Written by tools t3 launchers install; rewrite it with that command.\n" +
                'export PATH="$HOME/.bun/bin:$PATH"\n' +
                "exec '/opt/GenesisTools/tools' codex embed -- \"$@\"\n"
        );
        expect(pinned).toContain("export TOOLS_CLAUDE_EMBED_ACCOUNT='it'\\''s work'\n");
        expect(parseLauncherCheckout(pinned)).toBe("/opt/Genesis Tools");
        expect(parseLauncherCheckout("#!/bin/zsh\nexec tools claude run --sdk\n")).toBeNull();
    });

    it("writes mode 755 and is a no-op for the same content", () => {
        const binDir = makeTempDir("t3-bin-");
        tempDirs.push(binDir);
        const spec = { alias: "claude" as const, account: "work" };
        const first = writeLauncher({ binDir, spec, checkout: "/opt/GenesisTools" });
        const second = writeLauncher({ binDir, spec, checkout: "/opt/GenesisTools" });
        const moved = writeLauncher({ binDir, spec, checkout: "/opt/Other" });

        expect(first.path).toBe(join(binDir, "claude-tools@work"));
        expect(statSync(first.path).mode & 0o777).toBe(0o755);
        expect([first.status, second.status, moved.status]).toEqual(["created", "unchanged", "updated"]);
    });
});
