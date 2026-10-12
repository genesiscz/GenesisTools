/**
 * The commit-subject rules of this repository: one scope vocabulary, and no PR numbers in subjects.
 *
 * - The native app's features are `GenesisHub, <area>` (widgets, settings, focus, flow, voice notes, inbox, app,
 *   preview, review, and hub when Swift files change); shared Swift components are `GenesisKit, <area>`
 *   (permissions, media, charts); Clicky is always `Clicky`.
 * - A skill is `skills, <skill>`; a script is `scripts`, or `scripts, native` under `scripts/native/`.
 * - A sub-area of the AI subsystem carries `ai` (`ai, history`, `ai, transcripts`, `ai, usage`, `ai, pricing`).
 * - Dashboards are `dev-dashboard`, `dashboards`, or both; a commit spanning many areas is `tools`.
 * - A follow-up for another PR reads `fix(<areas>): #485 followup - …`; no other subject names a PR.
 *
 * `checkSubject` returns the corrected subject and why it changed. `check-commits.ts` uses it in the `commit-msg`
 * hook and over a range of commits.
 */

export interface SubjectCheck {
    /** The subject as the rules want it; equal to the input when nothing is wrong. */
    subject: string;
    /** One line per rule the input broke. */
    problems: string[];
}

export const COMMIT_TYPES = [
    "feat",
    "fix",
    "perf",
    "refactor",
    "test",
    "bench",
    "docs",
    "style",
    "chore",
    "build",
    "ci",
    "revert",
];

const KIT = /^src\/macos\/GenesisKit\/(?:Sources\/GenesisKit|Tests\/GenesisKitTests)\/([^/]+)/;
const SKILL = /^(?:\.claude|plugins\/[^/]+)\/skills\/([^/]+)\//;
const AI_AREAS: Record<string, string> = {
    history: "history",
    transcripts: "transcripts",
    "usage-poll": "usage-poll",
    "ai-usage": "usage",
    "codex-usage": "codex-usage",
    pricing: "pricing",
};

/** The GenesisKit folder (or test file name) a change lives in, as a scope. */
function kitScope(part: string): string {
    const name = part.replace(/(?:Tests)?\.swift$/, "").toLowerCase();
    const table: [RegExp, string][] = [
        [/^widget/, "GenesisHub, widgets"],
        [/^settings/, "GenesisHub, settings"],
        [/^clicky/, "Clicky"],
        [/^(focus|flowfocus|activity)/, "GenesisHub, focus"],
        [/^flow/, "GenesisHub, flow"],
        [/^audio|^voice/, "GenesisHub, voice notes"],
        [/^permission/, "GenesisKit, permissions"],
        [/^media/, "GenesisKit, media"],
        [/^chart/, "GenesisKit, charts"],
    ];

    return table.find(([re]) => re.test(name))?.[1] ?? "GenesisKit";
}

