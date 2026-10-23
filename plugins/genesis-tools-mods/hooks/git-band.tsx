// The git band: one line above the prompt per checkout the session works in (`checkouts.ts`: the ones it wrote
// files in or changed git state in, the last first, up to `mods.git.checkouts`), each with the branch, unpushed and
// unpulled commits, the dirty count, and the pull requests that matter there (the branch's, plus the ones
// `/mod-git pr add` tracks) with their CI counts. A session that has worked in no checkout yet shows its own
// folder; `mods.git.cwd: always` shows that folder first in every session. It refreshes when the session starts,
// after a Bash call that ran git or gh, after a call that works in another checkout, every 3 minutes, and on
// `/mod-git refresh`; `gh` answers are reused for 2 minutes. `/mod-git on|off|toggle` switches it for this
// session, `mods.git.enabled` for every session. Each refresh and command goes to `mods-log/git.jsonl`.
//
// `/mod-git add <folder>` (the prompt's typeahead proposes folders, zoxide's too) and the sidebar's field put any
// checkout in this session's band; `remove` takes it out, the sidebar's `hide` drops a worked-in one until the
// session works there again. A PR's `track` keeps it in its checkout's row after a branch switch; the branch's own
// PR shows anyway, so its `hide` is what takes it out of the band.
import type { ElementTable, RenderElement } from "claude-code";
import type { BandCheck, BandPr, GitBand, GitBandRows, GitBandSwitch } from "../types";
import {
    addCheckout,
    addedCheckouts,
    folderSuggestions,
    hideCheckout,
    isInCheckout,
    noteToolCall,
    pickRoots,
    removeAdded,
    sessionCheckouts,
} from "./checkouts";
import { type GenesisProbe, genesisProbe, hubLink } from "./genesis";
import { type Feature, type Host, isRecord, logMod, settingsOf, shortDuration } from "./shared";
import {
    actionRow,
    dimNote,
    divider,
    headerRow,
    hintLine,
    type Kit,
    listRow,
    type Pressable,
    plural,
    pressed,
    sidebarFrame,
} from "./sidebar";

export const GIT_PANE = "mods-git";

/** The last refresh, one row per checkout; empty until one finished. */
let rows: GitBandRows = [];
/** The git root of the session's own folder at the last refresh. */
let ownRoot: string | undefined;
/** `/mod-git on|off` for this session; null follows `mods.git.enabled`. */
let turnedOn: GitBandSwitch = null;

const GH_TTL_MS = 2 * 60_000;
const EVERY_MS = 3 * 60_000;
const ghCache = new Map<string, { at: number; pr: BandPr | null }>();
let refreshing: Promise<void> | undefined;

async function run(host: Host, argv: string[], cwd: string): Promise<string | undefined> {
    const done = await host.run(argv, { cwd, timeoutMs: 15_000 }).catch(() => undefined);

    return done?.exitCode === 0 ? done.stdout : undefined;
}

async function cwdRoot(host: Host): Promise<string | undefined> {
    const cwd = await host.cwd();

    return (await run(host, ["git", "rev-parse", "--show-toplevel"], cwd))?.trim() || undefined;
}

/** The checkouts the band shows now, with why: the added ones, then the ones the session worked in, the last first. */
async function bandRoots(host: Host): Promise<{ root: string; why: GitBand["why"] }[]> {
    ownRoot = await cwdRoot(host);
    const touches = await sessionCheckouts(host);
    const added = await addedCheckouts(host);

    return pickRoots(touches, ownRoot, (await settingsOf(host)).git, added).map((root) => ({
        root,
        why: added.includes(root) ? "added" : touches.some((touch) => touch.root === root) ? "worked" : "folder",
    }));
}

/** The checkout `/mod-git pr` acts on: the band's first row. */
async function firstRoot(host: Host): Promise<string | undefined> {
    return rows[0]?.root ?? (await bandRoots(host))[0]?.root;
}

/** A path with the home as `~`. */
function tilde(path: string, home: string | undefined): string {
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A checkout's folder name: `col-fe-marketplace-2.0-poc`. */
export function checkoutName(root: string): string {
    return root.slice(root.lastIndexOf("/") + 1) || root;
}

const storeKey = (root: string) => `git-band-prs:${root}`;

const hiddenKey = (root: string) => `git-band-hidden-prs:${root}`;

async function numbersAt(host: Host, key: string): Promise<number[]> {
    const held = await host.storeGet(key);

    return Array.isArray(held) ? held.filter((n): n is number => typeof n === "number") : [];
}

export function trackedPrs(host: Host, root: string): Promise<number[]> {
    return numbersAt(host, storeKey(root));
}

/** The branch PRs the sidebar's `hide` took out of a checkout's band row. */
function hiddenPrs(host: Host, root: string): Promise<number[]> {
    return numbersAt(host, hiddenKey(root));
}

const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const FAILED = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];

