import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineAction, defineArea, type Fix, type FixDecision } from "@genesiscz/utils/genesis-tools/actions/define";
import { defaultBuildCommand } from "@genesiscz/utils/genesis-tools/app-builder";
import { APP_FACES } from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";
import { Need, type NeedSpec } from "@genesiscz/utils/genesis-tools/capability/needs";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { shellWord } from "@genesiscz/utils/shell/quote";
import { z } from "zod";

// The short-lived permission dialog is a host command, outside the lifecycle table of app faces.
const OPEN_WINDOWS = { ...APP_FACES, "--permission-dialog": { part: null } } as const;
type OpenWindowFlag = keyof typeof OPEN_WINDOWS;
const FACE_FLAGS = Object.keys(OPEN_WINDOWS) as [OpenWindowFlag, ...OpenWindowFlag[]];

/** `open` returns once Launch Services handed the flags over; a slower answer means it hangs. */
const OPEN_TIMEOUT_MS = 15_000;

export function windowFailureMessage(failure: { reason: string; fix?: Fix | null }): string {
    return failure.fix ? `${failure.reason}\n${failure.fix.command}` : failure.reason;
}

/** Some older hub builds lack the diff viewer the review window uses to display a proposal. */
export function reviewResourcesProblem(bundle: string): string | undefined {
    if (!existsSync(join(bundle, "Contents", "Resources", "diff-viewer", "index.html"))) {
        return `GenesisTools.app has no bundled diff viewer.\n${defaultBuildCommand("hub")}`;
    }

    return undefined;
}

/**
 * The needs of opening a face: macOS, the bundle, the part that ships the face, and a person who can see it. `open`
 * starts the bundle itself, so routing switched off blocks no face: `--window` holds the switch that turns it back on.
 */
function openNeeds(flag: OpenWindowFlag): NeedSpec[] {
    const part = OPEN_WINDOWS[flag].part;
    return [Need.platform.darwin, Need.app.bundle, ...(part ? [Need.app.part(part)] : []), Need.person.display];
}

/** The argv of `open`: `-n` hands the flags to a running face too, `-g` keeps the caller in front. */
export function windowOpenArgv(params: {
    window: OpenWindowFlag;
    args: readonly string[];
    activate: boolean;
    wait?: boolean;
}): string[] {
    return [
        "/usr/bin/open",
        "-n",
        ...(params.wait ? ["-W"] : []),
        ...(params.activate ? [] : ["-g"]),
        genesisAppBundlePath(),
        "--args",
        params.window,
        ...params.args,
    ];
}

const fixPolicy = z.enum(["skip", "offer", "build"]);

const openArgs = z.object({
    window: z.enum(FACE_FLAGS),
    args: z.array(z.string()).default([]),
    activate: z.boolean().default(true),
    wait: z.boolean().optional(),
    /**
     * `skip`: this call never builds a missing part, whatever `windows.fix` says. A notification click sends it: the
     * click is killed after 30 s, and the service it reaches may run in a terminal of its own.
     */
    fix: z.literal("skip").optional(),
});

/** The windows of GenesisTools.app: opening a face checks that the installed build ships it. */
export const windows = defineArea({
    area: "windows",
    summary: "Open a window (face) of GenesisTools.app",
    config: z.object({
        /** When the face's part is not built: skip, ask in the terminal, or build without asking. */
        fix: fixPolicy.default("offer"),
    }),
    actions: {
        open: defineAction({
            timeoutMs: 600_000,
            summary: "Open a GenesisTools.app window: --hub, --meetings, --recorder, --window and the other faces",
            args: openArgs,
            result: z.object({ window: z.enum(FACE_FLAGS), opened: z.literal(true) }),
            config: z.object({ fix: fixPolicy.optional() }),
            native: {
                needs: (args) => openNeeds(args.window),
                run: async (ctx) => {
                    if (ctx.args.window === "--review") {
                        const problem = reviewResourcesProblem(genesisAppBundlePath());
                        if (problem) {
                            throw new Error(problem);
                        }
                    }

                    logger.debug({ window: ctx.args.window, args: ctx.args.args }, "windows.open: opening a face");
                    const argv = windowOpenArgv(ctx.args);
                    const proc = Bun.spawn(argv, {
                        stdout: "ignore",
                        stderr: "pipe",
                        timeout: ctx.args.wait ? ctx.timeoutMs : Math.min(OPEN_TIMEOUT_MS, ctx.timeoutMs),
                    });
                    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

                    if (code !== 0) {
                        throw new Error(`open exited ${code}: ${stderr.trim()}`);
                    }

                    return { window: ctx.args.window, opened: true as const };
                },
            },
            fix: (ctx): FixDecision => {
                const policy = ctx.args.fix ?? ctx.config.fix ?? "offer";
                const part = ctx.failed.need.kind === "app.part" ? ctx.failed.need.part : null;

                // A notification click is killed after 30 s, so it never starts a build (40 s to over 2 min): it says
                // so in its args, and a caller with no terminal is treated the same. The outcome names the fix command.
                if (policy === "skip" || !ctx.facts.hasTerminal()) {
                    return ctx.skip();
                }

                if (policy === "build") {
                    return ctx.build(part);
                }

                return policy === "offer" ? ctx.offerBuild(part) : ctx.skip();
            },
            manual: (args) => windowOpenArgv(args).map(shellWord).join(" "),
            failureNotice: (args, { skipped, manual }) => {
                const failure = skipped[0];
                if (args.fix !== "skip" || !failure) {
                    return null;
                }

                return {
                    title: `Could not open ${args.window}`,
                    message: failure.fix
                        ? windowFailureMessage(failure)
                        : [failure.reason, manual].filter(Boolean).join("\n"),
                };
            },
        }),
    },
});

declare module "@genesiscz/utils/genesis-tools/actions/registry" {
    interface GenesisToolsAreas {
        windows: typeof windows;
    }
}
