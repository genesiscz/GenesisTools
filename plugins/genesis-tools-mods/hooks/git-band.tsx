// The git band: one line above the prompt per checkout the session works in (`checkouts.ts`: the ones it wrote
// files in or changed git state in, the last first, up to `mods.git.checkouts`), each with the branch, unpushed and
// unpulled commits, the dirty count, and the pull requests that matter there (the branch's, plus the ones
// `/mod-git pr add` tracks) with their CI counts. A session that has worked in no checkout yet shows its own
// folder; `mods.git.cwd: always` shows that folder first in every session. It refreshes when the session starts,
// after a Bash call that ran git or gh, after a call that works in another checkout, every 3 minutes, and on
// `/mod-git refresh`; `gh` answers are reused for 2 minutes. `/mod-git on|off|toggle` switches it for this
// session, `mods.git.enabled` for every session. Each refresh and command goes to `mods-log/git.jsonl`.
import type { ElementTable, RenderElement } from "claude-code";
import type { BandCheck, BandPr, GitBand, GitBandRows, GitBandSwitch } from "../types";
import { noteToolCall, pickRoots, sessionCheckouts } from "./checkouts";
import { type GenesisProbe, genesisProbe, hubLink } from "./genesis";
import { type Feature, type Host, isRecord, logMod, settingsOf, shortDuration } from "./shared";
import { actionRow, dimNote, divider, headerRow, type Kit, plural, sidebarFrame } from "./sidebar";

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

/** The checkouts the band shows now, the session's last first. */
async function bandRoots(host: Host): Promise<string[]> {
    ownRoot = await cwdRoot(host);

    return pickRoots(await sessionCheckouts(host), ownRoot, (await settingsOf(host)).git);
}

/** The checkout `/mod-git pr` and the sidebar's track act on: the band's first row. */
async function firstRoot(host: Host): Promise<string | undefined> {
    return rows[0]?.root ?? (await bandRoots(host))[0];
}

/** A checkout's folder name: `col-fe-marketplace-2.0-poc`. */
export function checkoutName(root: string): string {
    return root.slice(root.lastIndexOf("/") + 1) || root;
}

const storeKey = (root: string) => `git-band-prs:${root}`;

export async function trackedPrs(host: Host, root: string): Promise<number[]> {
    const held = await host.storeGet(storeKey(root));

    return Array.isArray(held) ? held.filter((n): n is number => typeof n === "number") : [];
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
async function readRow(host: Host, root: string): Promise<GitBand | undefined> {
    const status = await run(host, ["git", "status", "--porcelain", "--branch"], root);

    if (status === undefined) {
        return undefined;
    }

    const numstat = parseNumstat((await run(host, ["git", "diff", "--numstat", "HEAD"], root)) ?? "");
    const tracked = await trackedPrs(host, root);
    const own = await prOf(host, root, "", false);
    const others = await Promise.all(
        tracked.filter((n) => n !== own?.number).map((n) => prOf(host, root, String(n), true))
    );
    const prs = [own ? { ...own, tracked: tracked.includes(own.number) } : null, ...others].filter(
        (pr): pr is BandPr => pr !== null
    );

    return { root, at: Date.now(), ...parseStatus(status), ...numstat, prs };
}

async function refreshNow(host: Host, why: string): Promise<void> {
    const started = Date.now();
    const roots = await bandRoots(host);
    const read = await Promise.all(roots.map((root) => readRow(host, root)));
    // A checkout git could not read this time keeps its last row.
    const next = roots
        .map((root, index) => read[index] ?? rows.find((row) => row.root === root))
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

const USAGE = "/mod-git [show] | on | off | toggle | refresh | status | pr add <n…> | pr rm <n…> | pr list";

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
                "The git band: no argument opens its sidebar; on, off, toggle, refresh, status, pr add <n>, pr rm <n>, pr list",
            argumentHint: "on|off|toggle|refresh|status|pr add <n>",
            async run(host, args) {
                const text = await command(host, args);
                await logMod(host, "git", { event: "command", args, answer: text });

                return text ? { text } : {};
            },
        },
    ],
    sidebars: [{ id: GIT_PANE, title: "Git", draw: gitPane }],
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

/** A branch longer than this keeps its start and end, so the hooks chip at the right keeps its room. */
const BRANCH_MAX = 32;

/** `feat/2026-10-13-enhancements-unified` as `feat/2026-10-13…ements-unified` at 30. */
export function middleCut(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }

    const head = Math.ceil((max - 1) / 2);

    return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/** A checkout name longer than this keeps its start and end. */
const NAME_MAX = 28;

/** Whether the rows name their checkout: always, unless the one row is the session's own folder. */
export function namesCheckouts(shown: readonly Pick<GitBand, "root">[], own: string | undefined): boolean {
    return shown.length > 1 || (shown.length === 1 && shown[0]?.root !== own);
}

/**
 * The band's git rows, one per checkout, or null while the band is off or has nothing yet. Each PR is a Button (it
 * inverts under the pointer, so it reads as one) that opens the Git sidebar; the sidebar opens the PR in the browser
 * or the hub.
 */
