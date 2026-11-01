import { toolCommand } from "@genesiscz/utils/cli";
import { formatBytes, formatClock } from "@genesiscz/utils/format";
import {
    type RmCaller,
    type RmRequest,
    type RmRequestLive,
    type RmRequestTarget,
    type RmTargetLiveState,
    requestBatchIds,
    requestLive,
    requestsAlsoNaming,
} from "@genesiscz/utils/rm";
import { type DotStatusKind, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";
import { displayContext, formatAgeCell, middleCut, shortRmPath } from "./display";

/** One request as the listing shows it: its live state on disk, its sizes, and the other requests naming its paths. */
export interface RequestView {
    request: RmRequest;
    live: RmRequestLive;
    /** Bytes per entry of `request.targets`; undefined when not measured. */
    sizes: (number | undefined)[];
    /** Other pending requests that name one of this request's in-place paths. */
    alsoIn: string[];
}

export interface RequestViewDeps {
    present?: (path: string) => boolean;
    sizeOf: (request: RmRequest, target: RmRequestTarget) => number | undefined;
}

export function buildRequestViews(requests: readonly RmRequest[], deps: RequestViewDeps): RequestView[] {
    const pending = requests.filter((request) => request.status === "pending");
    return requests.map((request) => {
        const inPlace = request.targets.filter((target) => !target.stored).map((target) => target.path);
        const also = requestsAlsoNaming(inPlace, request.id, pending);
        return {
            request,
            live: requestLive(request, deps.present),
            sizes: request.targets.map((target) => deps.sizeOf(request, target)),
            alsoIn: [...new Set([...also.values()].flat())].sort(),
        };
    });
}

export interface RequestListOptions {
    now: Date;
    /** Who reads the list: an agent gets the agent's footer. */
    caller: RmCaller;
    /** A flat list in this order instead of groups per session. */
    sort?: "age" | "size";
    /** One row per path instead of one per request. */
    paths?: boolean;
}

const PATH_MAX = 40;

const WHY_MAX = 36;

const NO_RULE_LEGEND = "no rule = not a preset, not the asker's scratch or own files, not in a trusted root";

function sum(values: readonly (number | undefined)[]): number | undefined {
    const known = values.filter((value): value is number => value !== undefined);
    return known.length === 0 ? undefined : known.reduce((total, value) => total + value, 0);
}

function sizeCell(bytes: number | undefined): string {
    return (bytes === undefined ? "-" : formatBytes(bytes)).padStart(9);
}

function ageCell(createdAt: string, now: Date): string {
    const age = formatAgeCell(createdAt, now);
    const text = age.text.padStart(4);
    return age.level === "old" ? pc.red(text) : age.level === "day" ? pc.yellow(text) : text;
}

const TARGET_STATE: Record<RmTargetLiveState, { kind: DotStatusKind; label: string }> = {
    aside: { kind: "dim", label: "aside" },
    "in-place": { kind: "dim", label: "in place" },
    "came-back": { kind: "warn", label: "came back" },
    "copy-lost": { kind: "err", label: "copy lost" },
    gone: { kind: "warn", label: "gone" },
};

function stateCell(live: RmRequestLive): string {
    const { kind, label } =
        live.state === "waiting"
            ? { kind: "dim" as const, label: live.inPlace === 0 ? "aside" : live.aside === 0 ? "in place" : "mixed" }
            : TARGET_STATE[live.state];
    return formatDotStatus(kind, label.padEnd(9));
}

function decidedText(request: RmRequest): string | null {
    if (!request.decidedAt) {
        return null;
    }

    const approved = request.decided?.approved.length ?? 0;
    return `${approved} approved ${formatClock(request.decidedAt, { date: "short" })} via ${request.decidedVia ?? "?"}`;
}

/** The row's short form of a decision so far: "approved 4, Oct 31". */
function decidedShort(request: RmRequest): string {
    if (!request.decidedAt) {
        return "";
    }

    const date = formatClock(request.decidedAt, { date: "short" }).split(",")[0] ?? "";
    return `approved ${request.decided?.approved.length ?? 0}, ${date}`;
}

function whyCell(view: RequestView): string {
    const rules = [...new Set(view.request.targets.map((target) => target.rule))].filter((rule) => rule !== "default");
    const parts = [
        decidedShort(view.request),
        rules.join(","),
        view.live.state === "waiting" && view.live.gone > 0 ? `${view.live.gone} gone` : "",
        view.alsoIn.length > 0 ? `same path as ${view.alsoIn.join(" ")}` : "",
    ].filter((part) => part !== "");
    return parts.length === 0 ? "" : truncateDisplay(parts.join(" · "), WHY_MAX);
}

function sessionKey(request: RmRequest): string {
    return request.caller?.sessionId ?? "person";
}

function requestRow(view: RequestView, now: Date, withSession: boolean): string {
    const { request } = view;
    const first = request.targets[0];
    const path = first ? shortRmPath(first.path, displayContext(request.caller), PATH_MAX) : "-";
    const more = request.targets.length > 1 ? ` +${request.targets.length - 1}` : "";
    const why = whyCell(view);
    const session = withSession ? `${sessionKey(request).slice(0, 8).padEnd(8)}  ` : "";
    return (
        `    ${pc.bold(request.id)}  ${session}${ageCell(request.createdAt, now)}  ${sizeCell(sum(view.sizes))}  ` +
        `${stateCell(view.live)}  ${path}${more}${why ? `  ${pc.dim(why)}` : ""}`
    );
}

/** One request as a single line, as the picker of `tools rm approve` offers it: id, age, size, state, path, why. */
export function renderRequestRow(view: RequestView, now: Date): string {
    return requestRow(view, now, false).trimStart();
}

function pathRows(view: RequestView, now: Date): string[] {
    const { request } = view;
    return request.targets.map((target, index) => {
        const state = TARGET_STATE[view.live.targets[index] ?? "gone"];
        const rule = target.rule === "default" ? "" : `  ${pc.dim(target.rule)}`;
        return (
            `    ${pc.bold(request.id)}  ${ageCell(request.createdAt, now)}  ${sizeCell(view.sizes[index])}  ` +
            `${formatDotStatus(state.kind, state.label.padEnd(9))}  ${shortRmPath(target.path, displayContext(request.caller), PATH_MAX)}${rule}`
        );
    });
}

function summaryLines(views: readonly RequestView[], now: Date): string[] {
    const targets = views.flatMap((view) =>
        view.request.targets.map((target, index) => ({ target, bytes: view.sizes[index] }))
    );
    const asideBytes = sum(targets.filter(({ target }) => target.stored).map(({ bytes }) => bytes)) ?? 0;
    const inPlace = targets.filter(({ target }) => !target.stored).length;
    const oldest = views.reduce(
        (min, view) => (view.request.createdAt < min ? view.request.createdAt : min),
        now.toISOString()
    );
    const paths = `${targets.length} path${targets.length === 1 ? "" : "s"}`;
    const head =
        `${pc.bold("rm requests")}  ${views.length} open · ${paths} · ${formatBytes(asideBytes)} aside · ` +
        `${inPlace} in place · oldest ${formatAgeCell(oldest, now).text}`;
    const ids = (state: RmRequestLive["state"]) =>
        views.filter((view) => view.live.state === state).map((view) => view.request.id);
    const twice = [
        ...new Set(
            views
                .filter((view) => view.alsoIn.length > 0)
                .map((view) => [view.request.id, ...view.alsoIn].sort().join(" = "))
        ),
    ];
    const look = [
        ids("gone").length > 0 ? `${ids("gone").length} gone (${ids("gone").join(" ")})` : "",
        ids("copy-lost").length > 0 ? `${ids("copy-lost").length} copy lost (${ids("copy-lost").join(" ")})` : "",
        ids("came-back").length > 0 ? `${ids("came-back").length} came back (${ids("came-back").join(" ")})` : "",
        twice.length > 0 ? `${twice.length} asked twice (${twice.join(", ")})` : "",
    ].filter((part) => part !== "");
    return look.length > 0 ? [head, `${pc.yellow("Needs a look:")} ${look.join(" · ")}`] : [head];
}

function footerLines(views: readonly RequestView[], caller: RmCaller): string[] {
    const rm = toolCommand("rm");
    const footer = caller.isInAgent
        ? `The user approves: ! ${rm} approve <id>   Cancel your own: ${rm} deny <id>   Detail: ${rm} requests <id>`
        : `Approve: ${rm} approve <id>   Detail: ${rm} requests <id>   Close gone and expired: ${rm} prune`;
    const anyDefault = views.some((view) => view.request.targets.some((target) => target.rule === "default"));
    return anyDefault ? [footer, pc.dim(NO_RULE_LEGEND)] : [footer];
}

/** The listing: a summary, then one group per asking session (newest first), then the next commands. */
export function renderRequestList(views: readonly RequestView[], options: RequestListOptions): string[] {
    const { now } = options;
    const lines = [...summaryLines(views, now), ""];

    if (options.sort) {
        const bytes = (view: RequestView) => sum(view.sizes) ?? -1;
        const sorted = [...views].sort((a, b) =>
            options.sort === "size" ? bytes(b) - bytes(a) : a.request.createdAt.localeCompare(b.request.createdAt)
        );
        lines.push(...sorted.flatMap((view) => (options.paths ? pathRows(view, now) : [requestRow(view, now, true)])));
        lines.push("");
    } else {
        const groups = new Map<string, RequestView[]>();

        for (const view of [...views].sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt))) {
            const key = sessionKey(view.request);
            groups.set(key, [...(groups.get(key) ?? []), view]);
        }

        for (const [key, group] of groups) {
            const caller = group[0]?.request.caller ?? null;
            const who = [caller?.agent ?? "person", caller?.project].filter(Boolean).join(" · ");
            const title = middleCut(caller?.sessionTitle ?? "(no title)", 40);
            const size = sum(group.flatMap((view) => view.sizes));
            const count = `${group.length} request${group.length === 1 ? "" : "s"}`;
            lines.push(
                `  ${pc.bold(key.slice(0, 8))} ${title} · ${who}   ${pc.dim(`${count} · ${size === undefined ? "-" : formatBytes(size)}`)}`
            );
            lines.push(
                ...group.flatMap((view) => (options.paths ? pathRows(view, now) : [requestRow(view, now, false)]))
            );
            lines.push("");
        }
    }

    return [...lines, ...footerLines(views, options.caller)];
}

