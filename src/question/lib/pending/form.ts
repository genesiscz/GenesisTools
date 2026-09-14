import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
    type AskAnswer,
    type AskChoice,
    type AskForm,
    type AskImage,
    type AskItem,
    type CreateAskFormInput,
    MAX_FILE_TAGS_PER_ANSWER,
    MAX_FREE_TEXT_CHARS,
    MAX_IMAGE_BASE64_CHARS,
    MAX_IMAGES_PER_ANSWER,
    MAX_WAIT_BUDGET_MS,
} from "./types";

/**
 * Nearest directory at or above `start` that contains `.git`.
 *
 * Stops at `$HOME` inclusive and at the volume root, so a project outside any repo can
 * never resolve a cwd above the user's home and widen what `@file` can reach.
 */
export function nearestGitRoot(start: string, home: string = homedir()): string | null {
    const stop = resolve(home);
    let dir = resolve(start);

    for (let i = 0; i < 64; i++) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }

        if (dir === stop) {
            break;
        }

        const parent = dirname(dir);

        if (parent === dir) {
            break;
        }

        dir = parent;
    }

    return null;
}

export function resolveAskCwd(projectPath: string): string {
    const abs = resolve(projectPath);

    return nearestGitRoot(abs) ?? abs;
}

export function normalizeChoices(choices?: Array<string | AskChoice>): AskChoice[] | undefined {
    if (!choices?.length) {
        return undefined;
    }

    const normalized = choices.map((choice, index) => {
        if (typeof choice === "string") {
            const label = choice.trim();

            return { id: label || `c${index + 1}`, label: label || `Option ${index + 1}` };
        }

        return {
            id: String(choice.id || `c${index + 1}`),
            label: String(choice.label || choice.id || `Option ${index + 1}`),
        };
    });
    const seen = new Set<string>();

    for (const choice of normalized) {
        // Two choices sharing an id are indistinguishable in an answer, and `sanitizeAnswer`
        // would accept one id as a pick of either.
        if (seen.has(choice.id)) {
            throw new Error(`createAskForm: duplicate choice id ${choice.id}`);
        }

        seen.add(choice.id);
    }

    return normalized;
}

/**
 * A form timeout the store can actually arithmetic on, or none at all.
 *
 * `expireDueForms` compares `created_at + timeout_ms`, so a fractional, negative, NaN or
 * non-number value either retires the form the moment it is posted or poisons the comparison.
 * The HTTP door hands this straight through from a request body, so the check lives here, where
 * every door reaches it.
 */
export function sanitizeTimeoutMs(timeoutMs: unknown): number | undefined {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
        return undefined;
    }

    // Floor BEFORE the range check, not after: any value under 1ms floors to 0, and a stored 0
    // satisfies `created_at + timeout_ms <= now` on the very first sweep, retiring the form on
    // arrival — the failure this function exists to prevent.
    const ms = Math.floor(timeoutMs);

    if (ms <= 0) {
        return undefined;
    }

    return Math.min(ms, MAX_WAIT_BUDGET_MS);
}

export function createAskForm(input: CreateAskFormInput): AskForm {
    if (input.items.length === 0) {
        throw new Error("createAskForm: a form needs at least one item");
    }

    const ids = input.items.map((item, index) => item.id ?? `q${index + 1}`);

    // Answers are keyed by item id. Two items sharing one id would let a single answer
    // satisfy both required questions, and the second would never be asked properly.
    if (new Set(ids).size !== ids.length) {
        throw new Error("createAskForm: duplicate item id");
    }

    return {
        id: input.id ?? `ask_${randomUUID()}`,
        createdAt: Date.now(),
        source: input.source,
        sessionHint: input.sessionHint,
        projectPath: resolve(input.projectPath),
        cwd: resolveAskCwd(input.projectPath),
        items: input.items.map((item, index) => ({
            id: item.id ?? `q${index + 1}`,
            promptMarkdown: item.promptMarkdown,
            choices: normalizeChoices(item.choices),
            allowMultiple: item.allowMultiple ?? false,
            allowFreeText: item.allowFreeText ?? true,
            allowFileTags: item.allowFileTags ?? false,
            allowImagePaste: item.allowImagePaste ?? false,
            required: item.required ?? true,
        })),
        status: "pending",
        timeoutMs: sanitizeTimeoutMs(input.timeoutMs),
    };
}

