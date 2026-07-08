import {
    CALLOUT_TONES,
    COMPOSE_KINDS,
    type ComposeErrorCode,
    type ComposeKind,
    MAX_CHECKLIST_ITEMS,
    MAX_OPTION_HINT,
    MAX_OPTION_LABEL,
    MAX_QUESTION_OPTIONS,
    MAX_WIREFRAME_NODES,
    STEP_STATUSES,
    VIZ_KINDS,
    WIREFRAME_DEVICES,
    WIREFRAME_FIDELITY,
} from "./compose-types";

type Payload = Record<string, unknown>;

/** Stamp the toggleable AI-layer marker: non-section cards gain `layer:"ai"` unless already set;
 *  sections are layer-neutral journey structure, so their marker is stripped (handlers_compose.go:272-278). */
export function stampLayer(kind: ComposeKind, payload: Payload): Payload {
    const next = { ...payload };
    if (kind === "section") {
        delete next.layer;
    } else if (!("layer" in next)) {
        next.layer = "ai";
    }
    return next;
}

/** Per-kind default footprint in px — vitrinka's composeDefaultSize (handlers_compose.go:578-634). */
export function composeDefaultSize(kind: ComposeKind, payload: Payload): { w: number; h: number } {
    switch (kind) {
        case "text":
            return payload.role === "heading" ? { w: 420, h: 72 } : { w: 280, h: 150 };
        case "note":
            return { w: 230, h: 140 };
        case "viz":
            switch (payload.viz) {
                case "matrix":
                    return { w: 340, h: 340 };
                case "flow":
                    return { w: 460, h: 130 };
                case "timeline":
                    return { w: 360, h: 240 };
                case "bars":
                    return { w: 340, h: 220 };
                case "line":
                    return { w: 420, h: 240 };
                case "stat":
                    return { w: 420, h: 140 };
                default:
                    return { w: 380, h: 260 }; // table
            }
        case "cluster":
            return { w: 640, h: 420 };
        case "section":
            return { w: 960, h: 640 };
        case "shape":
            return { w: 200, h: 140 };
        case "step":
            return payload.cardId != null ? { w: 300, h: 220 } : { w: 300, h: 120 };
        case "callout":
            return { w: 320, h: 120 };
        case "checklist": {
            const items = Array.isArray(payload.items) ? payload.items : null;
            return items ? { w: 300, h: Math.min(64 + items.length * 30, 480) } : { w: 300, h: 180 };
        }
        case "compare":
            return { w: 480, h: 340 };
        case "wireframe":
            if (payload.device === "tablet") {
                return { w: 420, h: 320 };
            }
            if (payload.device === "web") {
                return { w: 520, h: 380 };
            }
            return { w: 260, h: 520 }; // phone
        default:
            return { w: 300, h: 200 };
    }
}

type ValidateResult = { ok: true; payload: Payload } | { ok: false; code: ComposeErrorCode };

/** Validate a compose card's kind + payload, returning the AI-layer-stamped payload on success.
 *  Mirrors handlers_compose.go:172-278 exactly. compare's cardId EXISTENCE is checked later against
 *  the board (here only that a.cardId/b.cardId are positive numbers). */
export function validateComposeCard(input: { kind: string; payload: Payload }): ValidateResult {
    const { kind, payload } = input;
    if (!COMPOSE_KINDS.has(kind as ComposeKind)) {
        return { ok: false, code: "bad_kind" };
    }
    const bad: ValidateResult = { ok: false, code: "bad_payload" };
    const str = (k: string): string => (typeof payload[k] === "string" ? (payload[k] as string) : "");

    switch (kind) {
        case "text":
            if (!str("md")) {
                return bad;
            }
            break;
        case "note":
            if (!str("text")) {
                return bad;
            }
            break;
        case "viz": {
            if (!VIZ_KINDS.has(str("viz"))) {
                return bad;
            }
            const data = payload.data;
            if (typeof data !== "object" || data === null || Array.isArray(data)) {
                return bad;
            }
            break;
        }
        case "section":
            if (!str("title")) {
                return bad;
            }
            break;
        case "step":
            if (!str("title")) {
                return bad;
            }
            if (!STEP_STATUSES.has(str("status"))) {
                return bad;
            }
            break;
        case "callout":
            if (!str("md")) {
                return bad;
            }
            if (str("tone") !== "" && !CALLOUT_TONES.has(str("tone"))) {
                return bad;
            }
            break;
        case "checklist": {
            const items = payload.items;
            if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CHECKLIST_ITEMS) {
                return bad;
            }
            for (const it of items) {
                if (typeof it !== "object" || it === null) {
                    return bad;
                }
                const t = (it as Payload).text;
                if (typeof t !== "string" || t === "") {
                    return bad;
                }
            }
            break;
        }
        case "wireframe": {
            const nodes = payload.nodes;
            if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_WIREFRAME_NODES) {
                return bad;
            }
            for (const nd of nodes) {
                if (typeof nd !== "object" || nd === null) {
                    return bad;
                }
                const t = (nd as Payload).t;
                if (typeof t !== "string" || t === "") {
                    return bad;
                }
            }
            if (!WIREFRAME_DEVICES.has(str("device"))) {
                return bad;
            }
            if (!WIREFRAME_FIDELITY.has(str("fidelity"))) {
                return bad;
            }
            break;
        }
        case "compare":
            for (const side of ["a", "b"]) {
                const m = payload[side];
                if (typeof m !== "object" || m === null) {
                    return bad;
                }
                const id = (m as Payload).cardId;
                if (typeof id !== "number" || id <= 0) {
                    return bad;
                }
            }
            break;
        // "shape" and "cluster" carry no payload constraints.
    }

    return { ok: true, payload: stampLayer(kind as ComposeKind, payload) };
}

export interface NormalizedOption {
    label: string;
    hint?: string;
    recommended?: boolean;
}

/** Normalize question options (string XOR {label, hint?, recommended?}); 1-12 options, label ≤200,
 *  hint ≤300. Shared by compose (Task 14) and the questions routes (Task 18). */
export function normalizeOptions(
    options: unknown
): { ok: true; options: NormalizedOption[] } | { ok: false; code: ComposeErrorCode } {
    if (!Array.isArray(options) || options.length < 1 || options.length > MAX_QUESTION_OPTIONS) {
        return { ok: false, code: "bad_question" };
    }
    const out: NormalizedOption[] = [];
    for (const opt of options) {
        if (typeof opt === "string") {
            if (opt.length === 0 || opt.length > MAX_OPTION_LABEL) {
                return { ok: false, code: "bad_question" };
            }
            out.push({ label: opt });
            continue;
        }
        if (typeof opt !== "object" || opt === null) {
            return { ok: false, code: "bad_question" };
        }
        const o = opt as Payload;
        const label = typeof o.label === "string" ? o.label : "";
        if (!label || label.length > MAX_OPTION_LABEL) {
            return { ok: false, code: "bad_question" };
        }
        const hint = typeof o.hint === "string" ? o.hint : undefined;
        if (hint && hint.length > MAX_OPTION_HINT) {
            return { ok: false, code: "bad_question" };
        }
        out.push({
            label,
            ...(hint ? { hint } : {}),
            ...(o.recommended === true ? { recommended: true } : {}),
        });
    }
    return { ok: true, options: out };
}
