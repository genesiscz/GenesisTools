import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AccountEntry, TASK_NAMES } from "@genesiscz/utils/ai/config/schema";
import * as p from "@genesiscz/utils/prompts/p";
import { secrets } from "@genesiscz/utils/security";
import pc from "picocolors";
import {
    addAccountInteractive,
    cmdAccountEdit,
    cmdAccountRm,
    cmdAccountShow,
    cmdAccountTest,
    parseUseEnv,
} from "./account";
import { cmdDefaultList, cmdDefaultSet } from "./defaults";
import { printAccountTable, printReferrerTable } from "./display";
import { cmdDoctor } from "./doctor";
import { cmdLinkLs } from "./link";
import { cmdSecretExport, cmdSecretImport, cmdSecretLs, cmdSecretRotate, cmdSecretSet } from "./secret";

/**
 * The interactive face of `tools ai config`.
 *
 * Every branch calls the same controller the CLI subcommand calls, so the two
 * surfaces cannot drift: the menu is navigation, not a second implementation.
 *
 * The Hugging Face entry is deliberate and load-bearing: two live error strings
 * (`AILocalProvider` when a gated model 401s, and `tools ai image` without a
 * token) tell users to run `tools ai config → Hugging Face token`. Renaming or
 * dropping it would break instructions the running code still prints.
 */

const BACK = "__back";

async function currentAccounts(): Promise<AccountEntry[]> {
    const store = await AiConfigStore.load();
    return store.accounts();
}

async function huggingFaceMenu(): Promise<void> {
    const config = await AIConfig.load();
    const existing = config.getHfToken();

    p.log.info(existing ? `A Hugging Face token is set (${existing.slice(0, 6)}…).` : "No Hugging Face token set.");

    const token = await p.password({
        message: "Hugging Face API token (hidden):",
        validate: (value) => (value.trim().startsWith("hf_") ? undefined : 'The token should start with "hf_"'),
    });

    await config.setHfToken(token.trim());
    p.log.success("Token saved.");
}

async function editMenu(account: AccountEntry): Promise<void> {
    const field = await p.select({
        message: `Edit ${account.name}:`,
        options: [
            { value: "toggle", label: account.enabled ? "Disable" : "Enable" },
            { value: "rename", label: "Rename", hint: "the id and every reference stay valid" },
            { value: "label", label: "Set label" },
            { value: "tags", label: "Set tags", hint: "comma-separated" },
            { value: "endpoint", label: "Set endpoint URL" },
            { value: "use-env", label: "Env fallback policy", hint: "names, or true/false" },
            { value: BACK, label: "Back" },
        ],
    });

    if (field === BACK) {
        return;
    }

    if (field === "toggle") {
        await cmdAccountEdit(account.id, account.enabled ? { disable: true } : { enable: true });
        return;
    }

    if (field === "rename") {
        const rename = await p.text({ message: "New name:", initialValue: account.name });
        await cmdAccountEdit(account.id, { rename: rename.trim() });
        return;
    }

    if (field === "label") {
        const label = await p.text({ message: "Label:", initialValue: account.label ?? "" });
        await cmdAccountEdit(account.id, { label });
        return;
    }

    if (field === "tags") {
        const tags = await p.text({ message: "Tags (comma-separated):", initialValue: (account.tags ?? []).join(",") });
        await cmdAccountEdit(account.id, {
            tag: tags
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
        });
        return;
    }

    if (field === "endpoint") {
        const endpoint = await p.text({
            message: "Endpoint URL (empty to clear):",
            initialValue: account.endpoint ?? "",
        });
        await cmdAccountEdit(account.id, { endpoint });
        return;
    }

    const useEnv = await p.text({
        message: "Allowed env variables (comma-separated), or true/false:",
        initialValue: Array.isArray(account.useEnvApiKey)
            ? account.useEnvApiKey.join(",")
            : String(account.useEnvApiKey),
    });

    // Validate before writing so a typo reports here rather than as a silent no-op.
    parseUseEnv(useEnv);
    await cmdAccountEdit(account.id, { useEnv });
}

async function removeWithConfirmation(account: AccountEntry): Promise<boolean> {
    const store = await AiConfigStore.load();
    const referrers = await store.referrers(account.id);

    if (referrers.length > 0) {
        p.log.warn(`${referrers.length} place(s) still reference ${account.name}:`);
        printReferrerTable(referrers, new Set(store.accounts().map((entry) => entry.id)));
    }

    const confirmed = await p.confirm({
        message:
            referrers.length > 0
                ? `Remove ${account.name} anyway and leave those references dangling?`
                : `Remove ${account.name} and its vault entries?`,
        initialValue: false,
        danger: true,
    });

    if (!confirmed) {
        p.log.info("Nothing removed.");
        return false;
    }

    await cmdAccountRm(account.id, { force: referrers.length > 0 });
    return true;
}

