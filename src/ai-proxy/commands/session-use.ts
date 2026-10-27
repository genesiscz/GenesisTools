/**
 * `tools ai-proxy session <id> use [--codex <account>] [--claude <account>] [--grok <account>]`: the manual switch
 * that replaces failover for a session (P8, Martin 2026-10-25). It changes the record, and the proxy reads the record
 * on every request, so the next turn runs on the new account with no restart. Reasoning envelopes stamped by the old
 * account are dropped on that turn (the phase 6 rule). Without an agent flag it lists the session's accounts and the
 * ones it can switch to.
 */
import { loadConfig } from "@app/ai-proxy/lib/config";
import {
    agentAccounts,
    agentLogins,
    isError,
    namedAccount,
    recordFields,
    type SessionAccountChoice,
} from "@app/ai-proxy/lib/sessions/accounts";
import {
    type AiProxySessionRecord,
    readSessionRecord,
    SESSION_ACCOUNT_FIELD,
    SESSION_LOGIN_FIELD,
    type SessionAgent,
    updateSessionRecord,
    whenSessionRecordFree,
} from "@app/ai-proxy/lib/sessions/records";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

const AGENTS: SessionAgent[] = ["codex", "claude", "grok"];

export interface SessionUseOptions {
    codex?: string;
    claude?: string;
    grok?: string;
    /** Proxy accounts billed per token that this switch may use (P6). */
    allowMetered?: string[];
}

function fail(message: string): void {
    out.log.error(message);
    process.exitCode = 1;
}

/** What the record says an agent runs on: the login, else the configured proxy account. */
function currentLabel(record: AiProxySessionRecord, agent: SessionAgent): string | undefined {
    return record[SESSION_LOGIN_FIELD[agent]] ?? record[SESSION_ACCOUNT_FIELD[agent]];
}

export async function runSessionUse(id: string, options: SessionUseOptions): Promise<void> {
    const record = readSessionRecord(id);

    if (!record) {
        fail(`No session record "${id}". List them: ${toolCommand("ai-proxy sessions")}`);
        return;
    }

    const config = await loadConfig();
    const store = await AiConfigStore.readOnly();
    const requested = AGENTS.flatMap((agent) => {
        const spec = options[agent];
        return spec ? [{ agent, spec }] : [];
    });

    if (requested.length === 0) {
        out.println(`${pc.bold(`Session ${record.id}`)}${record.closedAt ? pc.dim(" (closed)") : ""}`);

        for (const agent of AGENTS) {
            const names = [
                ...agentLogins(store, agent).map((login) => login.name),
                ...agentAccounts(config.accounts, agent).map((account) => `${account.name} (proxy account)`),
            ];
            out.println(
                `  ${agent.padEnd(6)} ${currentLabel(record, agent) ?? pc.dim("none")}  ${pc.dim(`can use: ${names.join(", ") || "none"}`)}`
            );
        }

        out.println(pc.dim(`  Switch: ${toolCommand("ai-proxy session", record.id, "use", "--codex", "<account>")}`));
        return;
    }

    if (record.closedAt) {
        fail(
            `Session ${record.id} is closed. Resume it on the account you want: ${toolCommand("claude codex", "<account>", "--resume", record.id)}`
        );
        return;
    }

    const choices: Array<{ agent: SessionAgent; choice: SessionAccountChoice }> = [];

    for (const { agent, spec } of requested) {
        const choice = namedAccount(spec, agentAccounts(config.accounts, agent), agentLogins(store, agent), agent);

        if (isError(choice)) {
            fail(choice.error);
            return;
        }

        if (choice.metered && !options.allowMetered?.includes(choice.label)) {
            fail(
                `"${choice.label}" is billed per token, not a subscription. Pass --allow-metered ${choice.label} to use it.`
            );
            return;
        }

        choices.push({ agent, choice });
    }

    const at = new Date().toISOString();
    const updated = await whenSessionRecordFree(() =>
        updateSessionRecord({
            id: record.id,
            change: (draft) => {
                for (const { agent, choice } of choices) {
                    const from = currentLabel(draft, agent) ?? "none";
                    delete draft[SESSION_ACCOUNT_FIELD[agent]];
                    delete draft[SESSION_LOGIN_FIELD[agent]];
                    Object.assign(draft, recordFields(agent, choice, store));
                    draft.moves.push({ agent, from, to: choice.label, at });

                    if (choice.metered && !draft.meteredConfirmed.some((item) => item.account === choice.label)) {
                        draft.meteredConfirmed.push({ account: choice.label, confirmedAt: at, how: "flag" });
                    }
                }
            },
        })
    );

    if (!updated) {
        fail(`Session record "${record.id}" disappeared while it was being changed.`);
        return;
    }

    for (const { agent, choice } of choices) {
        const move = updated.moves.findLast((item) => item.agent === agent);
        out.log.success(`${agent} → ${choice.label} (was ${move?.from ?? "none"}). The next request uses it.`);
    }

    // The launch put its own account names into Claude Code's environment; only the status line still shows them.
    out.log.info(pc.dim("The status line keeps the launch's account names until Claude Code restarts."));
}
