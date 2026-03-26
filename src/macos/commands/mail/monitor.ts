import { existsSync, readFileSync } from "node:fs";
import { formatResultsTable } from "@app/macos/lib/mail/format";
import { MailStorage } from "@app/macos/lib/mail/mail-storage";
import { cleanup, getAttachments, getRecipients, listMessages } from "@app/macos/lib/mail/sqlite";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import type { MailMessage } from "@app/macos/lib/mail/types";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import type { Command } from "commander";

// ─── Rule types ──────────────────────────────────────────────

export interface MonitorRule {
    name: string;
    match: {
        senderContains?: string[];
        subjectContains?: string[];
        subjectNotContains?: string[];
        isPersonal?: boolean;
        isFlagged?: boolean;
    };
}

// ─── Default rules ───────────────────────────────────────────

const DEFAULT_RULES: MonitorRule[] = [
    {
        name: "Important senders",
        match: {
            senderContains: ["Tekies", "DNAI"],
            subjectNotContains: ["newsletter", "unsubscribe"],
        },
    },
    {
        name: "Payment / invoice",
        match: {
            subjectContains: ["payment required", "payment due", "invoice", "faktura"],
        },
    },
    {
        name: "Personal email",
        match: {
            isPersonal: true,
        },
    },
    {
        name: "Flagged",
        match: {
            isFlagged: true,
        },
    },
];

// ─── Matching logic ──────────────────────────────────────────

function matchesRule(msg: MailMessage, rule: MonitorRule): boolean {
    const m = rule.match;
    const subject = msg.subject.toLowerCase();
    const sender = `${msg.senderName} ${msg.senderAddress}`.toLowerCase();

    if (m.subjectNotContains?.some((s) => subject.includes(s.toLowerCase()))) {
        return false;
    }

    if (m.isFlagged && msg.flagged) {
        return true;
    }

    if (m.isPersonal) {
        const toRecipients = (msg.recipients ?? []).filter((r) => r.type === "to");

        if (toRecipients.length === 1) {
            return true;
        }
    }

    if (m.senderContains?.length && m.senderContains.some((s) => sender.includes(s.toLowerCase()))) {
        return true;
    }

    if (m.subjectContains?.some((s) => subject.includes(s.toLowerCase()))) {
        return true;
    }

    return false;
}

function findMatchingRule(msg: MailMessage, rules: MonitorRule[]): MonitorRule | null {
    for (const rule of rules) {
        if (matchesRule(msg, rule)) {
            return rule;
        }
    }

    return null;
}

// ─── Helpers ─────────────────────────────────────────────────

function loadRules(rulesPath: string | undefined): MonitorRule[] {
    if (!rulesPath) {
        return DEFAULT_RULES;
    }

    if (!existsSync(rulesPath)) {
        throw new Error(`Rules file not found: ${rulesPath}`);
    }

    const content = readFileSync(rulesPath, "utf-8");
    return SafeJSON.parse(content) as MonitorRule[];
}

// ─── Command options ─────────────────────────────────────────

interface MonitorOptions {
    limit?: string;
    notifyTelegram?: boolean;
    rules?: string;
    dryRun?: boolean;
}

// ─── Register ────────────────────────────────────────────────

export function registerMonitorCommand(program: Command): void {
    program
        .command("monitor")
        .description("Check for new important emails since last run")
        .option("--limit <n>", "Number of recent messages to fetch", "200")
        .option("--notify-telegram", "Send a notification via sayy")
        .option("--rules <path>", "Path to custom rules JSON file")
        .option("--dry-run", "Show what would be flagged without updating seen DB")
        .action(async (options: MonitorOptions) => {
            try {
                const limit = Number.parseInt(options.limit ?? "200", 10);
                const rules = loadRules(options.rules);
                const dryRun = options.dryRun ?? false;

                const spinner = p.spinner();
                spinner.start(`Fetching latest ${limit} messages from INBOX...`);

                const rows = listMessages("INBOX", limit);

                if (rows.length === 0) {
                    spinner.stop("No messages found in INBOX.");
                    cleanup();
                    return;
                }

                // Build MailMessage objects
                const rowids = rows.map((r) => r.rowid);
                const attachmentsMap = getAttachments(rowids);
                const recipientsMap = getRecipients(rowids);
                const messages: MailMessage[] = rows.map((row) => {
                    const msg = rowToMessage(row);
                    msg.attachments = attachmentsMap.get(row.rowid) ?? [];
                    msg.recipients = recipientsMap.get(row.rowid) ?? [];
                    return msg;
                });

                // Diff against seen DB
                const mailStorage = new MailStorage();
                const store = mailStorage.openSeenStore();
                const seenRowids = store.getSeenRowids();

                const newMessages = messages.filter((m) => !seenRowids.has(m.rowid));

                if (newMessages.length === 0) {
                    spinner.stop("No new messages since last check.");
                    store.close();
                    cleanup();
                    return;
                }

                // Apply rules to new messages
                const important: Array<{ msg: MailMessage; ruleName: string }> = [];

                for (const msg of newMessages) {
                    const rule = findMatchingRule(msg, rules);

                    if (rule) {
                        important.push({ msg, ruleName: rule.name });
                    }
                }

                spinner.stop(`${newMessages.length} new message(s), ${important.length} important.`);

                if (important.length > 0) {
                    const importantMsgs = important.map((i) => i.msg);
                    console.log("");
                    console.log(formatResultsTable(importantMsgs, ["date", "from", "subject", "flagged"]));

                    console.log("");
                    for (const { msg, ruleName } of important) {
                        const from = msg.senderName || msg.senderAddress;
                        const subj = msg.subject.length > 50 ? msg.subject.slice(0, 50) + "..." : msg.subject;
                        p.log.info(`[${ruleName}] ${from}: ${subj}`);
                    }
                }

                // Notify via sayy if requested
                if (options.notifyTelegram && important.length > 0) {
                    const summary =
                        important.length === 1
                            ? `1 important email: ${important[0].msg.subject.slice(0, 40)}`
                            : `${important.length} important emails`;

                    const proc = Bun.spawn(["sayy", "0.5", summary], {
                        stdout: "inherit",
                        stderr: "inherit",
                    });
                    await proc.exited;
                }

                // Update seen DB (unless dry-run)
                if (!dryRun) {
                    const allFetchedRowids = messages.map((m) => m.rowid);
                    store.markSeen(allFetchedRowids);
                    p.log.step("Seen database updated.");
                } else {
                    p.log.warn("Dry run — seen database NOT updated.");
                }

                store.close();
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
