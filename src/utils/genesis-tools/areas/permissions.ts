import { defineAction, defineArea, type Pass } from "@genesiscz/utils/genesis-tools/actions/define";
import { Need } from "@genesiscz/utils/genesis-tools/capability/needs";
import { genesisAppLauncherPath } from "@genesiscz/utils/macos/genesis-app";
import { PERMISSION_KINDS } from "@genesiscz/utils/macos/permission-kinds";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import { z } from "zod";

const args = z.object({ kind: z.enum(PERMISSION_KINDS) });
const result = z.object({ kind: z.enum(PERMISSION_KINDS), status: z.string() });
async function status(kind: string): Promise<string> {
    refuseHostEffectInTest("permission probe", "Inject permission facts in tests.");
    const proc = Bun.spawn([genesisAppLauncherPath(), "--permission-status", kind], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
    });
    const [exit, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    if (exit !== 0 || !stdout.trim()) {
        throw new Error(`Permission probe failed: ${stderr.trim()}`);
    }
    return stdout.trim();
}
export const permissions = defineArea({
    area: "permissions",
    summary: "Read a privacy grant or open its native request dialog",
    actions: {
        openTerminalRequest: defineAction({
            summary: "Open a terminal for a permission step the person can see",
            args: z.object({ argv: z.array(z.string()).min(1) }),
            result: z.object({ opened: z.literal(true) }),
            native: {
                needs: [Need.person.display],
                run: async (ctx): Promise<{ opened: true } | Pass> => {
                    const opened = await ctx.terminal.runVisibly(ctx.args, { timeoutMs: ctx.timeoutMs });
                    return opened.status === "ran"
                        ? opened.value
                        : ctx.pass(opened.skipped.map((skip) => skip.reason).join("; "));
                },
            },
        }),
        status: defineAction({
            summary: "Read the current grant in a fresh app process",
            args,
            result,
            native: {
                // Both start the launcher by its path, so routing switched off does not block them.
                needs: [Need.platform.darwin, Need.app.bundle],
                run: async (ctx) => ({ kind: ctx.args.kind, status: await status(ctx.args.kind) }),
            },
        }),
        require: defineAction({
            summary: "Show the app's permission dialog, then read the grant",
            args: args.extend({ reason: z.string().optional() }),
            result,
            native: {
                needs: [Need.platform.darwin, Need.app.bundle, Need.person.display],
                run: async (ctx) => {
                    refuseHostEffectInTest("permission request", "Inject a permission requester in tests.");
                    const proc = Bun.spawn(
                        [
                            genesisAppLauncherPath(),
                            "--permission-dialog",
                            ctx.args.kind,
                            ...(ctx.args.reason ? ["--reason", ctx.args.reason] : []),
                        ],
                        { stdout: "ignore", stderr: "pipe", timeout: ctx.timeoutMs }
                    );
                    const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
                    if (exit !== 0) {
                        throw new Error(`Permission dialog failed: ${stderr.trim()}`);
                    }
                    return { kind: ctx.args.kind, status: await status(ctx.args.kind) };
                },
            },
        }),
    },
});
declare module "@genesiscz/utils/genesis-tools/actions/registry" {
    interface GenesisToolsAreas {
        permissions: typeof permissions;
    }
}
