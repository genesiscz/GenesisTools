/**
 * One purpose-template registry for both `tools jev screen` and `tools jev verify`.
 *
 * It is the union of the two source implementations: PR #410 contributed pii-names, pii-contact,
 * secrets, prompt-injection, relevance, risk, accuracy, contradiction, license-ok and
 * focus-safety; PR #411 contributed focus-safety, secrets, pr-review, control-refusal,
 * compact-safe, license, public-api-break, macos-tcc and test-accounts. `license-ok` and `license`
 * describe the same concern, so they merged into `license` and the old id survives as an alias.
 *
 * A template is a named bundle of Jev questions. Document templates score the text under review.
 * Claim templates score each claim separately; `verify` always asks the claim questions, so the
 * two claim templates are aliases into that fixed set rather than extra requests.
 */

export type TemplateScope = "document" | "claim";

export interface TemplateQuestion {
    id: string;
    type: "boolean" | "score";
    instructions: string;
    /** Score questions only. The evaluation schema requires at least two ordered criteria. */
    criteria?: string[];
}

export interface PurposeTemplate {
    id: string;
    summary: string;
    scope: TemplateScope;
    questions: TemplateQuestion[];
}

/**
 * Asked for every claim on every `verify` run, whatever `--purpose` selects.
 *
 * B12: PR #410 only added per-claim questions when `--purpose` happened to contain `accuracy` or
 * `contradiction`, so `verify --purpose pii-names,secrets` reported `claims: {c1:{}, c2:{}}` — an
 * empty answer object per claim, which read as "judged and found nothing". The claim questions are
 * no longer tied to the purpose selection.
 */
const SUPPORTED_QUESTION: TemplateQuestion = {
    id: "supported",
    type: "boolean",
    instructions: "Is this claim supported by the text under review?",
};

const CONTRADICTED_QUESTION: TemplateQuestion = {
    id: "contradicted",
    type: "boolean",
    instructions: "Does the text under review contradict this claim?",
};

const SENSITIVE_QUESTION: TemplateQuestion = {
    id: "sensitive",
    type: "boolean",
    instructions: "Does this claim include personal names, contact details, credentials, or other sensitive data?",
};

export const CLAIM_QUESTIONS: TemplateQuestion[] = [SUPPORTED_QUESTION, CONTRADICTED_QUESTION, SENSITIVE_QUESTION];

