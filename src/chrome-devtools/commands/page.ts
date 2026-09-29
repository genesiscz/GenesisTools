/**
 * Page-agent verbs: read a tab the way a person sees it, then click, fill or scroll by label. These
 * replace chrome-devtools-mcp's take_snapshot / click / fill for anything in this repo: one in-page
 * read in an isolated world, a guard and hit test before every input, real Input events.
 */
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { findTargets, type TargetQuery, targetLabel } from "../lib/dom/find.ts";
import type { DomAction, DomSettled, DomSnapshot } from "../lib/dom/in-page.ts";
import { type DomActResult, DomPage } from "../lib/dom/page.ts";
import { pickTab, positiveNumber, suggest, withPage } from "./shared.ts";

const { log } = logger.scoped("chrome-devtools:page");

interface PageOpts {
    port?: string;
    match?: string;
    json?: boolean;
}

interface TargetOpts extends PageOpts {
    nth?: string;
    role?: string;
}

function matchArgs(opts: PageOpts): string[] {
    return opts.match ? ["--match", opts.match] : [];
}

function rowLine(action: DomAction): string {
    const role = action.kind === "select" ? "option" : action.role;
    const parts = [
        role.padEnd(10),
        action.kind === "select" ? `${action.label}: ${targetLabel(action)}` : action.label,
    ];
    if (action.kind === "select" && action.value === action.option?.label) {
        parts.push("(selected)");
    }

    if (action.kind === "fill") {
        parts.push(action.field?.secret ? "= (secret, never read)" : `= "${action.value ?? ""}"`);
    }

    if (action.checked !== undefined) {
        parts.push(action.checked ? "[x]" : "[ ]");
    }

    if (action.expanded !== undefined) {
        parts.push(action.expanded ? "(expanded)" : "(collapsed)");
    }

    if (action.href) {
        parts.push(`-> ${action.href.slice(0, 80)}`);
    }

    return `  ${parts.join(" ")}`;
}

async function openPage(opts: PageOpts): Promise<DomPage> {
    const { port, target } = await pickTab(opts);
    out.log.info(`tab: ${target.title || "(untitled)"} :: ${target.url}`);
    return DomPage.attach({ port, target });
}

/** One fresh read, then the row the label names; several matches refuse unless --nth picks one. */
async function chooseTarget(page: DomPage, query: TargetQuery, opts: TargetOpts): Promise<DomAction> {
    if (!query.text.trim()) {
        out.log.error("The label is empty. Name the control as `snapshot` prints it.");
        process.exit(1);
    }

    const snapshot = await page.snapshot();
    const matches = findTargets(snapshot, query);
    log.debug({ text: query.text, kinds: query.kinds, role: query.role, matches: matches.length }, "target lookup");
    if (matches.length === 0) {
        out.log.error(`No control in view is labelled "${query.text}".`);
        const below = snapshot.belowFoldLabels.filter((label) =>
            label.toLowerCase().includes(query.text.toLowerCase())
        );
        if (below.length > 0) {
            out.log.info(`It is below the fold. Scroll first: ${suggest(["scroll", "down", ...matchArgs(opts)])}`);
        }

        out.log.info(`  see what is in view: ${suggest(["snapshot", ...matchArgs(opts)])}`);
        process.exit(1);
    }

    const nth = opts.nth === undefined ? undefined : positiveNumber(opts.nth, 1, "--nth");
    if (matches.length > 1 && nth === undefined) {
        out.log.error(`${matches.length} controls match "${query.text}". Refusing to guess which one you meant.`);
        out.log.info(matches.map((action, index) => `  [${index + 1}]${rowLine(action)}`).join("\n"));
        out.log.info(`  pick one: ${suggest([...process.argv.slice(2), "--nth", "2"])}`);
        process.exit(1);
    }

    const chosen = matches[(nth ?? 1) - 1];
    if (!chosen) {
        out.log.error(`--nth ${nth} is past the ${matches.length} match(es) for "${query.text}".`);
        process.exit(1);
    }

    return chosen;
}

function settledText(settled: DomSettled | "navigated"): string {
    if (settled === "navigated") {
        return "the page navigated";
    }

    if (settled.mutations === 0) {
        return `nothing on the page changed within ${settled.ms} ms`;
    }

    return settled.reason === "quiet"
        ? `the page changed and went quiet after ${settled.ms} ms`
        : `the page was still changing at the ${settled.ms} ms cap`;
}

function report(result: DomActResult, action: DomAction, verb: string, opts: PageOpts): never {
    const role = action.kind === "select" ? "option" : action.role;
    log.debug({ verb, role, label: targetLabel(action), result }, "page verb finished");
    if (opts.json) {
        out.result({ ...result, target: { role, label: targetLabel(action) } });
        process.exit(result.ok ? 0 : 1);
    }

    if (!result.ok) {
        out.log.error(`${verb} "${targetLabel(action)}" refused: ${result.error}`);
        if (result.dispatched) {
            out.log.warn("Input was already sent when it failed, so the page may have changed. Read it again.");
        }

        process.exit(1);
    }

    out.log.success(`${verb} ${role} "${targetLabel(action)}": ${settledText(result.settled)}`);
    process.exit(0);
}

