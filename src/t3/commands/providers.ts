import { existsSync } from "node:fs";
import { parseEmbedAccountRequest } from "@genesiscz/utils/ai/account-env";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessPluginId } from "@genesiscz/utils/ai/providers/harness-index";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import { checkInstances, checkLaunchers, type Finding } from "../lib/doctor";
import { type T3HostSpec, t3HostFor } from "../lib/hosts";
import { type EmbedAccountStatus, instanceIdFor, instanceRows, syncAccounts } from "../lib/instances";
import { launcherPath } from "../lib/launchers";
import { planUpserts, providerInstances, readSettings, type UpsertResult, upsertInstances } from "../lib/settings-file";
import {
    isSteerMode,
    loadAccounts,
    type PathFlags,
    parseAlias,
    pathFlagsOf,
    resolvePaths,
    STEER_MODES,
    type SteerMode,
    upsertFor,
} from "./shared";

const { log } = logger.scoped("t3:providers");

const STATUS_KIND: Record<EmbedAccountStatus, "ok" | "warn" | "err" | "dim"> = {
    exists: "ok",
    auto: "ok",
    proxy: "dim",
    none: "dim",
    missing: "err",
    "wrong-provider": "err",
    invalid: "err",
};

function renderWrite(result: UpsertResult, json: boolean | undefined): void {
    if (json) {
        out.result(result);
        return;
    }

    if (result.status === "unchanged") {
        out.log.info(`Nothing to change in ${result.settingsPath}.`);
        return;
    }

    out.log.success(`Wrote ${result.changed.join(", ")} into ${result.settingsPath}.`);
    out.log.info(`Backup: ${result.backupPath}`);
}

// ─── list ───────────────────────────────────────────────────────────────────

export async function providersListCommand(options: PathFlags & { json?: boolean }): Promise<void> {
    const { settingsPath } = resolvePaths(options);
    const snapshot = readSettings(settingsPath);
    const rows = instanceRows(providerInstances(snapshot.data), await loadAccounts());

    if (options.json) {
        out.result({ settingsPath: snapshot.path, instances: rows });
        return;
    }

    const table = createBoxTable(["ID", "DRIVER", "NAME", "BINARY", "EMBED ACCOUNT", "IN AI CONFIG"]);

    for (const row of rows) {
        table.push([
            row.owned ? row.id : `${row.id} (not ours)`,
            row.driver,
            truncateDisplay(row.displayName, 24),
            truncateDisplay(row.binaryPath, 48),
            truncateDisplay(row.embedAccount, 28),
            formatDotStatus(STATUS_KIND[row.accountStatus], row.accountStatus),
        ]);
    }

    out.println(table.toString());
    out.println(
        `  ${rows.length} instances in ${snapshot.path} · ${rows.filter((row) => row.owned).length} owned (gt-)`
    );
}

// ─── add ────────────────────────────────────────────────────────────────────

export interface ProvidersAddOptions extends PathFlags {
    account?: string;
    displayName?: string;
    steer?: string | true;
    json?: boolean;
}

function accountsFor(alias: HarnessId, accounts: readonly AccountEntry[]): AccountEntry[] {
    const provider = harnessPluginId(alias);

    return accounts.filter((account) => account.enabled && account.provider === provider);
}

async function resolveAccountValue(
    alias: HarnessId,
    options: ProvidersAddOptions,
    accounts: readonly AccountEntry[]
): Promise<string | null> {
    if (options.account) {
        return options.account.trim();
    }

    const names = accountsFor(alias, accounts).map((account) => account.name);

    if (!isInteractive()) {
        out.error(`--account is required: ${["auto", ...names].join(", ")}, or proxy:<account>/<provider>.`);
        out.println(suggestCommand(toolCommand("t3"), { add: ["--account", names[0] ?? "auto"] }));
        return null;
    }

    const picked = await p.select({
        message: `Which ${alias} account should this T3 Code instance run as?`,
        options: [
            { value: "auto", label: "auto", hint: "the automatic pick" },
            ...names.map((name) => ({ value: name, label: name })),
        ],
    });

    return typeof picked === "string" ? picked : null;
}

async function resolveSteer(
    alias: HarnessId,
    host: T3HostSpec,
    value: string | true | undefined
): Promise<SteerMode | undefined | null> {
    if (value === undefined) {
        return undefined;
    }

    if (host.steer === null) {
        out.error(`--steer works only for an agent whose embed launcher reads a steer variable; ${alias} reads none.`);
        return null;
    }

    if (value !== true && isSteerMode(value)) {
        return value;
    }

    if (value === true && isInteractive()) {
        const picked = await p.select({
            message: "Steer mode",
            options: STEER_MODES.map((mode) => ({ value: mode, label: mode })),
        });

        return typeof picked === "string" && isSteerMode(picked) ? picked : null;
    }

    out.error(
        suggestEnumFlag(toolCommand("t3"), "--steer", STEER_MODES, {
            given: value === true ? undefined : value,
        })
    );

    return null;
}

/** Refuses an account name the AI config does not hold for this agent's provider. */
function checkNamedAccount(alias: HarnessId, value: string, accounts: readonly AccountEntry[]): boolean {
    const request = parseEmbedAccountRequest(value);

    if (request.kind !== "account") {
        return true;
    }

    const candidates = accountsFor(alias, accounts);

    if (candidates.some((account) => account.name === request.name || account.id === request.name)) {
        return true;
    }

    out.error(
        `No enabled ${harnessPluginId(alias)} account "${request.name}". Known: ${
            candidates.map((account) => account.name).join(", ") || "(none)"
        }, or auto, or proxy:<account>/<provider>.`
    );

    return false;
}