async function accountMenu(account: AccountEntry): Promise<void> {
    for (;;) {
        const action = await p.select({
            message: `${account.name} (${account.provider})`,
            options: [
                { value: "show", label: "Show" },
                { value: "edit", label: "Edit" },
                { value: "test", label: "Test", hint: "resolve the credential and bind" },
                { value: "links", label: "Links", hint: "what references it" },
                { value: "rm", label: "Remove" },
                { value: BACK, label: "Back" },
            ],
        });

        if (action === BACK) {
            return;
        }

        if (action === "show") {
            await cmdAccountShow(account.id, {});
            continue;
        }

        if (action === "edit") {
            await editMenu(account);
            const refreshed = (await AiConfigStore.load()).account(account.id);
            if (refreshed) {
                account = refreshed;
            }

            continue;
        }

        if (action === "test") {
            const live = await p.confirm({ message: "Also run the provider health probe?", initialValue: false });
            await cmdAccountTest(account.id, { live });
            continue;
        }

        if (action === "links") {
            await cmdLinkLs(account.id, {});
            continue;
        }

        if (await removeWithConfirmation(account)) {
            return;
        }
    }
}

async function accountsMenu(): Promise<void> {
    for (;;) {
        const accounts = await currentAccounts();

        if (accounts.length > 0) {
            printAccountTable(accounts);
        }

        const picked = await p.select({
            message: accounts.length > 0 ? "Pick an account:" : "No accounts yet.",
            options: [
                ...accounts.map((account) => ({
                    value: account.id,
                    label: account.name,
                    hint: `${account.provider}${account.enabled ? "" : " · disabled"}`,
                })),
                { value: "__add", label: "Add an account" },
                { value: BACK, label: "Back" },
            ],
        });

        if (picked === BACK) {
            return;
        }

        if (picked === "__add") {
            await addAccountInteractive();
            continue;
        }

        const account = accounts.find((entry) => entry.id === picked);
        if (account) {
            await accountMenu(account);
        }
    }
}

async function defaultsMenu(): Promise<void> {
    await cmdDefaultList({});

    const action = await p.select({
        message: "Defaults:",
        options: [
            { value: "set", label: "Set a task default" },
            { value: BACK, label: "Back" },
        ],
    });

    if (action === BACK) {
        return;
    }

    const task = String(
        await p.select({ message: "Task:", options: TASK_NAMES.map((name) => ({ value: name, label: name })) })
    );

    const accounts = await currentAccounts();
    const modelRef = await p.text({
        message: 'Model id, "@account/<id>", or "@account/<id>:<model>":',
        placeholder: accounts[0] ? `@account/${accounts[0].id}` : "gpt-5",
    });

    const app = await p.text({ message: "Scope to one app (empty for global):", placeholder: "youtube" });

    await cmdDefaultSet(task, modelRef.trim(), app.trim() ? { app: app.trim() } : {});
}

async function secretsMenu(): Promise<void> {
    for (;;) {
        const action = await p.select({
            message: "Secrets:",
            options: [
                { value: "ls", label: "List vault paths" },
                { value: "set", label: "Store a secret" },
                { value: "export", label: "Export (passphrase-protected)" },
                { value: "import", label: "Import an export" },
                { value: "rotate", label: "Rotate the master key" },
                { value: BACK, label: "Back" },
            ],
        });

        if (action === BACK) {
            return;
        }

        if (action === "ls") {
            await cmdSecretLs(undefined, {});
            continue;
        }

        if (action === "set") {
            const path = await p.text({ message: "Vault path:", placeholder: "ai/acc_xai/apiKey" });
            await cmdSecretSet(path.trim(), undefined, {});
            continue;
        }

        if (action === "export") {
            const target = await p.text({ message: "Write the export to:", placeholder: "./ai-vault-export.json" });
            await cmdSecretExport({ out: target.trim() });
            continue;
        }

        if (action === "import") {
            const source = await p.text({ message: "Read the export from:", placeholder: "./ai-vault-export.json" });
            await cmdSecretImport(source.trim(), {});
            continue;
        }

        await cmdSecretRotate({});
    }
}

export async function runConfigTui(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" AI configuration ")));

    for (;;) {
        const store = await AiConfigStore.load();
        const accounts = store.accounts();
        const vaultEntries = await (await secrets()).list();

        const action = await p.select({
            message: "What do you want to configure?",
            options: [
                { value: "accounts", label: "Accounts", hint: `${accounts.length} configured` },
                { value: "defaults", label: "Defaults", hint: "which model answers each task" },
                { value: "secrets", label: "Secrets", hint: `${vaultEntries.length} vault entries` },
                { value: "doctor", label: "Doctor", hint: "diagnose the whole configuration" },
                { value: "hf-token", label: "Hugging Face token", hint: "for gated local models and tools ai image" },
                { value: "quit", label: "Quit" },
            ],
        });

        if (action === "quit") {
            p.outro(pc.dim("Done."));
            return;
        }

        if (action === "accounts") {
            await accountsMenu();
            continue;
        }

        if (action === "defaults") {
            await defaultsMenu();
            continue;
        }

        if (action === "secrets") {
            await secretsMenu();
            continue;
        }

        if (action === "doctor") {
            const live = await p.confirm({ message: "Include live provider health probes?", initialValue: false });
            await cmdDoctor({ live });
            continue;
        }

        await huggingFaceMenu();
    }
}