function printSnapshot(snapshot: DomSnapshot, withText: boolean): void {
    out.println(`${snapshot.title || "(untitled)"} :: ${snapshot.url}`);
    out.println(snapshot.actions.length ? snapshot.actions.map(rowLine).join("\n") : "  (no controls in view)");
    if (snapshot.omitted > 0) {
        out.println(`  … ${snapshot.omitted} more controls in view past the cap`);
    }

    if (snapshot.belowFold > 0) {
        const named = snapshot.belowFoldLabels.slice(0, 10).join(", ");
        out.println(`  ${snapshot.belowFold} more below the fold${named ? `: ${named}` : ""}`);
    }

    if (withText) {
        out.println("");
        out.println(snapshot.text);
    }
}

export function registerPage(program: Command): void {
    const examples = `
Examples:
  ${suggest(["snapshot", "--match", "youtube.com"])}
  ${suggest(["click", "Summarize", "--match", "youtube.com"])}
  ${suggest(["click", "Express", "--role", "option", "--match", "shop.example.com"])}
  ${suggest(["fill", "Search", "night owls", "--match", "youtube.com"])}

Controls are named by their label, as snapshot prints them. Node ids are not accepted: they belong
to one read's isolated world, and every command is a new process with a new world.`;

    withPage(program.command("snapshot"))
        .description(
            "what a person sees in the tab: its controls (role, label, value) and, with --text, its visible text. Reads open shadow roots; never reads a secret field's value"
        )
        .option("--text", "also print the visible text")
        .option("--json", "print the whole read as JSON")
        .addHelpText("after", examples)
        .action(async (opts: PageOpts & { text?: boolean }) => {
            const page = await openPage(opts);
            const snapshot = await page.snapshot();
            page.close();
            log.debug({ url: snapshot.url, actions: snapshot.actions.length }, "snapshot read");
            if (opts.json) {
                out.result(snapshot);
            } else {
                printSnapshot(snapshot, opts.text === true);
            }

            process.exit(0);
        });

    withPage(program.command("click"))
        .description(
            "click a control by its label: re-checked and hit-tested right before a real mouse click. An option's label picks that option"
        )
        .argument("<label>", "the control's label as snapshot prints it (exact first, then a substring)")
        .option("--nth <n>", "which match when several controls carry the label (1-based)")
        .option("--role <role>", "only controls with this role: button, link, checkbox, option, ...")
        .option("--json", "print the result as JSON")
        .addHelpText("after", examples)
        .action(async (label: string, opts: TargetOpts) => {
            const page = await openPage(opts);
            const action = await chooseTarget(page, { text: label, kinds: ["click", "select"], role: opts.role }, opts);
            const result = action.kind === "select" ? await page.select(action) : await page.click(action);
            page.close();
            report(result, action, "click", opts);
        });

    withPage(program.command("fill"))
        .description("replace a field's text by its label, then read it back inside the page")
        .argument("<label>", "the field's label as snapshot prints it")
        .argument("[text]", "the new text (or --stdin)")
        .option("--stdin", "read the text from stdin, which keeps it out of shell history")
        .option("--nth <n>", "which match when several fields carry the label (1-based)")
        .option("--json", "print the result as JSON")
        .addHelpText("after", examples)
        .action(async (label: string, text: string | undefined, opts: TargetOpts & { stdin?: boolean }) => {
            const value = opts.stdin ? (await Bun.stdin.text()).replace(/\r?\n$/, "") : text;
            if (value === undefined) {
                out.log.error("fill needs the text as an argument or on stdin with --stdin.");
                out.log.info(`  e.g. ${suggest(["fill", label, "<text>", ...matchArgs(opts)])}`);
                process.exit(1);
            }

            const page = await openPage(opts);
            const action = await chooseTarget(page, { text: label, kinds: ["fill"] }, opts);
            const result = await page.fill(action, value);
            page.close();
            report(result, action, "fill", opts);
        });

    withPage(program.command("scroll"))
        .description("scroll the tab by most of a screen, so controls below the fold come into view")
        .argument("[direction]", "down or up", "down")
        .action(async (direction: string, opts: PageOpts) => {
            if (direction !== "down" && direction !== "up") {
                out.log.error(`direction must be down or up, got '${direction}'.`);
                out.log.info(`  e.g. ${suggest(["scroll", "down", ...matchArgs(opts)])}`);
                process.exit(1);
            }

            const page = await openPage(opts);
            const result = await page.scroll(direction === "down" ? 1 : -1);
            page.close();
            if (!result.ok) {
                out.log.error(`scroll ${direction} failed: ${result.error}`);
                process.exit(1);
            }

            out.log.success(`scrolled ${direction}`);
            process.exit(0);
        });
}