export async function providersAddCommand(aliasArg: string, options: ProvidersAddOptions): Promise<void> {
    const alias = parseAlias(aliasArg);

    if (!alias) {
        out.error(`Unknown agent "${aliasArg}". Possible: ${ACCOUNT_PROVIDER_ALIASES.join(", ")}.`);
        process.exitCode = 1;
        return;
    }

    const paths = resolvePaths(options);
    const accounts = await loadAccounts();
    const account = await resolveAccountValue(alias, options, accounts);
    const host = await t3HostFor(alias);
    const steer = await resolveSteer(alias, host, options.steer);

    if (account === null || steer === null || !checkNamedAccount(alias, account, accounts)) {
        process.exitCode = 1;
        return;
    }

    const binaryPath = launcherPath(paths.binDir, { alias, account: null });

    if (!existsSync(binaryPath)) {
        out.log.warn(
            `${binaryPath} does not exist yet. Write it: ${toolCommand("t3", "launchers", "install", ...pathFlagsOf(options))}`
        );
    }

    const upsert = upsertFor({
        alias,
        account,
        host,
        binaryPath,
        displayName: options.displayName,
        steer,
    });
    log.debug({ id: upsert.id, alias, settingsPath: paths.settingsPath }, "add instance");
    const result = await upsertInstances({
        settingsPath: paths.settingsPath,
        backupDir: paths.backupDir,
        upserts: [upsert],
    });

    renderWrite(result, options.json);
}

// ─── sync ───────────────────────────────────────────────────────────────────

export interface ProvidersSyncOptions extends PathFlags {
    yes?: boolean;
    json?: boolean;
}

export async function providersSyncCommand(options: ProvidersSyncOptions): Promise<void> {
    const paths = resolvePaths(options);
    const targets = await syncAccounts(await loadAccounts());
    const upserts = targets.map(({ alias, account, host }) =>
        upsertFor({
            alias,
            account: account.name,
            host,
            binaryPath: launcherPath(paths.binDir, { alias, account: null }),
        })
    );
    const snapshot = readSettings(paths.settingsPath);
    const existing = providerInstances(snapshot.data);
    const plan = planUpserts(snapshot.text, upserts);

    if (!options.json) {
        const table = createBoxTable(["INSTANCE", "AGENT", "ACCOUNT", "ACTION"]);

        for (const { alias, account } of targets) {
            const id = instanceIdFor(alias, account.name);
            const action = !plan.changed.includes(id) ? "unchanged" : id in existing ? "update" : "create";
            table.push([id, alias, account.name, formatDotStatus(action === "unchanged" ? "dim" : "ok", action)]);
        }

        out.println(table.toString());
    }

    if (plan.changed.length === 0) {
        renderWrite({ status: "unchanged", changed: [], settingsPath: snapshot.path, backupPath: null }, options.json);
        return;
    }

    if (!options.yes) {
        if (!isInteractive()) {
            out.error(`sync writes ${plan.changed.length} instances into ${snapshot.path}; pass --yes to confirm.`);
            out.println(suggestCommand(toolCommand("t3"), { add: ["--yes"] }));
            process.exitCode = 1;
            return;
        }

        const ok = await p.confirm({
            message: `Write ${plan.changed.length} instances into ${snapshot.path}?`,
            initialValue: true,
        });

        if (ok !== true) {
            out.log.info("Nothing written.");
            return;
        }
    }

    const result = await upsertInstances({
        settingsPath: paths.settingsPath,
        backupDir: paths.backupDir,
        upserts,
    });

    renderWrite(result, options.json);
}

// ─── doctor ─────────────────────────────────────────────────────────────────

const LEVEL_LABEL: Record<Finding["level"], string> = { ok: "ok", warn: "warn", err: "fail" };

export async function providersDoctorCommand(options: PathFlags & { json?: boolean }): Promise<void> {
    const paths = resolvePaths(options);
    const accounts = await loadAccounts();
    const findings: Finding[] = checkLaunchers({ binDir: paths.binDir, accounts });

    try {
        const snapshot = readSettings(paths.settingsPath);
        findings.push(
            ...(await checkInstances({
                instances: providerInstances(snapshot.data),
                accounts,
                settingsFlags: pathFlagsOf(options),
            }))
        );
    } catch (error) {
        log.debug({ error, settingsPath: paths.settingsPath }, "settings unreadable");
        findings.push({
            level: "err",
            subject: paths.settingsPath,
            message: error instanceof Error ? error.message : String(error),
            fix: null,
        });
    }

    if (findings.some((finding) => finding.level === "err")) {
        process.exitCode = 1;
    }

    if (options.json) {
        out.result({ findings });
        return;
    }

    const table = createBoxTable(["CHECK", "SUBJECT", "DETAIL"]);

    for (const finding of findings) {
        table.push([formatDotStatus(finding.level, LEVEL_LABEL[finding.level]), finding.subject, finding.message]);
    }

    out.println(table.toString());
    const fixes = [...new Set(findings.flatMap((finding) => (finding.fix ? [finding.fix] : [])))];

    if (fixes.length > 0) {
        out.println("  Fix:");

        for (const fix of fixes) {
            out.println(`    ${fix}`);
        }
    }
}
