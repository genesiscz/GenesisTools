import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { embedLauncher } from "@app/ai/lib/embed/registry";
import { embedAccountEnvVar } from "@genesiscz/utils/ai/account-env";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { t3HostFor } from "./hosts";
import { embedAccountStatus, instanceBinaryPath, instanceEmbed, isOwnedInstanceId, type T3Instance } from "./instances";
import {
    isCheckout,
    type LauncherSpec,
    launcherFileName,
    listAccountLaunchers,
    parseLauncherAccount,
    parseLauncherCheckout,
    renderLauncher,
} from "./launchers";

const { log } = logger.scoped("t3:doctor");

export type FindingLevel = "ok" | "warn" | "err";

export interface Finding {
    level: FindingLevel;
    subject: string;
    message: string;
    /** A command that fixes it. Doctor prints it and never runs it. */
    fix: string | null;
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch (error) {
        log.debug({ path, error }, "not executable");
        return false;
    }
}

/** Checks one launcher file: present, executable, pointing at a checkout, and in the form `install` writes today. */
export function checkLauncher(input: { binDir: string; spec: LauncherSpec; installFlags: string[] }): Finding {
    const path = join(input.binDir, launcherFileName(input.spec));
    const fix = toolCommand("t3", "launchers", "install", ...input.installFlags);

    if (!existsSync(path)) {
        return { level: "err", subject: path, message: "launcher missing", fix };
    }

    if (!isExecutable(path)) {
        return { level: "err", subject: path, message: "launcher is not executable", fix };
    }

    const script = readFileSync(path, "utf8");
    const checkout = parseLauncherCheckout(script);

    if (checkout === null) {
        return { level: "warn", subject: path, message: "launcher has an older form (no `embed --` exec line)", fix };
    }

    if (!isCheckout(checkout)) {
        return { level: "err", subject: path, message: `checkout ${checkout} has no runnable tools`, fix };
    }

    if (script !== renderLauncher({ spec: input.spec, checkout })) {
        return { level: "warn", subject: path, message: "launcher differs from what install writes", fix };
    }

    return { level: "ok", subject: path, message: `runs ${checkout}/tools`, fix: null };
}

/** Every launcher in `binDir`: the env-driven one per agent and each per-account one found there. */
export function checkLaunchers(input: { binDir: string; accounts: readonly AccountEntry[] }): Finding[] {
    const findings: Finding[] = [];
    const binFlags = ["--bin-dir", input.binDir];

    for (const alias of ACCOUNT_PROVIDER_ALIASES) {
        findings.push(checkLauncher({ binDir: input.binDir, spec: { alias, account: null }, installFlags: binFlags }));

        for (const name of listAccountLaunchers(input.binDir, alias)) {
            const path = join(input.binDir, name);
            const account = isExecutable(path) ? parseLauncherAccount(readFileSync(path, "utf8"), alias) : null;

            if (account === null) {
                findings.push({ level: "warn", subject: path, message: "cannot read the account it pins", fix: null });
                continue;
            }

            const flags = [...binFlags, "--account", `${alias}:${account}`];
            findings.push(checkLauncher({ binDir: input.binDir, spec: { alias, account }, installFlags: flags }));
            const status = embedAccountStatus(
                { alias, variable: embedAccountEnvVar(alias), value: account },
                input.accounts
            );

            if (status === "missing" || status === "wrong-provider") {
                findings.push({
                    level: "err",
                    subject: path,
                    message: `account "${account}" is ${status === "missing" ? "not in" : "another provider's in"} the AI config`,
                    fix: toolCommand("ai", "config", "account", "list"),
                });
            }
        }
    }

    return findings;
}

/** Every owned instance: its driver, its launcher and its account. Instances this tool does not own are skipped. */
export async function checkInstances(input: {
    instances: Readonly<Record<string, T3Instance>>;
    accounts: readonly AccountEntry[];
    settingsFlags: string[];
}): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const [id, instance] of Object.entries(input.instances)) {
        if (!isOwnedInstanceId(id)) {
            continue;
        }

        const embed = instanceEmbed(instance);

        if (!embed) {
            findings.push({
                level: "err",
                subject: id,
                message: "no embed account variable (TOOLS_<AGENT>_EMBED_ACCOUNT) in its environment",
                fix: null,
            });
            continue;
        }

        const addFix = toolCommand(
            "t3",
            "providers",
            "add",
            embed.alias,
            "--account",
            embed.value,
            ...input.settingsFlags
        );
        const driver = (await t3HostFor(embed.alias)).driver;

        if (instance.driver !== driver) {
            findings.push({
                level: "err",
                subject: id,
                message: `driver is "${instance.driver}", ${embed.alias} needs "${driver}"`,
                fix: addFix,
            });
        }

        const binaryPath = instanceBinaryPath(instance);

        if (binaryPath === null || !existsSync(binaryPath) || !isExecutable(binaryPath)) {
            findings.push({
                level: "err",
                subject: id,
                message: `binary ${binaryPath ?? "(none)"} is missing or not executable`,
                fix: toolCommand("t3", "launchers", "install"),
            });
        }

        const status = embedAccountStatus(embed, input.accounts);

        if (status === "missing" || status === "wrong-provider" || status === "invalid") {
            findings.push({
                level: "err",
                subject: id,
                message: `embed account "${embed.value}" is ${status}`,
                fix: toolCommand("ai", "config", "account", "list"),
            });
            continue;
        }

        if (status === "proxy" && !(await embedLauncher(embed.alias)).servesProxy) {
            findings.push({
                level: "err",
                subject: id,
                message: `embed account "${embed.value}" is an ai-proxy target, which ${embed.alias}'s embed launcher refuses, so the instance never starts; remove it in T3 Code`,
                fix: toolCommand("t3", "providers", "add", embed.alias, "--account", "auto", ...input.settingsFlags),
            });
            continue;
        }

        findings.push({ level: "ok", subject: id, message: `${embed.alias} as ${embed.value} (${status})`, fix: null });
    }

    return findings;
}
