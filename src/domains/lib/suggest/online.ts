import { isValidLabel } from "@app/domains/lib/domain";
import { request } from "@app/domains/lib/http";
import { combine, type SuggestContext, type Suggestor } from "@app/domains/lib/suggest/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import {
    type AutoAccountOptions,
    type AutoCandidate,
    autoAccountCandidates,
    runWithAutoAccount,
} from "@genesiscz/utils/ai/core/auto-account";
import { callLLMStructured } from "@genesiscz/utils/ai/core/call";
import { ModelResolutionError, resolveModelTarget } from "@genesiscz/utils/ai/core/resolve";
import type { ResolvedBinding, ResolvedTarget } from "@genesiscz/utils/ai/core/types";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import { z } from "zod";

interface DatamuseWord {
    word: string;
    score?: number;
}

/** Words that mean roughly the same (Datamuse `ml=`, no auth). Single ASCII words only. */
export async function relatedWords(word: string, max = 12): Promise<string[]> {
    const response = await request<DatamuseWord[]>(
        `https://api.datamuse.com/words?ml=${encodeURIComponent(word)}&max=${max * 2}`,
        { label: "datamuse" }
    );
    return (response.body ?? [])
        .map((entry) => entry.word.toLowerCase())
        .filter((entry) => /^[a-z]{3,12}$/.test(entry))
        .slice(0, max);
}

export const synonymSuggestor: Suggestor = {
    id: "synonyms",
    label: "Related words from Datamuse (origin.tech, dawnlabs.dev)",
    online: true,
    defaultOn: true,
    async suggest(context) {
        const [head, ...rest] = context.words;
        if (!head) {
            return [];
        }

        const related = await relatedWords(head);
        const tail = rest.join("");
        const labels = related.flatMap((word) => (tail ? [word + tail, word] : [word])).filter(isValidLabel);
        return combine({
            labels,
            tlds: context.tlds.slice(0, 4),
            source: "synonyms",
            reason: () => `related to "${head}"`,
        }).slice(0, context.limit);
    },
};

const AiNames = z.object({
    names: z
        .array(
            z.object({
                label: z.string().describe("lowercase a-z0-9 label without TLD"),
                tld: z.string().optional().describe("a TLD when it is part of the idea, e.g. a domain hack"),
                reason: z.string().describe("why it fits, under 12 words"),
            })
        )
        .max(40),
});

function aiUserPrompt(context: SuggestContext): string {
    const lines = [`Seed: "${context.words.join(" ")}".`];
    if (context.description) {
        lines.push(`About: ${context.description}.`);
    }

    if (context.liked?.length) {
        lines.push(`These were free and scored well; propose more in their spirit: ${context.liked.join(", ")}.`);
    }

    if (context.avoid?.length) {
        lines.push(`Already taken, do not repeat them or close variants: ${context.avoid.slice(0, 80).join(", ")}.`);
    }

    lines.push(`Give ${Math.min(context.limit, 40)} new ideas.`);
    return lines.join("\n");
}

const SYSTEM_PROMPT =
    "You name companies. Propose short, memorable, pronounceable domain labels. Mix: brandable coinages, " +
    "translations of the key word into Latin, Greek and other languages, compounds, and domain hacks where a " +
    "real TLD finishes the word (genesiste.ch). Avoid words that sound rude in Czech, German, Spanish or " +
    "English. No hyphens.";

/** What the AI step will use: one account the user named, or the ranked subscription accounts. */
export type BrainstormPlan = { kind: "fixed"; target: ResolvedTarget } | { kind: "auto"; candidates: AutoCandidate[] };

/** A full ref (`@account/...`, `provider/model`) names an account; a bare id (`sonnet`) only names the model. */
function isFullRef(model: string): boolean {
    return model.startsWith("@") || model.includes("/");
}

/**
 * Decide which account pays for the brainstorm:
 *   `--account <name>`, a full `--model` ref, or the `domains` app default: the user's own choice, even a paid one;
 *   else `auto` (also `--account auto`): every enabled subscription account, ranked by provider and weekly room;
 *   else, only when no subscription account exists, the `ask` default (a paid account; the caller warns).
 * Resolves only: no credential is read and nothing is bound.
 */
