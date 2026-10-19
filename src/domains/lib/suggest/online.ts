import { isValidLabel } from "@app/domains/lib/domain";
import { request } from "@app/domains/lib/http";
import { combine, type SuggestContext, type Suggestor } from "@app/domains/lib/suggest/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
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

async function optionalTarget(
    resolve: () => Promise<ResolvedTarget>,
    via: string
): Promise<ResolvedTarget | undefined> {
    try {
        return await resolve();
    } catch (error) {
        // Only "nothing usable here" moves on; a credential or vault error is the real answer.
        if (!(error instanceof ModelResolutionError)) {
            throw error;
        }

        logger.debug({ via, error }, "domains: no AI model here, trying the next");
        return undefined;
    }
}

/**
 * Pick the account without spending money the user did not ask to spend:
 *   an explicit `--model` ref or the `domains` app default (the user's own choice, honoured even when paid),
 *   else the `ask` default when it is a subscription or free account,
 *   else the first enabled subscription account that can chat,
 *   else the `ask` default after all (a paid account; the caller warns).
 * Resolves only: no credential is read and nothing is bound.
 */
export async function brainstormTarget(model: string | undefined): Promise<ResolvedTarget> {
    if (model) {
        return resolveModelTarget(model, { task: "chat", app: "domains" });
    }

    const store = await AiConfigStore.load();
    const domainsDefault = store.data().defaults.app?.domains?.chat;

    if (domainsDefault?.model || domainsDefault?.provider) {
        return resolveModelTarget(undefined, { task: "chat", app: "domains", store });
    }

    const askDefault = await optionalTarget(
        () => resolveModelTarget(undefined, { task: "chat", app: "ask", store }),
        "ask default"
    );

    if (askDefault && askDefault.account.billing.mode !== "metered") {
        return askDefault;
    }

    for (const account of store.accounts({ billing: "subscription", enabled: true })) {
        const target = await optionalTarget(
            () => resolveModelTarget(`@account/${account.id}`, { task: "chat", store }),
            `subscription ${account.name}`
        );

        if (target) {
            return target;
        }
    }

    if (askDefault) {
        return askDefault;
    }

    throw new Error(
        `AI suggestor: no model. Pass --model <ref> or set one: ${toolCommand("ai config default set", "chat", "<ref>", "--app", "domains")}`
    );
}

const warnedPaidAccounts = new Set<string>();

async function resolveBrainstormModel(model: string | undefined): Promise<ResolvedBinding> {
    const target = await brainstormTarget(model);
    logger.debug(
        { account: target.account.name, billing: target.account.billing.mode, model: target.model.id, via: target.via },
        "domains: AI suggestor account"
    );

    if (target.account.billing.mode === "metered" && !warnedPaidAccounts.has(target.account.id)) {
        warnedPaidAccounts.add(target.account.id);
        out.log.warn(
            `AI suggestor uses "${target.account.name}" (${target.account.provider}), a paid API account: every round costs money. ` +
                `For a subscription account, pass --model @account/<id> or run ` +
                toolCommand("ai config default set", "chat", "@account/<id>", "--app", "domains")
        );
    }

    const binding = await target.plugin.bind({ account: target.account });
    return { ...target, binding };
}

async function brainstorm(context: SuggestContext) {
    const resolved = await resolveBrainstormModel(context.model);
    try {
        return await callLLMStructured({
            model: resolved,
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: aiUserPrompt(context),
            schema: AiNames,
            app: "domains",
            temperature: 0.9,
        });
    } finally {
        await resolved.binding.dispose?.();
    }
}

export const aiSuggestor: Suggestor = {
    id: "ai",
    label: "LLM brainstorm (brandables, translations, hacks); a subscription account first, warns on a paid one",
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