/** The scope one file belongs to, or null for files that name no area (root docs, lockfiles). */
export function areaOfFile(file: string): string | null {
    const kit = KIT.exec(file);
    if (kit) {
        return kitScope(kit[1]);
    }

    const skill = SKILL.exec(file);
    if (skill) {
        return `skills, ${skill[1]}`;
    }

    const rules: [RegExp, string][] = [
        [/^src\/macos\/GenesisClickyPreview\//, "Clicky"],
        [/^src\/macos\/GenesisWidgetPreview\//, "GenesisHub, widgets"],
        [/^src\/macos\/GenesisTools\//, "GenesisHub"],
        [/^src\/macos\//, "macos"],
        [/^native\/ax-tool\//, "ax-tool"],
        [/^scripts\/native\//, "scripts, native"],
        [/^scripts\//, "scripts"],
        [/^src\/utils\/(ai|agent-sessions)\//, "ai"],
        [/^src\/dev-dashboard\//, "dev-dashboard"],
        [/^src\/utils\/ui\//, "dashboards"],
    ];
    const hit = rules.find(([re]) => re.test(file));
    if (hit) {
        return hit[1];
    }

    const tool = /^src\/(?:utils\/)?([^/.]+)/.exec(file);
    return tool ? tool[1] : null;
}

/** Adds `scope` (one or more comma-separated parts) to `parts`, keeping order and skipping repeats. */
function addScope(parts: string[], scope: string): void {
    for (const part of scope.split(",").map((p) => p.trim())) {
        if (part && !parts.includes(part)) {
            parts.push(part);
        }
    }
}

/** The scope the files of a commit name: their areas, or `tools` when more than three areas change. */
export function scopeFromFiles(files: readonly string[]): string {
    const parts: string[] = [];
    const roots = new Set<string>();

    for (const file of files) {
        const area = areaOfFile(file);
        if (area) {
            roots.add(area.split(",")[0].trim());
            addScope(parts, area);
        }
    }

    return roots.size > 3 ? "tools" : parts.join(", ");
}

/** One old scope part in the current vocabulary, deciding by the files where the name alone is ambiguous. */
function mapPart(raw: string, files: readonly string[]): string {
    const part = raw.toLowerCase();
    const skills = [...new Set(files.map((f) => SKILL.exec(f)?.[1]).filter((s): s is string => Boolean(s)))];
    const allUnder = (prefix: string) => files.length > 0 && files.every((f) => f.startsWith(prefix));

    if (part === "genesiskit" || part === "genesis-kit") {
        return "GenesisKit";
    }

    if (part === "genesishub") {
        return "GenesisHub";
    }

    if (part === "widget" || part === "widgets") {
        return "GenesisHub, widgets";
    }

    if (part === "clicky") {
        return "Clicky";
    }

    const hubAreas: Record<string, string> = {
        settings: "settings",
        focus: "focus",
        flow: "flow",
        voice: "voice notes",
        "voice notes": "voice notes",
        inbox: "inbox",
        app: "app",
        "app-build": "app build",
        "app build": "app build",
        preview: "preview",
        review: "review",
    };
    if (hubAreas[part]) {
        return `GenesisHub, ${hubAreas[part]}`;
    }

    if (part === "permissions" || part === "media" || part === "charts") {
        return `GenesisKit, ${part}`;
    }

    if (part === "hub") {
        return files.some((f) => f.startsWith("src/macos/")) ? "GenesisHub, hub" : "hub";
    }

    if (AI_AREAS[part]) {
        return `ai, ${AI_AREAS[part]}`;
    }

    if (part === "skills" || part === "ux" || part === "swift") {
        if (skills.length > 0) {
            return `skills, ${skills.join(", ")}`;
        }

        return part === "swift" ? raw : `skills${part === "skills" ? "" : `, ${part}`}`;
    }

    if (part === "scripts" || part === "native" || part === "widget-drive") {
        if (allUnder("scripts/native/")) {
            return "scripts, native";
        }

        if (allUnder("scripts/")) {
            return "scripts";
        }

        return part === "native" && files.some((f) => f.startsWith("src/macos/")) ? scopeFromFiles(files) : raw;
    }

    if (part === "control" && allUnder("native/ax-tool/")) {
        return "ax-tool";
    }

    if (part === "ui") {
        return files.some((f) => f.startsWith("src/macos/GenesisKit/")) ? "GenesisKit" : "dashboards";
    }

    if (part === "dashboards") {
        const dev = files.some((f) => f.startsWith("src/dev-dashboard/"));
        const shared = files.some((f) => f.startsWith("src/utils/ui/"));
        return dev && shared ? "dashboards, dev-dashboard" : dev ? "dev-dashboard" : "dashboards";
    }

    return raw;
}

/** A scope in the current vocabulary. */
export function normalizeScope(scope: string, files: readonly string[]): string {
    const parts: string[] = [];

    for (const raw of scope.split(",").map((s) => s.trim())) {
        if (raw) {
            addScope(parts, mapPart(raw, files));
        }
    }

    return parts.join(", ");
}

/** PR references that the subject text may not carry, and what replaces them. */
const TEXT_FIXES: [RegExp, string, string][] = [
    [/address PR #\d+ review/g, "address PR review", "names a PR number in `address PR review`"],
    [/address PR #\d+ (CodeRabbit|late review)/g, "address $1", "names a PR number in `address …`"],
    [/address CodeRabbit on #\d+/g, "address CodeRabbit", "names a PR number after `address CodeRabbit`"],
    [/CodeRabbit CLI round (\d+) on #\d+/g, "CodeRabbit CLI round $1", "names a PR number after a CodeRabbit round"],
    [/ and #\d+ round (\d+)/g, " and review round $1", "names a PR number in `and #N round`"],
    [/ ?\((?:#\d+-only files|this PR's files only)\)/g, "", "says which PR's files it covers; the scope says that"],
    [/#\d+ on the /g, "the branch on the ", "names a PR number"],
    [/the #\d+ round-(\d+)/g, "the review round-$1", "names a PR number"],
];

/** Checks one subject against the rules; `files` are the paths the commit changes. */
export function checkSubject(subject: string, files: readonly string[]): SubjectCheck {
    const problems: string[] = [];
    const m = /^([A-Za-z]+)(?:\(([^)]*)\))?(!?):\s*(.*)$/.exec(subject);
    if (!m) {
        return { subject, problems: ["is not `type(scope): text`"] };
    }

    const [, type, scope, bang, text] = m;
    let newType = type;
    let newScope = scope;
    let rest = text;
    const round = scope ? /^(?:#\d+ )?round (\d+)$/.exec(scope) : null;
    const followUp = scope ? /^(#\d+) follow-up$/.exec(scope) : null;

    if (round) {
        newType = "fix";
        newScope = scopeFromFiles(files);
        rest = `address PR review round ${round[1]}: ${text}`;
        problems.push(`\`${type}(${scope})\` is a review round: \`fix(<areas>): address PR review round N: …\``);
    } else if (scope && /^#\d+ coderabbit-cli$/.test(scope)) {
        newType = "fix";
        newScope = scopeFromFiles(files);
        rest = `address CodeRabbit CLI: ${text}`;
        problems.push(`\`(${scope})\` names a PR: \`fix(<areas>): address CodeRabbit CLI: …\``);
    } else if (followUp) {
        newScope = scopeFromFiles(files);
        rest = `${followUp[1]} followup - ${text}`;
        problems.push(`a follow-up reads \`${type}(<areas>): ${followUp[1]} followup - …\``);
    } else if (scope === "restack") {
        newScope = scopeFromFiles(files);
        problems.push("`(restack)` is no area: the scope comes from the files");
    } else if (scope) {
        newScope = normalizeScope(scope, files);
        if (newScope !== scope) {
            problems.push(`scope \`(${scope})\` is \`(${newScope})\` in this repository's vocabulary`);
        }
    }

    if (!COMMIT_TYPES.includes(newType)) {
        problems.push(`type \`${newType}\` is not one of ${COMMIT_TYPES.join(", ")}`);
    }

    for (const [re, replacement, why] of TEXT_FIXES) {
        const fixed = rest.replace(re, replacement);
        if (fixed !== rest) {
            problems.push(`the text ${why}`);
            rest = fixed;
        }
    }

    if (/#\d+/.test(rest.replace(/^#\d+ followup - /, ""))) {
        problems.push("the text names a PR number; only `#N followup - …` may");
    }

    const scopePart = newScope ? `(${newScope})` : "";
    return { subject: `${newType}${scopePart}${bang}: ${rest}`, problems };
}
