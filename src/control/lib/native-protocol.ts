import { createHash } from "node:crypto";
import { type ActionParameters, actionParametersSchema, type ControlAction } from "./decision/action";
import { hasAncestorRole, type Observation, type ObservedElement, observationSchema } from "./decision/observation";
import type { AxResult } from "./runner";

/**
 * The ax-tool `see` and `act` argv, written once.
 *
 * Every driver that observes or acts through the native core (the decision driver in decision/native.ts,
 * ComputerUse in computer-use/session.ts) builds its argv here: the observation flags, the validated
 * action parameters, the pin rule with its allowlists, the twin ordinal and the web activation key. Each
 * driver keeps its own policy (when to prepare, when to deliver in the background) and passes the argv to
 * its own runner. Nothing here spawns.
 *
 * Before this module the two drivers each wrote these rules, and they drifted: the decision driver's copy
 * of the `--target-key` allowlist left out focus and drag long after native accepted both.
 */

/** Mirrors the `--prepare` allowlist in WorkflowArguments.validateAction; native-protocol.test.ts compares the two. */
export const PREPARABLE_ACTIONS = ["press", "click", "key", "type", "paste", "select", "set"] as const;

/** Mirrors the `--target-key` allowlist in WorkflowArguments.validateAction; native-protocol.test.ts compares the two. */
export const TARGET_KEY_ACTIONS = [
    "press",
    "click",
    "key",
    "type",
    "paste",
    "select",
    "set",
    "perform",
    "focus",
    "hover",
    "move",
    "drag",
    "scroll",
    "get",
] as const;

const preparable = new Set<string>(PREPARABLE_ACTIONS);
const targetKeyed = new Set<string>(TARGET_KEY_ACTIONS);

export interface SeeRequest {
    app: string;
    /** `window` when unset. `query` needs `query`. */
    scope?: string;
    query?: { text: string; role?: string };
    depth?: number;
    /** false adds `--no-image`. */
    image?: boolean;
    perception?: string;
    /** Cache file for `--perception-reuse`: a repeat OCR observation re-reads only the regions that changed. */
    perceptionReuse?: string;
    /** Wins over `windowIndex`. */
    windowId?: number;
    /** On-screen window index (0 = frontmost) when no window id is pinned. */
    windowIndex?: number;
    /** Where native writes the screenshot. */
    path?: string;
}

export function seeArguments(request: SeeRequest): string[] {
    const scope = request.scope ?? "window";
    const args = ["see", "--app", request.app, "--scope", scope];
    if (scope === "query") {
        if (!request.query) {
            throw new Error("A query-scoped observation needs the query text.");
        }

        args.push("--query", request.query.text, ...(request.query.role ? ["--query-role", request.query.role] : []));
    }

    if (request.depth !== undefined) {
        args.push("--depth", String(request.depth));
    }

    if (request.image === false) {
        args.push("--no-image");
    }

    if (request.perception !== undefined) {
        args.push("--perception", request.perception);
    }

    if (request.perceptionReuse !== undefined) {
        args.push("--perception-reuse", request.perceptionReuse);
    }

    if (request.windowId !== undefined) {
        args.push("--window-id", String(request.windowId));
    } else if (request.windowIndex !== undefined) {
        args.push("--window-index", String(request.windowIndex));
    }

    if (request.path !== undefined) {
        args.push("--path", request.path);
    }

    return args;
}

/** A successful `see` read as an observation; a failed parse is returned, not thrown, so a driver can retry. */
export function parseObservation(result: AxResult) {
    return observationSchema.safeParse(result);
}

export interface ActRequest {
    app: string;
    snapshot: string;
    /** Written before the action when set; a caller that places `--element` itself leaves it out. */
    element?: number;
    /** The action, its parameters, its target and its pin. */
    action: string[];
    allowForeground?: boolean;
    /** false adds `--no-image`. */
    image?: boolean;
    path?: string;
}

export function actArguments(request: ActRequest): string[] {
    return [
        "act",
        "--app",
        request.app,
        "--snapshot",
        request.snapshot,
        ...(request.element === undefined ? [] : ["--element", String(request.element)]),
        ...request.action,
        ...(request.allowForeground ? ["--allow-foreground"] : []),
        "--refresh",
        ...(request.image === false ? ["--no-image"] : []),
        ...(request.path === undefined ? [] : ["--path", request.path]),
    ];
}

