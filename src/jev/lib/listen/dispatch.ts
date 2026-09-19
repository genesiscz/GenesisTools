import { activateApp } from "@app/control/lib/decision/frontmost";
import type { NativeControlDriver } from "@app/control/lib/decision/native";
import { candidatesFor } from "@app/control/lib/decision/observation";
import { emitClickOverlay } from "@app/control/lib/overlay";
import { logger } from "@genesiscz/utils/logger";
import type { PrefetchPayload } from "../prefetch";
import { dispatchChromeVerb } from "./chrome";
import type { MenuCandidates } from "./menu-candidates";
import { CHROME_VERBS } from "./verbs";

const { log } = logger.scoped("jev-listen");

/** Which surface a session dispatches through. */
export type ListenSurfaceKind = "ax" | "browser" | "auto";

export interface DispatchInput {
    payload: PrefetchPayload;
    observation?: Parameters<NativeControlDriver["act"]>[0]["observation"];
    driver?: NativeControlDriver;
    surface: ListenSurfaceKind;
    port: number;
    menus?: MenuCandidates;
    /** Called after a successful app switch so the session rebinds to the new frontmost app. */
    onAppSwitch?: () => void;
}

/**
 * Turn one admitted choice into one act. Every candidate class a listen session can offer ends
 * here: a menu item, an app switch, a chrome verb, or an observed native row. It lives beside the
 * pipeline rather than in the CLI command because the command is a door, and a second door (the
 * goal loop, an MCP tool, a typed goal) must dispatch the same way or the same question gets two
 * answers depending on which one you knock on.
 */
export async function actOnSurface(input: DispatchInput): Promise<{ ok: boolean; error?: string }> {
    if (input.payload.action === "app") {
        if (input.payload.appPid === undefined) {
            return { ok: false, error: "app switch chosen without a pid" };
        }

        const switched = await activateApp(input.payload.appPid);
        if (switched.ok) {
            // The next utterance re-resolves the target, so it controls the app now in front.
            input.onAppSwitch?.();
        }

        return switched;
    }

    if (input.payload.action === "menu") {
        if (!input.menus || !input.payload.menuRef) {
            return { ok: false, error: "menu item chosen without a menu session; pass --menus" };
        }

        return input.menus.act(input.payload.menuRef);
    }

    if (input.payload.action === "chrome") {
        if (input.surface === "ax") {
            return { ok: false, error: "chrome verbs need --surface browser or auto" };
        }

        const verb = CHROME_VERBS.find((item) => item === input.payload.chrome);
        if (!verb) {
            return { ok: false, error: `unknown chrome verb ${String(input.payload.chrome)}` };
        }

        return dispatchChromeVerb({ verb, port: input.port });
    }

    const observation = input.observation;
    if (!input.driver || !observation) {
        return { ok: false, error: "no native driver bound; pass --app" };
    }

    const candidate = candidatesFor({ observation }).find(
        (item) => item.element === input.payload.element && item.action === input.payload.action
    );
    if (!candidate) {
        return { ok: false, error: "payload is not an observed candidate" };
    }

    const acted = await input.driver.act({ observation, candidate });
    if (acted.ok) {
        showWhereItLanded(observation, candidate.element);
    }

    return acted;
}

/**
 * Feedback for a watching human: draw the overlay where the act landed. The row's own frame is the
 * point, so it marks the thing that was pressed rather than wherever the pointer happens to be.
 * Nothing about the act is proven by this; the readback decides that.
 */
function showWhereItLanded(observation: Parameters<NativeControlDriver["act"]>[0]["observation"], element: number) {
    const row = observation.elements.find((item) => item.index === element);
    const x = Number(row?.x);
    const y = Number(row?.y);
    const width = Number(row?.width);
    const height = Number(row?.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
        log.debug({ element }, "no usable frame on the acted row; no overlay");
        return;
    }

    emitClickOverlay({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) });
}
