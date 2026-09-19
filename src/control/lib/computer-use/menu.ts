import { randomUUID } from "node:crypto";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { z } from "zod";
import { elementLabel, observedElementSchema } from "../decision/observation";
import type { NativeBridge } from "./session";

const { log } = logger.scoped("control-menu");
const prof = profiler.scope("control-native");

const menuSchema = z.object({
    ok: z.literal(true),
    surface: z.literal("menu"),
    app: z.string(),
    pid: z.number().int().positive(),
    processLaunch: z.number().positive(),
    snapshot: z.string().min(1),
    elements: z.array(observedElementSchema).max(4000),
});
type MenuSnapshot = z.infer<typeof menuSchema>;
export class NativeMenuSession {
    private readonly records = new Map<string, { snapshot: MenuSnapshot; revision: string; observedAt: string }>();
    private readonly id = randomUUID().slice(0, 8);
    private generation = 0;
    constructor(private readonly native: NativeBridge) {}
    async observe(options: {
        app: string;
        query?: string;
        top_menu?: string;
        limit: number;
        timeout_ms?: number;
        signal?: AbortSignal;
    }) {
        if (!this.records.has(options.app) && this.records.size >= 8) {
            throw new Error("Eight menu sessions are already retained; close one first.");
        }
        const stopSee = prof.start("menu-see");
        const result = await this.native.run({
            args: ["menu-see", "--app", options.app, ...(options.top_menu ? ["--menu", options.top_menu] : [])],
            timeoutMs: options.timeout_ms ?? 10000,
            signal: options.signal,
        });
        const seeMs = stopSee();
        if (!result.ok) {
            log.warn(
                { app: options.app, topMenu: options.top_menu, ms: seeMs, error: result.error },
                "menu-see failed"
            );
            throw new Error(result.error ?? "Native menu inspection failed.");
        }
        const snapshot = menuSchema.parse(result);
        log.info(
            {
                app: options.app,
                topMenu: options.top_menu,
                rows: snapshot.elements.length,
                retained: this.records.size,
                ms: seeMs,
            },
            "menu-see ok"
        );
        const record = {
            snapshot,
            revision: `${this.id}:menu:${++this.generation}`,
            observedAt: new Date().toISOString(),
        };
        this.records.set(options.app, record);
        const ancestors: Array<{ depth: number; title: string }> = [];
        const items = snapshot.elements
            .map((row) => {
                while (ancestors.length && ancestors.at(-1)!.depth >= row.depth) {
                    ancestors.pop();
                }
                const title = elementLabel(row).slice(0, 500);
                const path = [...ancestors.map((item) => item.title), title];
                if (row.AXTitle || row.AXDescription) {
                    ancestors.push({ depth: row.depth, title });
                }
                return {
                    ref: `${record.revision}:${row.index}`,
                    index: row.index,
                    depth: row.depth,
                    role: row.role,
                    title,
                    path,
                    enabled: ![false, 0, "0", "false"].includes(row.AXEnabled ?? ""),
                    selected: [true, 1, "1", "true"].some((value) => value === row.AXSelected),
                    bounds:
                        typeof row.x === "number" &&
                        typeof row.y === "number" &&
                        typeof row.width === "number" &&
                        typeof row.height === "number"
                            ? { x: row.x, y: row.y, width: row.width, height: row.height }
                            : undefined,
                    actions: row.actions ?? [],
                };
            })
            .filter(
                (item) =>
                    !options.query ||
                    item.path.some((label) => label.toLocaleLowerCase().includes(options.query!.toLocaleLowerCase()))
            );
        return {
            app: options.app,
            revision: record.revision,
            pid: snapshot.pid,
            surface: "menu" as const,
            observedAt: record.observedAt,
            items: items.slice(0, options.limit),
            total: items.length,
            truncated: items.length > options.limit,
        };
    }
    async act(options: { app: string; menu_ref: string; action: string; timeout_ms?: number; signal?: AbortSignal }) {
        const record = this.records.get(options.app);
        if (!record) {
            throw new Error("Inspect the menu before acting.");
        }
        const prefix = `${record.revision}:`;
        const suffix = options.menu_ref.startsWith(prefix) ? options.menu_ref.slice(prefix.length) : "";
        const index = /^\d+$/.test(suffix) ? Number(suffix) : -1;
        const row = record.snapshot.elements.find((item) => item.index === index);
        if (!row) {
            throw new Error("Menu reference belongs to a different observation.");
        }
        if (!row.actions?.includes(options.action)) {
            throw new Error("Menu item does not expose the requested action.");
        }
        this.records.delete(options.app);
        log.info(
            { app: options.app, element: index, title: elementLabel(row).slice(0, 120), action: options.action },
            "menu-act"
        );
        const stopAct = prof.start("menu-act");
        try {
            const result = await this.native.run({
                args: [
                    "menu-act",
                    "--app",
                    options.app,
                    "--snapshot",
                    record.snapshot.snapshot,
                    "--element",
                    String(index),
                    "--action",
                    options.action,
                ],
                timeoutMs: options.timeout_ms ?? 10000,
                signal: options.signal,
            });
            const actMs = stopAct();
            if (result.ok) {
                log.info({ app: options.app, element: index, ms: actMs }, "menu-act ok");
            } else {
                log.warn(
                    {
                        app: options.app,
                        element: index,
                        ms: actMs,
                        dispatchState: result.dispatchState,
                        error: result.error,
                    },
                    "menu-act failed"
                );
            }

            return result;
        } catch (error) {
            stopAct();
            log.warn({ app: options.app, element: index, error }, "menu-act transport failed; delivery unknown");
            return {
                ok: false,
                dispatchState: "uncertain",
                error: error instanceof Error ? error.message : "Menu action delivery is unknown; no retry.",
            };
        }
    }
    close(app?: string) {
        if (app) {
            this.records.delete(app);
        } else {
            this.records.clear();
        }
    }
}