const allowedParameters: Record<ControlAction, string[]> = {
    press: [],
    hover: ["dwell"],
    set: [],
    focus: [],
    key: ["keys"],
    type: [],
    paste: ["format"],
    select: ["selection", "prefix", "suffix"],
    perform: ["axAction"],
    click: ["button", "count", "background"],
    scroll: ["direction", "pixels", "pages", "background"],
};

/** `--action <name>` and its validated parameters, for the control action vocabulary in decision/action.ts. */
export function nativeActionArguments(options: {
    action: ControlAction;
    value?: string;
    parameters?: ActionParameters;
}): string[] {
    const { action, value } = options;
    const p = actionParametersSchema.parse(options.parameters ?? {});
    for (const key of Object.keys(p)) {
        if (!allowedParameters[action].includes(key)) {
            throw new Error(`Parameter ${key} is not valid for ${action}.`);
        }
    }
    const args = ["--action", action];
    if (["set", "type", "paste", "select"].includes(action)) {
        if (value === undefined) {
            throw new Error(`${action} requires an exact supplied value.`);
        }
        if (action === "type" && (value.length > 256 || /[\r\n]/.test(value))) {
            throw new Error("type requires at most 256 single-line UTF-16 units; use paste.");
        }
        args.push(action === "set" ? "--value" : "--text", value);
    } else if (value !== undefined) {
        throw new Error(`${action} does not accept a supplied value.`);
    }
    if (action === "key") {
        if (!p.keys) {
            throw new Error("key requires parameters.keys.");
        }
        args.push("--keys", p.keys);
    }
    if (action === "hover" && p.dwell !== undefined) {
        args.push("--dwell", String(p.dwell));
    }

    if (action === "perform") {
        if (!p.axAction) {
            throw new Error("perform requires parameters.axAction.");
        }
        args.push("--ax-action", p.axAction);
    }
    if (action === "scroll") {
        if (!p.direction || (p.pages !== undefined && p.pixels !== undefined)) {
            throw new Error("scroll requires direction and at most one of pages/pixels.");
        }
        args.push(
            "--direction",
            p.direction,
            p.pixels === undefined ? "--pages" : "--pixels",
            String(p.pixels ?? p.pages ?? 1)
        );
    }
    if (action === "click") {
        args.push("--button", p.button ?? "left");
        if (p.count === 2) {
            args.push("--double");
        }
    }
    if (action === "click" || action === "scroll") {
        if (p.background !== false) {
            args.push("--background");
        }
    }
    if (action === "paste") {
        args.push("--format", p.format ?? "text");
    }
    if (action === "select") {
        args.push("--selection", p.selection ?? "text");
        if (p.prefix !== undefined) {
            args.push("--prefix", p.prefix);
        }
        if (p.suffix !== undefined) {
            args.push("--suffix", p.suffix);
        }
    }
    return args;
}

/**
 * `--target-ordinal position/count` when several observed rows carry the key a dispatch pins.
 * chrome://extensions shows one identical "Reload" button per extension card, and every key the
 * backend computes is the same for all of them, so without the caller's position among the twins
 * an exact ref from the newest observation was refused as ambiguous. `fields` is the order the
 * backend tries: the prepared path matches targetKey only, element revalidation targetKey, then
 * stableKey.
 */
export function targetOrdinalArgs({
    rows,
    row,
    key,
    fields,
}: {
    rows: ObservedElement[];
    row: ObservedElement;
    key: string;
    fields: Array<"targetKey" | "stableKey">;
}): string[] {
    for (const field of fields) {
        const matches = rows.filter((candidate) => candidate[field] === key);
        if (matches.length === 0) {
            continue;
        }

        const position = matches.findIndex((candidate) => candidate.index === row.index);
        return matches.length > 1 && position >= 0 ? ["--target-ordinal", `${position}/${matches.length}`] : [];
    }

    return [];
}

