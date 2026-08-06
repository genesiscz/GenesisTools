import {
    billsKeychain,
    type Diagnosis,
    diagnoseGroup,
    groupSessions,
    parsePinnedProcesses,
    PROBLEM_TEXT,
    resolveKeychainIdentity,
    UNCERTAINTY_TEXT,
} from "@app/claude/lib/doctor";
import { peekSharedUsage } from "@app/claude/lib/usage/shared-cache";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import {
    type ClaudeAiOauthCredentials,
    keychainOwnerUuidOffline,
    readKeychainPayload,
    resolveKeychainAccountUuid,
} from "@genesiscz/utils/claude/keychain";
import { type TokenVerdict, verifyLongLivedToken } from "@genesiscz/utils/claude/token-verify";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

function pinnedProcessesFromPs(): string {
    const pgrep = Bun.spawnSync(["pgrep", "-f", "claude"]);
    const pids = new TextDecoder().decode(pgrep.stdout).split("\n").filter(Boolean);

    if (pids.length === 0) {
        return "";
    }

    // `eww` appends each process's env after its argv, which is where the pin lives.
    const ps = Bun.spawnSync(["ps", "eww", "-o", "pid=,tty=,command=", "-p", pids.join(",")]);
    return new TextDecoder().decode(ps.stdout);
}

function describeGroup(diag: Diagnosis, keychainLabel: string | undefined): void {
    const { group, problems, unverified } = diag;
    const sessions = group.processes.filter((p) => !p.isAgent);
    const agents = group.processes.length - sessions.length;
    const where = sessions
        .slice(0, 4)
        .map((p) => `pid ${p.pid}${p.tty !== "??" ? ` (${p.tty})` : ""}`)
        .join(", ");
    const models = [...new Set(group.processes.map((p) => p.model).filter(Boolean))].join(", ");

    const head =
        `${pc.bold(group.account)} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}` +
        (agents ? ` + ${agents} agents` : "") +
        (models ? ` · ${models}` : "") +
        (where ? ` · ${where}` : "");

    if (problems.length === 0 && unverified.length === 0) {
        out.printlnErr(`${pc.green("✔")} ${head}`);
        return;
    }

    const mark = billsKeychain(problems) ? pc.red("✖") : pc.yellow(problems.length ? "⚠" : "?");
    out.printlnErr(`${mark} ${head}`);

    for (const problem of problems) {
        const text = PROBLEM_TEXT[problem];
        const suffix = billsKeychain([problem]) && keychainLabel ? ` → billing ${pc.bold(keychainLabel)}` : "";
        out.printlnErr(`    ${billsKeychain([problem]) ? pc.red(text) : pc.yellow(text)}${suffix}`);
    }

    for (const uncertainty of unverified) {
        out.printlnErr(`    ${pc.yellow(UNCERTAINTY_TEXT[uncertainty])}`);
    }
}

/**
 * `doctor` — scan running pinned sessions for the silent-fallback failure
 * modes: expired/stale tokens (401 → keychain) and exhausted Fable/weekly
 * buckets (429 → keychain). One 1-token probe per distinct token.
 *
 * 🛑 Read-only by contract: the usage cache is read with `peekSharedUsage`
 * (never a fetch that could rotate a token), and no config is written.
 */
export async function doctorCommand(): Promise<void> {
    const config = await AIConfig.load();
    const accounts = config.getAccountsByProvider("anthropic-sub");
    const cached = await peekSharedUsage().catch((error) => {
        logger.debug({ error }, "[doctor] usage cache unreadable");
        return null;
    });

    const keychainUuid = await resolveKeychainIdentity({
        readPayload: readKeychainPayload,
        resolveUuid: (oauth) => resolveKeychainAccountUuid(oauth as ClaudeAiOauthCredentials),
        offlineUuid: keychainOwnerUuidOffline,
        onDegrade: (err) => logger.debug({ err }, "[doctor] authoritative keychain lookup failed, using the marker"),
    });

    const keychainName = accounts.find((a) => a.secondary?.accountUuid === keychainUuid)?.name;
    // An unmanaged login still absorbs fallbacks — attribute by UUID then.
    const keychainLabel = keychainName ?? keychainUuid;
    out.printlnErr(pc.dim(`Keychain (absorbs silent fallbacks): ${keychainLabel ?? "unknown / unmanaged"}`));

    const groups = groupSessions(parsePinnedProcesses(pinnedProcessesFromPs()));

    if (groups.length === 0) {
        out.printlnErr("No running pinned sessions found.");
        return;
    }

    // One live probe per DISTINCT token (1 haiku token each).
    const verdicts = new Map<string, TokenVerdict>();
    await Promise.all(
        [...new Set(groups.map((g) => g.token))].map(async (token) => {
            verdicts.set(token, await verifyLongLivedToken(token));
        })
    );

    let sick = 0;
    let inconclusive = 0;

    for (const group of groups.sort((a, b) => a.account.localeCompare(b.account))) {
        const diag = diagnoseGroup(group, accounts, cached, verdicts.get(group.token) ?? "unreachable");

        if (diag.problems.length > 0) {
            sick++;
        } else if (diag.unverified.length > 0) {
            inconclusive++;
        }

        describeGroup(diag, keychainLabel);
    }

    if (sick === 0 && inconclusive === 0) {
        out.printlnErr(pc.green("\nAll pinned sessions are billing the account they claim."));
        return;
    }

    if (sick === 0) {
        out.printlnErr(
            pc.yellow(
                `\nNo problems found, but ${inconclusive} session group${inconclusive === 1 ? "" : "s"} could not be fully verified.`
            )
        );
        return;
    }

    out.printlnErr(
        pc.dim(
            "\nFix: expired/stale token → relaunch with `tools cc run <name>`. " +
                "Fable bucket dead → relaunch via `tools cc fable` (or `/model claude-opus-5` in the session — " +
                "note doctor reads the LAUNCH model, so the flag clears only on relaunch)."
        )
    );
}

export function registerDoctorCommand(program: Command): void {
    program
        .command("doctor")
        .description("Find running pinned sessions that silently bill the keychain account instead of their pin")
        .action(async () => {
            await doctorCommand();
        });
}