/** Each check of `statusCheckRollup`: a check run has `name` and `conclusion`, a commit status `context` and `state`. */
export function checksOf(rollup: unknown): BandCheck[] {
    return (Array.isArray(rollup) ? rollup : []).filter(isRecord).map((check) => {
        const verdict = String(check.conclusion || check.state || "").toUpperCase();

        return {
            name: String(check.name || check.context || "check"),
            verdict: PASSED.includes(verdict) ? "pass" : FAILED.includes(verdict) ? "fail" : "pending",
        };
    });
}

/** CI counts out of `statusCheckRollup`. */
export function checkCounts(rollup: unknown): { passed: number; failed: number; pending: number } {
    const checks = checksOf(rollup);

    return {
        passed: checks.filter((check) => check.verdict === "pass").length,
        failed: checks.filter((check) => check.verdict === "fail").length,
        pending: checks.filter((check) => check.verdict === "pending").length,
    };
}

async function prOf(host: Host, root: string, which: string, tracked: boolean): Promise<BandPr | null> {
    const key = `${root}|${which}`;
    const held = ghCache.get(key);

    if (held && Date.now() - held.at < GH_TTL_MS) {
        return held.pr ? { ...held.pr, tracked } : null;
    }

    const argv = [
        "gh",
        "pr",
        "view",
        ...(which ? [which] : []),
        "--json",
        "number,title,url,state,isDraft,statusCheckRollup",
    ];
    const text = await run(host, argv, root);
    let pr: BandPr | null = null;

    try {
        const parsed: unknown = text ? JSON.parse(text) : undefined;

        if (isRecord(parsed) && typeof parsed.number === "number") {
            pr = {
                number: parsed.number,
                title: String(parsed.title ?? ""),
                url: String(parsed.url ?? ""),
                state: String(parsed.state ?? ""),
                draft: parsed.isDraft === true,
                tracked,
                own: false,
                hidden: false,
                ...checkCounts(parsed.statusCheckRollup),
                checks: checksOf(parsed.statusCheckRollup),
            };
        }
    } catch {
        pr = null;
    }

    ghCache.set(key, { at: Date.now(), pr });

    return pr;
}

/** `## branch...origin/branch [ahead 2, behind 1]` and one line per changed path, from `git status --porcelain --branch`. */
export function parseStatus(text: string): Pick<GitBand, "branch" | "ahead" | "behind" | "dirty"> {
    const [head = "", ...rest] = text.split("\n");
    const branch = /^## (?:No commits yet on )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)/.exec(head)?.[1] ?? "?";

    return {
        branch: branch === "HEAD" ? "detached" : branch,
        ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
        dirty: rest.filter((row) => row.trim()).length,
    };
}

/** The line totals of `git diff --numstat HEAD`; a binary file (`-`) counts no lines. */
export function parseNumstat(text: string): Pick<GitBand, "added" | "removed"> {
    let added = 0;
    let removed = 0;

    for (const row of text.split("\n")) {
        const [plus = "", minus = ""] = row.split("\t");
        added += /^\d+$/.test(plus) ? Number(plus) : 0;
        removed += /^\d+$/.test(minus) ? Number(minus) : 0;
    }

    return { added, removed };
}

async function isOn(host: Host): Promise<boolean> {
    const held = turnedOn;

    return held ?? (await settingsOf(host)).git.enabled;
}

/** One checkout's row; undefined when git cannot read it. */
async function readRow(host: Host, root: string, why: GitBand["why"]): Promise<GitBand | undefined> {
    const status = await run(host, ["git", "status", "--porcelain", "--branch"], root);

    if (status === undefined) {
        return undefined;
    }

    const numstat = parseNumstat((await run(host, ["git", "diff", "--numstat", "HEAD"], root)) ?? "");
    const tracked = await trackedPrs(host, root);
    const hidden = await hiddenPrs(host, root);
    const own = await prOf(host, root, "", false);
    const others = await Promise.all(
        tracked.filter((n) => n !== own?.number).map((n) => prOf(host, root, String(n), true))
    );
    const mine = own
        ? { ...own, own: true, tracked: tracked.includes(own.number), hidden: hidden.includes(own.number) }
        : null;
    const prs = [mine, ...others].filter((pr): pr is BandPr => pr !== null);

    return { root, why, at: Date.now(), ...parseStatus(status), ...numstat, prs };
}