/**
 * The pin of one act: how native re-finds the observed row before it dispatches.
 *
 * Prepared, the act carries `--prepare` and the row's targetKey (native re-resolves it in front). Otherwise
 * the row is pinned by identity with `--revalidate-scope element`, so a window that re-renders between
 * observe and act (a live transcript, a clock) is re-resolved instead of refused as stale: the whole-tree
 * digest moves once a second in such a window. The stable key goes first, because targetKey folds in
 * sibling text and a clock beside the target changes it; native resolves either field
 * (SnapshotDigest.resolvedTargetIndex). An action outside the allowlists gets no pin, because native
 * refuses the option with "option is not valid" before anything is dispatched.
 *
 * `action` is the action ACTUALLY dispatched, never the one a caller asked for: a press rewritten to
 * `perform` cannot take `--prepare`.
 */
export function pinArguments({
    action,
    row,
    rows,
    prepare,
}: {
    action: string;
    row: ObservedElement | undefined;
    rows: ObservedElement[];
    prepare: boolean;
}): string[] {
    if (prepare && preparable.has(action)) {
        return [
            "--prepare",
            ...(row?.targetKey
                ? [
                      "--target-key",
                      row.targetKey,
                      ...targetOrdinalArgs({ rows, row, key: row.targetKey, fields: ["targetKey"] }),
                  ]
                : []),
        ];
    }

    const pin = row?.stableKey ?? row?.targetKey;
    if (!row || !pin || !targetKeyed.has(action)) {
        return [];
    }

    return [
        "--target-key",
        pin,
        "--revalidate-scope",
        "element",
        ...targetOrdinalArgs({ rows, row, key: pin, fields: ["targetKey", "stableKey"] }),
    ];
}

const TEXT_INPUT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);

/**
 * `--expect-value-sha256` for a key sent to a text input: the digest of the value the caller
 * observed. The backend refuses Return or Enter when the field no longer holds it. Without it the
 * check compared only against the act's own read, and a stable-key pin (an AXIdentifier, blind to
 * the text) re-resolves a field whose text changed after the observation. A digest keeps the text
 * off the command line, and a secure field sends nothing.
 */
export function expectedValueArgs(row: ObservedElement): string[] {
    if (!TEXT_INPUT_ROLES.has(row.role) || row.AXSubrole === "AXSecureTextField" || typeof row.AXValue !== "string") {
        return [];
    }

    return ["--expect-value-sha256", createHash("sha256").update(row.AXValue, "utf8").digest("hex")];
}

const WEB_TOGGLE_ROLES = new Set(["AXButton", "AXCheckBox", "AXRadioButton", "AXSwitch"]);
const WEB_EDITABLE_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox"]);

/**
 * The key that activates a page element in front: a browser page ignores AXPress on many elements, so a
 * link takes return and a button, checkbox, radio button or switch takes space. Nothing outside a page.
 */
export function webActivationKey(
    rows: Observation["elements"],
    target: ObservedElement
): "return" | "space" | undefined {
    if (!hasAncestorRole(rows, target, "AXWebArea")) {
        return undefined;
    }

    if (target.role === "AXLink") {
        return "return";
    }

    if (WEB_TOGGLE_ROLES.has(target.role)) {
        return "space";
    }

    return undefined;
}

/**
 * The action a prepared act on a page element really dispatches, or undefined when it dispatches as
 * asked: `set` on a page text field becomes a replacing paste (a page ignores AXValue writes), and
 * `press` becomes the element's activation key.
 */
export function webDispatchArguments({
    action,
    row,
    rows,
    value,
}: {
    action: string;
    row: ObservedElement;
    rows: Observation["elements"];
    value?: string;
}): string[] | undefined {
    if (action === "set") {
        return WEB_EDITABLE_ROLES.has(row.role) && hasAncestorRole(rows, row, "AXWebArea")
            ? ["--action", "paste", "--text", value ?? "", "--format", "text", "--replace"]
            : undefined;
    }

    if (action === "press") {
        const key = webActivationKey(rows, row);
        return key ? ["--action", "key", "--keys", key] : undefined;
    }

    return undefined;
}

/** `--element <index>` placed right after `--action <name>`, the order the act verbs are written in. */
export function withElement(action: string[], element: number): string[] {
    return [...action.slice(0, 2), "--element", String(element), ...action.slice(2)];
}