export async function gitRow(host: Host, ui: ElementTable): Promise<RenderElement | null> {
    const shown = rows;

    if (shown.length === 0 || !(await isOn(host))) {
        return null;
    }

    const { Box, Button, Text } = ui;
    const labelled = (await settingsOf(host)).git.labels === "full";
    const named = namesCheckouts(shown, ownRoot);
    const open = () => void host.togglePane(GIT_PANE, "Git");
    const rowOf = (band: GitBand) => {
        const sync = [
            band.ahead ? `↑${band.ahead}${labelled ? " to push" : ""}` : "",
            band.behind ? `↓${band.behind}${labelled ? " to pull" : ""}` : "",
        ]
            .filter(Boolean)
            .join(labelled ? " · " : " ");
        const lines =
            band.added || band.removed ? (
                <Text>
                    <Text color="green">{`+${band.added}`}</Text>
                    <Text> </Text>
                    <Text color="red">{`−${band.removed}`}</Text>
                </Text>
            ) : null;

        return (
            <Box key={`git-${band.root}`} flexDirection="row" gap={1}>
                <Button key="git-branch" plain onPress={open}>
                    {named ? <Text color="cyan">{`${middleCut(checkoutName(band.root), NAME_MAX)} `}</Text> : null}
                    <Text dimColor>⎇ </Text>
                    <Text bold>{middleCut(band.branch, BRANCH_MAX)}</Text>
                </Button>
                {sync ? <Text color="yellow">{sync}</Text> : null}
                {band.dirty ? (
                    <Text color="magenta">{labelled ? `${plural(band.dirty, "file")} changed` : `●${band.dirty}`}</Text>
                ) : (
                    <Text dimColor>clean</Text>
                )}
                {band.dirty ? lines : null}
                {band.prs.map((pr) => (
                    <Button key={`pr-${pr.number}`} plain onPress={open}>
                        <Text color={prColor(pr)} underline>{`#${pr.number}`}</Text>
                        <Text color={prColor(pr)}>{prNote(pr)}</Text>
                    </Button>
                ))}
            </Box>
        );
    };

    return (
        <Box key="git-band" flexDirection="column">
            {shown.map(rowOf)}
        </Box>
    );
}

/**
 * The Git sidebar: per checkout, its branch, then each PR with its title, its failing and pending checks, and its
 * actions.
 */
async function gitPane(host: Host, kit: Kit): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    const shown = rows;
    const reload = {
        key: "git-refresh",
        label: "refresh",
        isDim: true,
        onPress: () => {
            ghCache.clear();
            void refresh(host, "sidebar");
        },
    };

    if (shown.length === 0) {
        return sidebarFrame(kit, headerRow(kit, dimNote(kit, "No git reading yet."), [reload]));
    }

    const probe = await genesisProbe(host);
    const named = namesCheckouts(shown, ownRoot);
    const sections = await Promise.all(
        shown.map(async (band, index) => {
            const tracked = await trackedPrs(host, band.root);
            const setTracked = async (n: number, on: boolean) => {
                const next = on ? [...new Set([...tracked, n])] : tracked.filter((held) => held !== n);
                await host.storeSet(storeKey(band.root), next);
                await logMod(host, "git", { event: on ? "track" : "untrack", n, root: band.root, from: "sidebar" });
                await refresh(host, "sidebar");
            };
            const sync = [
                `↑${band.ahead} to push`,
                `↓${band.behind} to pull`,
                band.dirty ? `${plural(band.dirty, "file")} changed +${band.added} −${band.removed}` : "clean",
            ].join(" · ");
            const at = `git-${index}`;

            return (
                <Box key={at} flexDirection="column" marginTop={index ? 1 : 0}>
                    {index ? divider(kit) : null}
                    {headerRow(
                        kit,
                        <Text wrap="truncate-end">
                            {named ? <Text color="cyan">{`${checkoutName(band.root)} `}</Text> : null}
                            <Text bold>{band.branch}</Text>
                            <Text dimColor>{` ${sync} · read ${shortDuration(Date.now() - band.at)} ago`}</Text>
                        </Text>,
                        index ? [] : [reload]
                    )}
                    {band.prs.length === 0
                        ? dimNote(
                              kit,
                              index ? "No pull request here." : "No pull request here. /mod-git pr add <n> tracks one."
                          )
                        : null}
                    {band.prs.map((pr) => {
                        const hub = hubUrlOf(probe, pr);
                        const failing = pr.checks.filter((check) => check.verdict === "fail");
                        const pending = pr.checks.filter((check) => check.verdict === "pending");

                        return (
                            <Box key={`${at}-pr-${pr.number}`} flexDirection="column" marginTop={1}>
                                {divider(kit)}
                                <Text wrap="wrap">
                                    <Text color={prColor(pr)} bold>{`#${pr.number} `}</Text>
                                    <Text bold>{pr.title}</Text>
                                </Text>
                                {dimNote(kit, `${pr.state.toLowerCase()}${pr.draft ? " draft" : ""} · ${ciText(pr)}`)}
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
                                <Box marginTop={1}>
                                    {actionRow(kit, [
                                        {
                                            key: `${at}-pr-${pr.number}-open`,
                                            label: "open",
                                            isPrimary: true,
                                            onPress: () => void host.openUrl(pr.url),
                                        },
                                        ...(hub
                                            ? [
                                                  {
                                                      key: `${at}-pr-${pr.number}-hub`,
                                                      label: "hub",
                                                      onPress: () => void host.openUrl(hub),
                                                  },
                                              ]
                                            : []),
                                        {
                                            key: `${at}-pr-${pr.number}-copy`,
                                            label: "copy link",
                                            isDim: true,
                                            onPress: () => void host.copy(`[#${pr.number} (${pr.title})](${pr.url})`),
                                        },
                                        tracked.includes(pr.number)
                                            ? {
                                                  key: `${at}-pr-${pr.number}-untrack`,
                                                  label: "untrack",
                                                  isDim: true,
                                                  onPress: () => void setTracked(pr.number, false),
                                              }
                                            : {
                                                  key: `${at}-pr-${pr.number}-track`,
                                                  label: "track",
                                                  isDim: true,
                                                  onPress: () => void setTracked(pr.number, true),
                                              },
                                    ])}
                                </Box>
                            </Box>
                        );
                    })}
                </Box>
            );
        })
    );

    return sidebarFrame(kit, <Box flexDirection="column">{sections}</Box>);
}
