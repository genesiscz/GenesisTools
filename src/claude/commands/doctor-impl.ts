import {
    accountOwningKeychain,
    billsKeychain,
    type Diagnosis,
    diagnoseGroup,
    fallbackSuffix,
    groupSessions,
    PROBLEM_TEXT,
    parsePinnedProcesses,
    resolveKeychainIdentity,
    UNCERTAINTY_TEXT,
} from "@app/claude/lib/doctor";
import { peekSharedUsage } from "@app/claude/lib/usage/shared-cache";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import {
    type FingerprintResult,
    findDuplicateAccounts,
    fingerprintToken,
} from "@genesiscz/utils/claude/account-fingerprint";
import {
    type ClaudeAiOauthCredentials,
    keychainOwnerUuidOffline,
    readKeychainPayload,
    resolveKeychainAccountUuid,
} from "@genesiscz/utils/claude/keychain";
import { probeLongLivedToken, type TokenVerdict } from "@genesiscz/utils/claude/token-verify";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger, out } from "@genesiscz/utils/logger";
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
        const suffix = fallbackSuffix(problem, keychainLabel);
        out.printlnErr(`    ${billsKeychain([problem]) ? pc.red(text) : pc.yellow(text)}${pc.dim(suffix)}`);
    }

    for (const uncertainty of unverified) {
        out.printlnErr(`    ${pc.yellow(UNCERTAINTY_TEXT[uncertainty])}`);
    }
}

/**
 * `--identity`: prove which ACCOUNT each stored token really bills.
 *
 * Every other check in this file trusts the label, which is why the 2026-08-26
 * wrong-account incident was invisible to it: a token captured in a browser
 * logged into another account is labelled correctly everywhere and bills
 * someone else. Only the server can settle it, and it costs one 1-token
 * completion per account — hence opt-in.
 */
async function reportIdentities(accounts: AIAccountEntry[]): Promise<number> {
    const withToken = accounts.filter((a) => a.tokens.longLivedToken);

    if (withToken.length === 0) {
        out.printlnErr(pc.dim("\nIdentity: no accounts have a long-lived token to probe."));
        return 0;
    }

    out.printlnErr(pc.dim(`\nIdentity: probing ${withToken.length} token(s) with one 1-token completion each...`));

    const results: FingerprintResult[] = await Promise.all(
        withToken.map((account) => fingerprintToken(account.name, account.tokens.longLivedToken!))
    );

    for (const result of results.sort((a, b) => a.account.localeCompare(b.account))) {
        if (!result.fingerprint) {
            out.printlnErr(`  ${pc.yellow("?")} ${result.account} ${pc.dim(`— not verified: ${result.error}`)}`);
            continue;
        }

        const { fiveHourReset, sevenDayReset, fiveHourUtilization } = result.fingerprint;
        const when = fiveHourReset ? new Date(Number(fiveHourReset) * 1000).toLocaleTimeString() : "?";
        const weekly = sevenDayReset ? new Date(Number(sevenDayReset) * 1000).toLocaleDateString() : "?";
        out.printlnErr(
            `  ${pc.green("✔")} ${result.account} ${pc.dim(`5h resets ${when} · 7d resets ${weekly} · 5h used ${fiveHourUtilization ?? "?"}`)}`
        );
    }

    const duplicates = findDuplicateAccounts(results);

    if (duplicates.length === 0) {
        out.printlnErr(pc.green("  No duplicates: every probed token bills a distinct account."));
        return 0;
    }

    for (const group of duplicates) {
        out.printlnErr(pc.red(`  ✖ ${group.accounts.join(" and ")} share one account — same 5h/7d window anchors.`));
        out.printlnErr(
            pc.dim(
                `    A login-long capture completed in a browser signed into the other account. ` +
                    `Recapture with: tools claude login-long <name>`
            )
        );
    }

    return duplicates.length;
}

/**
 * `doctor` — scan running pinned sessions for the silent-fallback failure
 * modes: expired/stale tokens (401 → keychain) and exhausted Fable/weekly
 * buckets (429 → keychain). One 1-token probe per distinct token.
 *
 * 🛑 Read-only by contract: the usage cache is read with `peekSharedUsage`
 * (never a fetch that could rotate a token), and no config is written. The
 * `--identity` pass is the one exception, and it must be asked for.
 */
export async function doctorCommand(opts: { identity?: boolean } = {}): Promise<void> {
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

    // An unmanaged login still absorbs fallbacks — attribute by UUID then.
    const keychainLabel = accountOwningKeychain(accounts, keychainUuid) ?? keychainUuid;
    out.printlnErr(
        pc.dim(
            keychainLabel
                ? `Keychain (absorbs silent fallbacks): ${keychainLabel}`
                : "Keychain: no login — a failing pin has nothing to fall back on, so those turns just fail"
        )
    );

    const groups = groupSessions(parsePinnedProcesses(pinnedProcessesFromPs()));

    if (groups.length === 0) {
        out.printlnErr("No running pinned sessions found.");

        // The identity pass is about the CONFIG, not about running sessions, so
        // "nothing is running" must not skip it.
        if (opts.identity) {
            await reportIdentities(accounts);
        }

        return;
    }

    // One READ-ONLY probe per distinct token. Deliberately not the inference-based
    // verifier: a diagnostic must not spend quota or move the limit state it reports on.
    const verdicts = new Map<string, TokenVerdict>();
    await Promise.all(
        [...new Set(groups.map((g) => g.token))].map(async (token) => {
            verdicts.set(token, await probeLongLivedToken(token));
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
    } else if (sick === 0) {
        out.printlnErr(
            pc.yellow(
                `\nNo problems found, but ${inconclusive} session group${inconclusive === 1 ? "" : "s"} could not be fully verified.`
            )
        );
    } else {
        out.printlnErr(
            pc.dim(
                "\nFix: expired/stale token → relaunch with `tools cc run <name>`. " +
                    "Fable bucket dead → relaunch via `tools cc fable` (or `/model claude-opus-5` in the session — " +
                    "note doctor reads the LAUNCH model, so the flag clears only on relaunch)."
            )
        );
    }

    // "Billing the account they claim" above is a claim about the PIN, not about
    // the token's real owner — say so unless the identity pass actually ran.
    if (opts.identity) {
        await reportIdentities(accounts);
    } else {
        out.printlnErr(
            pc.dim(
                "\nNote: this checked the pin, not which account each token really bills. " +
                    "Verify that with `tools claude doctor --identity` (spends 1 token per account)."
            )
        );
    }
}