/**
 * Keep only relative tags that stay inside the form cwd.
 *
 * `..` is rejected per SEGMENT, not by prefix: a prefix test also drops legitimate names
 * like `..env.example`. The resolved-boundary check below is the real containment guard.
 */
export function sanitizeFileTags(tags: string[] | undefined, cwd: string): string[] {
    if (!tags?.length) {
        return [];
    }

    const root = resolve(cwd);
    const out: string[] = [];

    for (const raw of tags.slice(0, MAX_FILE_TAGS_PER_ANSWER)) {
        if (typeof raw !== "string" || !raw.trim()) {
            continue;
        }

        const tag = raw.trim().replace(/^@/, "");

        if (tag.includes("\0") || tag.startsWith("~") || isAbsolute(tag)) {
            continue;
        }

        const norm = normalize(tag).replace(/\\/g, "/");

        if (norm.split("/").some((segment) => segment === "..") || !norm || norm === ".") {
            continue;
        }

        const abs = resolve(root, norm);

        if (!abs.startsWith(root + sep) && abs !== root) {
            continue;
        }

        out.push(norm.replace(/^\.\//, ""));
    }

    return [...new Set(out)];
}

export function sanitizeImages(images: AskImage[] | undefined): AskImage[] {
    if (!images?.length) {
        return [];
    }

    const out: AskImage[] = [];

    for (const image of images.slice(0, MAX_IMAGES_PER_ANSWER)) {
        if (!image?.base64 || typeof image.base64 !== "string" || image.base64.length > MAX_IMAGE_BASE64_CHARS) {
            continue;
        }

        const mime = (image.mime || "image/png").slice(0, 64);

        if (!mime.startsWith("image/")) {
            continue;
        }

        out.push({
            name: (image.name || "paste.png").replace(/[^\w.-]+/g, "_").slice(0, 128),
            mime,
            base64: image.base64,
        });
    }

    return out;
}

/** Drop anything the item did not offer, so a client cannot smuggle a choice or a path in. */
export function sanitizeAnswer(answer: AskAnswer, form: AskForm): AskAnswer {
    const item = form.items.find((candidate) => candidate.id === answer.itemId);
    const choiceIds = new Set((item?.choices ?? []).map((choice) => choice.id));
    // An item that offered NO choices cannot have one selected. Accepting any id there also
    // satisfied `itemAnswered`, so a required free-text question could be closed with a value
    // it never offered and no text at all.
    let selected = (answer.selectedChoices ?? []).filter((id) => choiceIds.has(id));

    if (item && !item.allowMultiple && selected.length > 1) {
        selected = selected.slice(0, 1);
    }

    return {
        itemId: answer.itemId,
        // Mirror of the choice rule above: a choice-only item (`--no-free-text`) must not be
        // closed by arbitrary text, which `itemAnswered` would otherwise count as an answer.
        freeText: item?.allowFreeText ? answer.freeText?.slice(0, MAX_FREE_TEXT_CHARS) : undefined,
        selectedChoices: selected.length ? selected : undefined,
        fileTags: item?.allowFileTags ? sanitizeFileTags(answer.fileTags, form.cwd) : undefined,
        images: item?.allowImagePaste ? sanitizeImages(answer.images) : undefined,
    };
}

export function itemAnswered(item: AskItem, answer: AskAnswer | undefined): boolean {
    if (!item.required) {
        return true;
    }

    if (!answer) {
        return false;
    }

    return (
        (answer.selectedChoices?.length ?? 0) > 0 ||
        (answer.freeText?.trim().length ?? 0) > 0 ||
        (answer.images?.length ?? 0) > 0 ||
        (answer.fileTags?.length ?? 0) > 0
    );
}

/** Every required item that is still unanswered. Empty means the form may be submitted. */
export function missingRequiredItems(form: AskForm, answers: Record<string, AskAnswer>): AskItem[] {
    return form.items.filter((item) => !itemAnswered(item, answers[item.id]));
}