async function refreshNow(host: Host, why: string): Promise<void> {
    const started = Date.now();
    const roots = await bandRoots(host);
    const read = await Promise.all(roots.map(({ root, why }) => readRow(host, root, why)));
    // A checkout git could not read this time keeps its last row.
    const next = roots
        .map(({ root }, index) => read[index] ?? rows.find((row) => row.root === root))
        .filter((row): row is GitBand => row !== undefined);

    rows = next;
    host.redraw();
    await logMod(host, "git", {
        event: "refresh",
        why,
        rows: next.map((band) => ({
            root: band.root,
            branch: band.branch,
            ahead: band.ahead,
            behind: band.behind,
            dirty: band.dirty,
            added: band.added,
            removed: band.removed,
            prs: band.prs.map((pr) => ({ n: pr.number, passed: pr.passed, failed: pr.failed, pending: pr.pending })),
        })),
        ms: Date.now() - started,
    });
}

/** One refresh at a time; a call while one runs waits for it instead of starting a second `gh`. */
export function refresh(host: Host, why: string): Promise<void> {
    refreshing ??= refreshNow(host, why).finally(() => {
        refreshing = undefined;
    });

    return refreshing;
}

const USAGE =
    "/mod-git [show] | on | off | toggle | refresh | status | add <folder> | remove <folder> | pr add <n…> | pr rm <n…> | pr list";