export async function brainstormPlan(options: {
    account?: string;
    model?: string;
    snapshots?: AutoAccountOptions["snapshots"];
}): Promise<BrainstormPlan> {
    const store = await AiConfigStore.load();
    const { account, model } = options;
    const fixed = (ref: string | undefined, app: string) =>
        resolveModelTarget(ref, { task: "chat", app, store }).then((target) => ({ kind: "fixed", target }) as const);

    if (account && account !== "auto") {
        const entry = store.account(account);

        if (!entry) {
            throw new Error(
                `No AI account "${account}". List them with: ${toolCommand("ai config account list")}, or pass --account auto`
            );
        }

        if (model && isFullRef(model)) {
            throw new Error(
                `--model ${model} is a full ref and names its own account; pass a bare model with --account ${account}, or drop --account`
            );
        }

        return fixed(`@account/${entry.id}${model ? `:${model}` : ""}`, "domains");
    }

    if (!account && model && isFullRef(model)) {
        return fixed(model, "domains");
    }

    const domainsDefault = store.data().defaults.app?.domains?.chat;

    if (!account && !model && (domainsDefault?.model || domainsDefault?.provider)) {
        return fixed(undefined, "domains");
    }

    const candidates = await autoAccountCandidates({
        task: "chat",
        store,
        ...(model ? { model } : {}),
        ...(options.snapshots ? { snapshots: options.snapshots } : {}),
    });

    if (candidates.length > 0) {
        return { kind: "auto", candidates };
    }

    try {
        return await fixed(model, "ask");
    } catch (error) {
        if (!(error instanceof ModelResolutionError)) {
            throw error;
        }

        throw new Error(
            `AI suggestor: no subscription account and no default. Pass --account <name> or set one: ${toolCommand("ai config default set", "chat", "<ref>", "--app", "domains")}`,
            { cause: error }
        );
    }
}

const warnedPaidAccounts = new Set<string>();

function warnIfPaid(target: ResolvedTarget): void {
    if (target.account.billing.mode !== "metered" || warnedPaidAccounts.has(target.account.id)) {
        return;
    }

    warnedPaidAccounts.add(target.account.id);
    out.log.warn(
        `AI suggestor uses "${target.account.name}" (${target.account.provider}), a paid API account: every round costs money. ` +
            `For a subscription account, pass --account auto or --account <name>, or run ` +
            toolCommand("ai config default set", "chat", "@account/<id>", "--app", "domains")
    );
}

async function brainstorm(context: SuggestContext) {
    const plan = await brainstormPlan({ account: context.account, model: context.model });
    const call = (resolved: ResolvedBinding, maxRetries?: number) =>
        callLLMStructured({
            model: resolved,
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: aiUserPrompt(context),
            schema: AiNames,
            app: "domains",
            temperature: 0.9,
            ...(maxRetries !== undefined ? { maxRetries } : {}),
        });

    if (plan.kind === "auto") {
        // No SDK retries: a full account answers 429 for hours, and the next account is the better retry.
        return runWithAutoAccount({
            candidates: plan.candidates,
            app: "domains",
            run: (resolved) => call(resolved, 0),
        });
    }

    const { target } = plan;
    logger.debug(
        { account: target.account.name, billing: target.account.billing.mode, model: target.model.id, via: target.via },
        "domains: AI suggestor account"
    );
    warnIfPaid(target);

    const binding = await target.plugin.bind({ account: target.account });
    try {
        return await call({ ...target, binding });
    } finally {
        await binding.dispose?.();
    }
}

export const aiSuggestor: Suggestor = {
    id: "ai",
    label: "LLM brainstorm (brandables, translations, hacks); a subscription account (Claude, Codex, Grok), warns on a paid one",
    online: true,
    defaultOn: false,
    async suggest(context) {
        const result = await brainstorm(context);

        const out = [];
        for (const idea of result.object.names) {
            const label = idea.label.toLowerCase().replace(/[^a-z0-9-]/g, "");
            if (!isValidLabel(label)) {
                logger.debug({ idea }, "domains: AI label rejected");
                continue;
            }

            const tlds = idea.tld ? [idea.tld.toLowerCase().replace(/^\./, "")] : context.tlds.slice(0, 3);
            out.push(...combine({ labels: [label], tlds, source: "ai", reason: () => idea.reason }));
        }

        return out.slice(0, context.limit * 3);
    },
};
