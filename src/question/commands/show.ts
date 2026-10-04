import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { formatRecheck, recheck, type TransclusionToken } from "@genesiscz/utils/transclude";
import type { Command } from "commander";
import pc from "picocolors";
import { isDecisionId } from "../lib/decisions/items";
import { decisionFiles, decisionsMarkdown } from "../lib/decisions/read";
import type { StoredTransclusion } from "../lib/decisions/schema";
import { type DecisionRecord, type DecisionVersion, readDecisions, withoutVersioned } from "../lib/decisions/store";
import { questionTokenRegistry } from "../lib/transclude";

/** A re-check must not grow the real asset store, so a re-resolved image goes to a scratch folder. */
const PREVIEW_ASSET_DIR = join(tmpdir(), "genesis-question-tokens-preview");

function text(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** A stored token row as the engine's token shape; the store keeps them as loose JSON. */
function storedToken(stored: StoredTransclusion): TransclusionToken {
    const optional = {
        capturedAt: text(stored.capturedAt),
        cwd: text(stored.cwd),
        signature: text(stored.signature),
        snapshot: text(stored.snapshot),
    };

    return {
        raw: stored.raw,
        kind: stored.kind,
        ok: stored.ok,
        action: stored.action === "verify" ? "verify" : "substitute",
        params: {},
        chars: 0,
        ms: 0,
        ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    };
}

/** The current text of an item, or one of its versions, in the same shape the chat section uses. */
function renderVersion(row: DecisionRecord, version?: DecisionVersion): string {
    // An old version omits what it did not have yet: the current row's versioned fields are cleared first.
    const view: DecisionRecord = version ? { ...withoutVersioned(row), ...version, state: version.state } : row;
    const parts = [decisionsMarkdown([view]).trim()];

    if (view.reasoning) {
        parts.push(`Reasoning:\n${view.reasoning}`);
    }

    if (view.excerpt) {
        parts.push(`Excerpt:\n${view.excerpt}`);
    }

    const tokens = view.transclusions ?? [];

    if (tokens.length > 0) {
        const failed = tokens.filter((token) => !token.ok);
        parts.push(
            pc.dim(
                `Inline tokens: ${tokens.length - failed.length} resolved, ${failed.length} failed` +
                    (view.source ? " (the text as written is kept in `source`; --json shows it)" : "")
            )
        );
    }

    return parts.join("\n\n");
}

export function registerShowCommand(program: Command): void {
    program
        .command("show <id>")
        .description("Show one decision or todo; --versions also lists the texts later posts superseded")
        .option("--versions", "list every earlier version, oldest first")
        .option("--json", "print the stored row, versions and token records included")
        .option(
            "--recheck",
            "resolve the [verify] tokens again and report unchanged or changed since capture; stores nothing"
        )
        .action(async (id: string, opts: { versions?: boolean; json?: boolean; recheck?: boolean }) => {
            if (!isDecisionId(id)) {
                out.printlnErr(
                    pc.red(
                        `show reads decisions and todos (d_<n>_<session>, t_<n>_<session>); for a form use ${toolCommand("question poll")} ${id}`
                    )
                );
                process.exitCode = 1;
                return;
            }

            const row = readDecisions(decisionFiles().file).find((item) => item.id === id);

            if (!row) {
                out.printlnErr(pc.red(`no decision or todo ${id}`));
                process.exitCode = 1;
                return;
            }

            if (opts.recheck) {
                const outcomes = await recheck((row.transclusions ?? []).map(storedToken), {
                    registry: questionTokenRegistry(),
                    assetDir: PREVIEW_ASSET_DIR,
                });

                if (opts.json) {
                    out.result(SafeJSON.stringify({ id: row.id, outcomes }, null, 2));
                    return;
                }

                if (outcomes.length === 0) {
                    out.println(pc.dim(`${row.id} has no inline tokens to re-check.`));
                    return;
                }

                for (const outcome of outcomes) {
                    const color =
                        outcome.status === "changed" ? pc.yellow : outcome.status === "failed" ? pc.red : pc.dim;
                    out.println(color(formatRecheck(outcome)));
                }

                return;
            }

            if (opts.json) {
                out.result(row);
                return;
            }

            const revision = row.revision ?? 1;
            out.println(
                pc.bold(
                    `${row.id} · ${row.state} · revision ${revision}${row.revisedTs ? ` (since ${row.revisedTs})` : ""}`
                )
            );
            out.println(renderVersion(row));

            const versions = row.versions ?? [];

            if (!opts.versions) {
                if (versions.length > 0) {
                    out.println(
                        pc.dim(
                            `\n${versions.length} earlier version(s): ${toolCommand("question show")} ${row.id} --versions`
                        )
                    );
                }

                return;
            }

            if (versions.length === 0) {
                out.println(pc.dim("\nNo earlier versions: nothing superseded this item."));
                return;
            }

            for (const version of versions) {
                out.println(
                    pc.bold(
                        `\n── revision ${version.revision} · posted ${version.createdTs ?? "?"} · superseded ${version.supersededTs} · was ${version.state}`
                    )
                );
                out.println(renderVersion(row, version));
            }
        });
}
