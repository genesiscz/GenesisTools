import { NativeMenuSession } from "@app/control/lib/computer-use/menu";
import { runAxAsync } from "@app/control/lib/runner";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { ListenCandidate } from "./verbs";

const prof = profiler.scope("jev-listen");
const { log } = logger.scoped("jev-listen");

/** How many menu items one app may contribute; a menu bar is long and the chooser is bounded. */
export const MENU_ITEM_CAP = 120;

export interface MenuCandidates {
    items(): Promise<ListenCandidate[]>;
    act(menuRef: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * The app's menu bar as choosable rows ("File > New Tab"), read through 409's native menu
 * session. The observation is cached until an act consumes it, because a menu reference is valid
 * for one observation only.
 */
export function createMenuCandidates(app: string, signal: AbortSignal): MenuCandidates {
    const session = new NativeMenuSession({ run: runAxAsync });
    let cached: ListenCandidate[] | null = null;
    // A menu ref is valid for one observation of one top menu, and the session keeps one
    // observation per app, so the act path re-reads the item's own top menu and matches by path.
    const paths = new Map<string, { topMenu: string; path: string[] }>();
    return {
        async items() {
            if (cached) {
                return cached;
            }

            const stop = prof.start("menu-see");
            try {
                // Inventory always starts at the menu bar, even while a context menu is open.
                // Each top menu is then read in turn to offer rows such as "File > New Tab".
                const bar = await session.observe({ app, menu_bar_only: true, limit: 40, signal });
                // Depth 1 only: the bar's own root row also has a one-element path and an empty
                // title, and asking for a top menu titled "" fails the whole read (seen on Calculator).
                const titles = [
                    ...new Set(
                        bar.items
                            .filter(
                                (item) =>
                                    item.depth === 1 &&
                                    item.path.length === 1 &&
                                    item.enabled &&
                                    item.title.length > 0 &&
                                    item.title !== "Apple"
                            )
                            .map((item) => item.title)
                    ),
                ];
                const rows: ListenCandidate[] = [];
                let total = 0;
                for (const title of titles) {
                    let observed: Awaited<ReturnType<typeof session.observe>>;
                    try {
                        observed = await session.observe({ app, top_menu: title, limit: MENU_ITEM_CAP, signal });
                    } catch (error) {
                        // One unreadable menu must not cost the others their items.
                        log.warn({ error, app, title }, "top menu unreadable; skipping it");
                        continue;
                    }

                    total += observed.total;
                    for (const item of observed.items) {
                        if (!item.enabled || !item.actions.includes("AXPress") || item.path.length < 2) {
                            continue;
                        }

                        const id = `m${rows.length}`;
                        paths.set(id, { topMenu: title, path: item.path });
                        rows.push({
                            id,
                            label: item.path.join(" > "),
                            action: "menu" as const,
                            element: -1,
                            menuRef: id,
                        });
                    }
                }

                cached = rows.slice(0, MENU_ITEM_CAP);
                log.info(
                    { app, menus: titles, items: cached.length, total, truncated: rows.length > MENU_ITEM_CAP },
                    "menu items observed"
                );
                return cached;
            } catch (error) {
                log.warn({ error, app }, "menu observation failed; continuing without menu items");
                cached = [];
                return cached;
            } finally {
                stop();
            }
        },
        async act(menuRef: string) {
            cached = null;
            const known = paths.get(menuRef);
            if (!known) {
                return { ok: false, error: `menu item ${menuRef} is not in the observed set` };
            }

            const fresh = await session.observe({ app, top_menu: known.topMenu, limit: MENU_ITEM_CAP, signal });
            const wanted = known.path.join(" > ");
            const item = fresh.items.find((row) => row.path.join(" > ") === wanted);
            if (!item?.enabled) {
                return { ok: false, error: `menu item "${wanted}" is gone or disabled` };
            }

            log.info({ app, path: known.path }, "menu act");
            const result = await prof.measureAsync("menu-act", () =>
                session.act({ app, menu_ref: item.ref, action: "AXPress", signal })
            );
            return { ok: result.ok === true, error: result.ok ? undefined : (result.error ?? "menu action failed") };
        },
    };
}