/** The answer to `/mod-git <args>`. */
async function command(host: Host, args: string): Promise<string> {
    const [verb = "show", sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

    if (verb === "show") {
        await host.togglePane(GIT_PANE, "Git");

        return "";
    }

    if (verb === "on" || verb === "off" || verb === "toggle") {
        const now = verb === "toggle" ? !(await isOn(host)) : verb === "on";
        turnedOn = now;
        host.redraw();

        if (now) {
            await refresh(host, "command");
        }

        return `Git band ${now ? "on" : "off"} for this session.`;
    }

    if (verb === "refresh") {
        ghCache.clear();
        await refresh(host, "command");

        return "Git band refreshed.";
    }

    if (verb === "add" || verb === "remove") {
        const folder = args.trim().slice(verb.length).trim();

        if (!folder) {
            return USAGE;
        }

        if (verb === "add") {
            const done = await addCheckout(host, folder);

            if ("error" in done) {
                return `Not added: ${done.error}.`;
            }

            await refresh(host, "add");

            return `${checkoutName(done.root)} (${done.root}) is in this session's git band.`;
        }

        const gone = await removeAdded(host, folder);
        const added = await addedCheckouts(host);

        if (!gone) {
            return `No added folder ${folder}. Added here: ${added.map(checkoutName).join(", ") || "none"}.`;
        }

        await refresh(host, "remove");

        return `${checkoutName(gone)} is out of this session's git band.`;
    }

    const root = await firstRoot(host);

    if (!root) {
        return "Not in a git repository.";
    }

    const where = checkoutName(root);

    if (verb === "pr") {
        const numbers = rest.map((n) => Number(n.replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0);
        const held = await trackedPrs(host, root);

        if (sub === "list" || sub === undefined) {
            return held.length
                ? `Tracked in ${where}: ${held.map((n) => `#${n}`).join(", ")}`
                : `No tracked PRs in ${where}.`;
        }

        if ((sub !== "add" && sub !== "rm") || numbers.length === 0) {
            return USAGE;
        }

        const next = sub === "add" ? [...new Set([...held, ...numbers])] : held.filter((n) => !numbers.includes(n));
        await host.storeSet(storeKey(root), next);
        await refresh(host, `pr ${sub}`);

        return `Tracked in ${where}: ${next.length ? next.map((n) => `#${n}`).join(", ") : "none"}`;
    }

    if (verb === "status") {
        const band = rows[0];
        const on = await isOn(host);
        const shown = rows.length ? `; checkouts ${rows.map((row) => checkoutName(row.root)).join(", ")}` : "";

        return `Git band ${on ? "on" : "off"}; last refresh ${band ? new Date(band.at).toLocaleTimeString() : "never"}${shown}.`;
    }

    return USAGE;
}

export const gitBand: Feature = {
    async start(host) {
        host.every(EVERY_MS, () => {
            void isOn(host).then((yes) => (yes ? refresh(host, "timer") : undefined));
        });

        if (await isOn(host)) {
            void refresh(host, "start");
        }
    },
    commands: [
        {
            name: "mod-git",
            description:
                "The git band: no argument opens its sidebar; add <folder> and remove <folder> put a checkout in this session's band; on, off, toggle, refresh, status, pr add <n>, pr rm <n>, pr list",
            argumentHint: "add <folder>|remove <folder>|on|off|refresh|pr add <n>",
            async run(host, args) {
                const text = await command(host, args);
                await logMod(host, "git", { event: "command", args, answer: text });

                return text ? { text } : {};
            },
        },
    ],
    sidebars: [{ id: GIT_PANE, title: "Git", draw: gitPane }],
    async autocomplete(host, e) {
        const head = /^\/mod-git\s+(add|remove)\s+/.exec(e.text);

        if (!head || e.start < head[0].length || !(await isOn(host))) {
            return [];
        }

        const home = await host.env("HOME");

        if (head[1] === "remove") {
            const needle = e.token.toLowerCase();

            return (await addedCheckouts(host))
                .filter((root) => root.toLowerCase().includes(needle))
                .map((root) => ({ text: root, label: tilde(root, home), description: "added to this session's band" }));
        }

        return Promise.all(
            (await folderSuggestions(host, e.token)).map(async (found) => ({
                text: found.path,
                label: tilde(found.path, home),
                description: `${found.from}${(await isInCheckout(host, found.path)) ? " · git" : " · not in git"}`,
            }))
        );
    },
    async afterTool(host, e) {
        if (!(await isOn(host))) {
            return;
        }

        const moved = await noteToolCall(host, e);

        if (moved || (e.tool === "Bash" && /(^|[\s;&|(])(git|gh)\s/.test(e.command))) {
            void refresh(host, moved ? "checkout" : "tool");
        }
    },
};

function ciText(pr: BandPr): string {
    const parts = [
        pr.passed ? `✓${pr.passed}` : "",
        pr.failed ? `✗${pr.failed}` : "",
        pr.pending ? `…${pr.pending}` : "",
    ];

    return parts.filter(Boolean).join(" ") || "no CI";
}

function prColor(pr: BandPr): string {
    return pr.failed ? "red" : pr.pending ? "yellow" : pr.state === "MERGED" ? "magenta" : "green";
}

function prNote(pr: BandPr): string {
    return `${pr.draft ? " draft" : ""}${pr.state === "OPEN" ? "" : ` ${pr.state.toLowerCase()}`} ${ciText(pr)}`;
}

/** The hub link for a GitHub PR (`hub?pr=owner%2Frepo%23507`); undefined for another forge or where it opens nothing. */
export function hubUrlOf(probe: GenesisProbe, pr: Pick<BandPr, "url" | "number">): string | undefined {
    const slug = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1];

    return slug ? hubLink(probe, { pr: `${slug}#${pr.number}` }) : undefined;
}

/** The share of the room left for the name and the branch that the checkout name may take when both cannot fit. */
const NAME_SHARE = 0.4;
/** The shortest a cut name or branch gets. */
const LABEL_MIN = 8;

/** `feat/2026-10-13-enhancements-unified` as `feat/2026-10-13…ements-unified` at 30. */
export function middleCut(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }

    const head = Math.ceil((max - 1) / 2);

    return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/** Whether the rows name their checkout: always, unless the one row is the session's own folder. */
export function namesCheckouts(shown: readonly Pick<GitBand, "root">[], own: string | undefined): boolean {
    return shown.length > 1 || (shown.length === 1 && shown[0]?.root !== own);
}

/** Columns a text takes in the terminal: one per character, as every symbol the band draws is narrow. */
function widthOf(text: string): number {
    return [...text].length;
}

/**
 * The checkout name and the branch, cut to `room` columns together. Both fit whole when they can; else the name
 * keeps up to 40% of the room and the branch the rest, each keeping its start and end.
 */
export function fitLabels(name: string | undefined, branch: string, room: number): { name?: string; branch: string } {
    const nameWidth = name === undefined ? 0 : widthOf(name);

    if (nameWidth + widthOf(branch) <= room) {
        return { name, branch };
    }

    const nameRoom = name === undefined ? 0 : Math.min(nameWidth, Math.max(LABEL_MIN, Math.floor(room * NAME_SHARE)));

    return {
        name: name === undefined ? undefined : middleCut(name, nameRoom),
        branch: middleCut(branch, Math.max(LABEL_MIN, room - nameRoom)),
    };
}

/** The PRs a band row shows: all but the ones the sidebar's `hide` took out. */
function shownPrs(band: GitBand): BandPr[] {
    return band.prs.filter((pr) => !pr.hidden);
}

/** How much a band row says after the branch: words, signs only, or signs with bare PR numbers. */
type Wording = "full" | "signs" | "bare";

/** The texts after the branch, in order: unpushed and unpulled, the changed files, their lines, then each PR. */
function countsOf(band: GitBand, wording: Wording): { sync: string; dirty: string; lines: string; prs: string[] } {
    const words = wording === "full";

    return {
        sync: [
            band.ahead ? `↑${band.ahead}${words ? " to push" : ""}` : "",
            band.behind ? `↓${band.behind}${words ? " to pull" : ""}` : "",
        ]
            .filter(Boolean)
            .join(words ? " · " : " "),
        dirty: band.dirty ? (words ? `${plural(band.dirty, "file")} changed` : `●${band.dirty}`) : "clean",
        lines: band.dirty && (band.added || band.removed) ? `+${band.added} −${band.removed}` : "",
        prs: shownPrs(band).map((pr) => `#${pr.number}${wording === "bare" ? "" : prNote(pr)}`),
    };
}

/** The columns a row's counts take: one of gap before each part, then `⎇ ` and the space after a name. */
function countsWidth(counts: ReturnType<typeof countsOf>, named: boolean): number {
    const parts = [counts.sync, counts.dirty, counts.lines, ...counts.prs].filter(Boolean);

    return parts.reduce((sum, part) => sum + widthOf(part) + 1, 0) + 2 + (named ? 1 : 0);
}

/**
 * The fullest wording whose counts leave the name and the branch their shortest cut: words when they fit
 * (`mods.git.labels: full`), else signs (`↑27 ↓2 ●13`), else signs with the PRs as bare numbers.
 */
export function wordingFor(band: GitBand, room: number, named: boolean, labelled: boolean): Wording {
    const need = LABEL_MIN * (named ? 2 : 1);
    const tries: Wording[] = labelled ? ["full", "signs", "bare"] : ["signs", "bare"];

    return tries.find((wording) => room - countsWidth(countsOf(band, wording), named) >= need) ?? "bare";
}

/**
 * The band's git rows, one per checkout; none while the band is off or has nothing yet. Each row fits `columns`,
 * the first one less `firstReserve` (the hooks chip beside it): the counts keep their width, in words while they
 * fit, else in signs, and the checkout name and the branch are cut to what is left. A row still too wide is cut at
 * the right edge; nothing wraps. Each PR is a Button (it inverts under the pointer, so it reads as one) that opens
 * the Git sidebar; the sidebar opens the PR in the browser or the hub.
 */
export async function gitRows(
    host: Host,
    ui: ElementTable,
    room: { columns: number; firstReserve: number }
): Promise<RenderElement[]> {
    const shown = rows;

    if (shown.length === 0 || !(await isOn(host))) {
        return [];
    }

    const { Box, Button, Text } = ui;
    const labelled = (await settingsOf(host)).git.labels === "full";
    const named = namesCheckouts(shown, ownRoot);
    const open = () => void host.togglePane(GIT_PANE, "Git");

    const widthAt = (index: number) => room.columns - (index === 0 ? room.firstReserve : 0);
    // Every row says its counts the same way: the shortest wording any row needs.
    const order: Wording[] = ["full", "signs", "bare"];
    const wording =
        order[
            Math.max(...shown.map((band, index) => order.indexOf(wordingFor(band, widthAt(index), named, labelled))))
        ] ?? "bare";

    return shown.map((band, index) => {
        const width = widthAt(index);
        const counts = countsOf(band, wording);
        const labels = fitLabels(
            named ? checkoutName(band.root) : undefined,
            band.branch,
            width - countsWidth(counts, named)
        );

        return (
            <Box key={`git-${band.root}`} flexDirection="row" gap={1} overflow="hidden">
                <Box flexShrink={0}>
                    <Button key="git-branch" plain onPress={open}>
                        {labels.name === undefined ? null : <Text color="cyan">{`${labels.name} `}</Text>}
                        <Text dimColor>⎇ </Text>
                        <Text bold>{labels.branch}</Text>
                    </Button>
                </Box>
                {counts.sync ? (
                    <Text color="yellow" wrap="truncate-end">
                        {counts.sync}
                    </Text>
                ) : null}
                <Text color={band.dirty ? "magenta" : undefined} dimColor={!band.dirty} wrap="truncate-end">
                    {counts.dirty}
                </Text>
                {counts.lines ? (
                    <Text wrap="truncate-end">
                        <Text color="green">{`+${band.added}`}</Text>
                        <Text> </Text>
                        <Text color="red">{`−${band.removed}`}</Text>
                    </Text>
                ) : null}
                {shownPrs(band).map((pr) => (
                    <Box key={`pr-${pr.number}`} flexShrink={0}>
                        <Button key={`pr-${pr.number}`} plain onPress={open}>
                            <Text color={prColor(pr)} underline>{`#${pr.number}`}</Text>
                            {wording === "bare" ? null : <Text color={prColor(pr)}>{prNote(pr)}</Text>}
                        </Button>
                    </Box>
                ))}
            </Box>
        );
    });
}

/** What the add field holds, and the folders it proposes for it. */
let addQuery = "";
let addFound: { path: string; from: string }[] = [];
let addAsked = 0;

async function proposeFolders(host: Host, typed: string): Promise<void> {
    const asked = ++addAsked;
    const found = await folderSuggestions(host, typed, 5);

    if (asked === addAsked) {
        addFound = found;
        host.redraw();
    }
}

/** Adds what the field holds: the folder typed, or else the first one proposed. */
async function addFolder(host: Host, typed: string): Promise<void> {
    const text = typed.trim();

    if (!text) {
        return;
    }

    let done = await addCheckout(host, text);

    if ("error" in done && addFound[0]) {
        done = await addCheckout(host, addFound[0].path);
    }

    if ("error" in done) {
        await pressed(host, "git-add", `Not added: ${done.error}`, false);
        return;
    }

    addQuery = "";
    addFound = [];
    await refresh(host, "sidebar add");
    await pressed(host, "git-add", `Added ${checkoutName(done.root)} (${done.root}) to this session's band`);
}

/** Runs `open` on a URL or a folder and says how it went. */
async function openAndSay(host: Host, key: string, target: string, done: string): Promise<void> {
    const run = await host.openUrl(target).catch((error: unknown) => error);
    const code = isRecord(run) && typeof run.exitCode === "number" ? run.exitCode : -1;

    await pressed(host, key, code === 0 ? done : `open ${target} failed (exit ${code})`, code === 0);
}

/** Why a checkout is in the band, in words. */
function whyText(band: GitBand): string {
    return band.why === "added"
        ? "added by hand"
        : band.why === "worked"
          ? "this session worked here"
          : "this session's own folder";
}

/** The Git sidebar's actions for one checkout: Finder, and remove or hide where the band can drop it. */
function checkoutActions(host: Host, band: GitBand, at: string): Pressable[] {
    const name = checkoutName(band.root);
    const finder: Pressable = {
        key: `${at}-finder`,
        label: "Finder",
        isDim: true,
        hint: `show ${band.root} in Finder`,
        onPress: () => void openAndSay(host, `${at}-finder`, band.root, `Opened ${band.root} in Finder`),
    };

    if (band.why === "added") {
        return [
            finder,
            {
                key: `${at}-remove`,
                label: "remove",
                isDim: true,
                hint: `take ${name} out of this session's band (you added it)`,
                onPress: () =>
                    void removeAdded(host, band.root)
                        .then(() => refresh(host, "sidebar remove"))
                        .then(() => pressed(host, `${at}-remove`, `Removed ${name} from this session's band`)),
            },
        ];
    }

    if (band.why === "worked") {
        return [
            finder,
            {
                key: `${at}-hide`,
                label: "hide",
                isDim: true,
                hint: `drop ${name} from this session's band until the session writes a file or changes git there again`,
                onPress: () =>
                    void hideCheckout(host, band.root)
                        .then(() => refresh(host, "sidebar hide"))
                        .then(() => pressed(host, `${at}-hide`, `Hid ${name} from this session's band`)),
            },
        ];
    }

    return [finder];
}

/** The Git sidebar's actions for one PR: open, hub, copy link, track or untrack, and hide or show for the branch's own. */
function prActions(
    host: Host,
    band: GitBand,
    pr: BandPr,
    at: string,
    lists: { probe: GenesisProbe; tracked: number[]; hidden: number[] }
): Pressable[] {
    const n = pr.number;
    const link = `[#${n} (${pr.title})](${pr.url})`;
    const hub = hubUrlOf(lists.probe, pr);
    const setList = async (key: string, list: number[], on: boolean) => {
        const next = on ? [...new Set([...list, n])] : list.filter((held) => held !== n);
        await host.storeSet(key, next);
        await logMod(host, "git", {
            event: key.startsWith("git-band-hidden") ? "hide" : "track",
            on,
            n,
            root: band.root,
        });
        await refresh(host, "sidebar");
    };
    const trackHint = pr.own
        ? pr.tracked
            ? `stop keeping #${n} after a branch switch; it still shows while ${band.branch} is checked out (hide takes it out now)`
            : `keep #${n} in this checkout's row after it leaves ${band.branch} (as /mod-git pr add ${n})`
        : `take #${n} out of this checkout's row`;
    const actions: Pressable[] = [
        {
            key: `${at}-open`,
            label: "open",
            isPrimary: true,
            hint: `open ${pr.url} in the browser`,
            onPress: () => void openAndSay(host, `${at}-open`, pr.url, `Opened #${n} in the browser`),
        },
        ...(hub
            ? [
                  {
                      key: `${at}-hub`,
                      label: "hub",
                      hint: `open #${n} in the GenesisTools hub`,
                      onPress: () => void openAndSay(host, `${at}-hub`, hub, `Opened #${n} in the hub`),
                  },
              ]
            : []),
        {
            key: `${at}-copy`,
            label: "copy link",
            isDim: true,
            hint: `copy ${link}`,
            onPress: () =>
                void host
                    .copy(link)
                    .then((result) =>
                        pressed(
                            host,
                            `${at}-copy`,
                            result.isCopied ? `Copied ${link}` : `Not copied: ${result.reason}`,
                            result.isCopied
                        )
                    ),
        },
        {
            key: `${at}-track`,
            label: pr.tracked ? "untrack" : "track",
            isDim: true,
            hint: trackHint,
            onPress: () =>
                void setList(storeKey(band.root), lists.tracked, !pr.tracked).then(() =>
                    pressed(
                        host,
                        `${at}-track`,
                        pr.tracked
                            ? pr.own
                                ? `#${n} is no longer kept after a branch switch; it shows while ${band.branch} is checked out`
                                : `#${n} is out of ${checkoutName(band.root)}'s row`
                            : `#${n} stays in ${checkoutName(band.root)}'s row after a branch switch`
                    )
                ),
        },
    ];

    if (pr.own) {
        actions.push({
            key: `${at}-hide`,
            label: pr.hidden ? "show" : "hide",
            isDim: true,
            hint: pr.hidden
                ? `put #${n} back in the band`
                : `take this branch's PR #${n} out of the band; it stays listed here, with show`,
            onPress: () =>
                void setList(hiddenKey(band.root), lists.hidden, !pr.hidden).then(() =>
                    pressed(host, `${at}-hide`, pr.hidden ? `#${n} is back in the band` : `#${n} is out of the band`)
                ),
        });
    }

    return actions;
}

/**
 * The Git sidebar: the add field with the folders it proposes, then per checkout its name and branch, its counts,
 * its actions, and each PR with its title, its state, its failing and pending checks, and its actions. A focused
 * Button says under its row what a press does; after a press that line says what happened.
 */
async function gitPane(host: Host, kit: Kit): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    // Every surface but the mobile app draws a field.
    const Input = "Input" in kit.ui ? kit.ui.Input : undefined;
    const shown = rows;
    const home = await host.env("HOME");
    const reload: Pressable = {
        key: "git-refresh",
        label: "refresh",
        isDim: true,
        hint: "read every checkout's git state and PRs again now",
        onPress: () => {
            ghCache.clear();
            void refresh(host, "sidebar").then(() =>
                pressed(host, "git-refresh", `Read ${plural(rows.length, "checkout")} again`)
            );
        },
    };
    const field: Pressable = {
        key: "git-add",
        label: "add",
        hint: "type a path (/ or ~/) or part of a folder name; Enter adds the folder typed, else the first one below",
        onPress: () => undefined,
    };
    const proposed: Pressable[] = addFound.map((found, index) => ({
        key: `git-add-${index}`,
        label: tilde(found.path, home),
        isDim: true,
        hint: `add ${found.path} (${found.from})`,
        onPress: () => void addFolder(host, found.path),
    }));
    const probe = await genesisProbe(host);
    const sections = await Promise.all(
        shown.map(async (band, index) => {
            const at = `git-${index}`;
            const lists = {
                probe,
                tracked: await trackedPrs(host, band.root),
                hidden: await hiddenPrs(host, band.root),
            };
            const counts = [
                `↑${band.ahead} to push`,
                `↓${band.behind} to pull`,
                band.dirty ? `${plural(band.dirty, "file")} changed +${band.added} −${band.removed}` : "clean",
                whyText(band),
                `read ${shortDuration(Date.now() - band.at)} ago`,
            ].join(" · ");

            return (
                <Box key={at} flexDirection="column" marginTop={1}>
                    {divider(kit)}
                    <Text wrap="truncate-end">
                        <Text color="cyan">{`${checkoutName(band.root)} `}</Text>
                        <Text bold>{band.branch}</Text>
                    </Text>
                    <Text dimColor wrap="wrap">
                        {counts}
                    </Text>
                    {actionRow(kit, checkoutActions(host, band, at))}
                    {band.prs.length === 0 ? dimNote(kit, "No pull request for this branch.") : null}
                    {band.prs.map((pr) => {
                        const failing = pr.checks.filter((check) => check.verdict === "fail");
                        const pending = pr.checks.filter((check) => check.verdict === "pending");
                        const why = [
                            pr.own ? "this branch's PR" : "tracked",
                            pr.own && pr.tracked ? "kept after a branch switch" : "",
                            pr.hidden ? "hidden from the band" : "",
                        ]
                            .filter(Boolean)
                            .join(", ");

                        return (
                            <Box key={`${at}-pr-${pr.number}`} flexDirection="column" marginTop={1} marginLeft={2}>
                                <Text wrap="wrap">
                                    <Text color={prColor(pr)} bold>{`#${pr.number} `}</Text>
                                    <Text bold dimColor={pr.hidden}>
                                        {pr.title}
                                    </Text>
                                </Text>
                                <Text dimColor wrap="wrap">
                                    {`${pr.state.toLowerCase()}${pr.draft ? " draft" : ""} · ${ciText(pr)} · ${why}`}
                                </Text>
                                {failing.map((check) => (
                                    <Text key={`fail-${check.name}`} color="red" wrap="truncate-end">
                                        {`✗ ${check.name}`}
                                    </Text>
                                ))}
                                {pending.slice(0, 6).map((check) => (
                                    <Text key={`pending-${check.name}`} color="yellow" wrap="truncate-end">
                                        {`… ${check.name}`}
                                    </Text>
                                ))}
                                {pending.length > 6 ? dimNote(kit, `… ${pending.length - 6} more pending`) : null}
                                {actionRow(kit, prActions(host, band, pr, `${at}-pr-${pr.number}`, lists))}
                            </Box>
                        );
                    })}
                </Box>
            );
        })
    );

    return sidebarFrame(
        kit,
        <Box flexDirection="column">
            {headerRow(kit, dimNote(kit, shown.length ? plural(shown.length, "checkout") : "No git reading yet."), [
                reload,
            ])}
            {hintLine(kit, [reload])}
            <Box marginTop={1}>
                {Input ? (
                    <Input
                        key="git-add"
                        label="add a folder"
                        placeholder="a path, or part of a folder name"
                        value={addQuery}
                        submitLabel="add"
                        onInput={(value: string) => {
                            addQuery = value;
                            void proposeFolders(host, value);
                        }}
                        onSubmit={(value: string) => void addFolder(host, value)}
                    />
                ) : (
                    dimNote(kit, "/mod-git add <folder> in the prompt adds a folder.")
                )}
            </Box>
            {proposed.map((row) =>
                listRow(
                    kit,
                    row,
                    <Text dimColor>{addFound[Number(row.key.slice("git-add-".length))]?.from ?? ""}</Text>
                )
            )}
            {hintLine(kit, [field, ...proposed])}
            {sections}
        </Box>
    );
}