export const PURPOSE_TEMPLATES: PurposeTemplate[] = [
    {
        id: "pii-names",
        summary: "Personal names of real people in the text.",
        scope: "document",
        questions: [
            {
                id: "names",
                type: "boolean",
                instructions: "Does the text include personal names of real people beyond license authors?",
            },
        ],
    },
    {
        id: "pii-contact",
        summary: "Contact details: emails, phone numbers, addresses.",
        scope: "document",
        questions: [
            {
                id: "contact",
                type: "boolean",
                instructions: "Does the text include email addresses, phone numbers, or physical addresses?",
            },
        ],
    },
    {
        id: "secrets",
        summary: "Credentials, live account identifiers and names that must not ship.",
        scope: "document",
        questions: [
            {
                id: "secrets",
                type: "boolean",
                instructions: "Does the text include API keys, tokens, passwords, or private key material?",
            },
            { id: "names", type: "boolean", instructions: "Does the text include personal names?" },
            {
                id: "account-ids",
                type: "boolean",
                instructions: "Does the text include live account ids, login emails, or organisation names?",
            },
        ],
    },
    {
        id: "prompt-injection",
        summary: "Instructions aimed at an AI agent hidden in the text.",
        scope: "document",
        questions: [
            {
                id: "injection",
                type: "boolean",
                instructions: "Does the text contain instructions aimed at an AI agent, or a jailbreak attempt?",
            },
        ],
    },
    {
        id: "relevance",
        summary: "Whether the text serves the stated task.",
        scope: "document",
        questions: [{ id: "relevant", type: "boolean", instructions: "Is the text relevant to the stated task?" }],
    },
    {
        id: "risk",
        summary: "Graded risk of shipping the text unchanged.",
        scope: "document",
        questions: [
            {
                id: "risk",
                type: "score",
                instructions: "Rate the risk of shipping this text as it stands.",
                criteria: [
                    "low: safe to ship unchanged",
                    "review: a person should read it first",
                    "high: shipping this causes harm",
                ],
            },
        ],
    },
    {
        id: "accuracy",
        summary: "Per-claim support. Verify always asks it; selecting it adds no extra request.",
        scope: "claim",
        questions: [SUPPORTED_QUESTION],
    },
    {
        id: "contradiction",
        summary: "Per-claim contradiction. Verify always asks it; selecting it adds no extra request.",
        scope: "claim",
        questions: [CONTRADICTED_QUESTION],
    },
    {
        id: "license",
        summary: "Third-party notices and license grants.",
        scope: "document",
        questions: [
            {
                id: "notices",
                type: "boolean",
                instructions: "Are third-party notices present when third-party code is included?",
            },
            { id: "grant-change", type: "boolean", instructions: "Does this add or change a license grant?" },
        ],
    },
    {
        id: "focus-safety",
        summary: "Keystrokes or clicks reaching the wrong application.",
        scope: "document",
        questions: [
            {
                id: "wrong-app",
                type: "boolean",
                instructions: "Could this change send keys or clicks to the wrong application?",
            },
            { id: "relevant", type: "boolean", instructions: "Is this file or hunk relevant to the stated purpose?" },
            { id: "risky", type: "boolean", instructions: "Does this change introduce a safety or correctness risk?" },
        ],
    },
    {
        id: "pr-review",
        summary: "Whether a change deserves a human review thread.",
        scope: "document",
        questions: [
            { id: "relevant", type: "boolean", instructions: "Is this file relevant to the pull request purpose?" },
            { id: "risky", type: "boolean", instructions: "Is this change risky enough to open a review thread?" },
            { id: "needs-thread", type: "boolean", instructions: "Should a human review thread be opened?" },
        ],
    },
    {
        id: "control-refusal",
        summary: "The control safety refusals still in place.",
        scope: "document",
        questions: [
            {
                id: "refuses-invalid-to-pid",
                type: "boolean",
                instructions: "Does this still refuse an invalid --to-pid?",
            },
            {
                id: "refuses-stale-token",
                type: "boolean",
                instructions: "Does this still refuse a stale snapshot token?",
            },
        ],
    },
    {
        id: "compact-safe",
        summary: "Transcript compaction that must not rewrite or drop protected turns.",
        scope: "document",
        questions: [
            { id: "rewrites-user-text", type: "boolean", instructions: "Does this rewrite user or assistant text?" },
            { id: "drops-pinned", type: "boolean", instructions: "Does this drop pinned tail messages?" },
        ],
    },
    {
        id: "public-api-break",
        summary: "Removed or renamed public exports.",
        scope: "document",
        questions: [
            { id: "breaks-export", type: "boolean", instructions: "Does this remove or rename a public export?" },
        ],
    },
    {
        id: "macos-tcc",
        summary: "macOS privacy grant and permission paths.",
        scope: "document",
        questions: [{ id: "touches-tcc", type: "boolean", instructions: "Does this change a TCC or permission path?" }],
    },
    {
        id: "test-accounts",
        summary: "Live account names used where a fixture identity belongs.",
        scope: "document",
        questions: [
            {
                id: "uses-live-account",
                type: "boolean",
                instructions: "Does this test use a live account name instead of a fixture identity?",
            },
        ],
    },
];

/** Retired ids that still resolve, so a saved command line keeps working. */
export const PURPOSE_ALIASES: Record<string, string> = { "license-ok": "license" };

export const PURPOSE_IDS: string[] = PURPOSE_TEMPLATES.map((template) => template.id);

export const DEFAULT_VERIFY_PURPOSES = ["secrets", "prompt-injection"];

const BY_ID = new Map(PURPOSE_TEMPLATES.map((template) => [template.id, template]));

export function templateById(id: string): PurposeTemplate | undefined {
    return BY_ID.get(PURPOSE_ALIASES[id] ?? id);
}

/** One key per document question, so two templates may share a question id without colliding. */
export function documentQuestionKey(templateId: string, questionId: string): string {
    return `${templateId}__${questionId}`;
}

export function claimQuestionKey(claimId: string, questionId: string): string {
    return `claim__${claimId}__${questionId}`;
}

export function parsePurposes(raw: string | string[] | undefined, fallback: string[] = []): PurposeTemplate[] {
    const parts = (Array.isArray(raw) ? raw : (raw ?? "").split(","))
        .flatMap((part) => part.split(","))
        .map((part) => part.trim())
        .filter(Boolean);
    const ids = parts.length > 0 ? parts : fallback;
    const resolved: PurposeTemplate[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
        const template = templateById(id);

        if (!template) {
            unknown.push(id);
            continue;
        }

        if (!resolved.some((entry) => entry.id === template.id)) {
            resolved.push(template);
        }
    }

    if (unknown.length > 0) {
        throw new Error(`Unknown purpose template(s): ${unknown.join(", ")}. Valid: ${PURPOSE_IDS.join(", ")}`);
    }

    return resolved;
}

export function listTemplates(): Array<{
    id: string;
    summary: string;
    scope: TemplateScope;
    questions: Array<{ id: string; type: string; instructions: string; criteria?: string[] }>;
}> {
    return PURPOSE_TEMPLATES.map((template) => ({
        id: template.id,
        summary: template.summary,
        scope: template.scope,
        questions: template.questions.map((question) => ({
            id: question.id,
            type: question.type,
            instructions: question.instructions,
            criteria: question.criteria,
        })),
    }));
}