/** The long form of one request: every path with its stored copy, rule and reason, and the decision so far. */
export function renderRequestDetail(view: RequestView, now: Date): string[] {
    const { request } = view;
    const caller = request.caller;
    const asked = `${formatClock(request.createdAt, { date: "short" })} (${formatAgeCell(request.createdAt, now).text} ago)`;
    const by = caller
        ? [
              caller.agent,
              caller.sessionId,
              caller.sessionTitle ? `"${caller.sessionTitle}"` : null,
              caller.project,
              caller.branch,
          ]
              .filter(Boolean)
              .join(" · ")
        : "a person";
    const lines = [
        `${pc.bold(request.id)}  ${request.kind}  ${request.status}  asked ${asked}`,
        `  by       ${by}`,
        `  why      ${request.reason ?? pc.dim("(no reason given)")}`,
    ];
    const decided = decidedText(request);

    if (decided) {
        const denied = request.decided?.denied.length ?? 0;
        const batches = requestBatchIds(request);
        lines.push(
            `  decided  ${decided}, ${denied} denied${batches.length > 0 ? `; batches ${batches.join(", ")}` : ""}`
        );
    }

    if (request.deniedNote) {
        lines.push(`  note     ${request.deniedNote}`);
    }

    lines.push("  paths");

    request.targets.forEach((target, index) => {
        const state = TARGET_STATE[view.live.targets[index] ?? "gone"];
        lines.push(
            `    ${formatDotStatus(state.kind, state.label.padEnd(9))} ${sizeCell(view.sizes[index])}  ${target.path}`
        );
        lines.push(pc.dim(`        ${target.rule}: ${target.reason}`));

        if (target.stored) {
            lines.push(pc.dim(`        stored at ${target.stored}`));
        }
    });

    return lines;
}
