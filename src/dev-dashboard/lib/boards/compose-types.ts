// Shared vocabulary for the AI expression layer (compose / arrange / sections / scrape / questions).
// Constants and per-kind sizing mirror vitrinka's internal/web/handlers_compose.go exactly.

export type ComposeKind =
    | "text"
    | "note"
    | "shape"
    | "viz"
    | "cluster"
    | "section"
    | "step"
    | "callout"
    | "checklist"
    | "compare"
    | "wireframe";

export type VizKind = "table" | "matrix" | "flow" | "bars" | "timeline" | "line" | "stat";

export type ArrangeMode =
    | "column"
    | "row"
    | "grid"
    | "flow"
    | "lanes"
    | "masonry"
    | "timeline"
    | "timeaxis"
    | "compare"
    | "align-left"
    | "align-top"
    | "distribute-h"
    | "distribute-v";

// A compose ref is a batch-local string handle XOR an existing card id (number).
export type ComposeRef = string | number;

// Batch limits (handlers_compose.go:26-28).
export const COMPOSE_MAX_CARDS = 60;
export const COMPOSE_MAX_EDGES = 40;
export const COMPOSE_MAX_QUESTIONS = 12;

// Geometry (handlers_compose.go:29-37).
export const COMPOSE_GRID = 28; // snap lattice px
export const COMPOSE_GAP = 24; // default inter-card gap
export const COMPOSE_GUTTER = 80; // free-space distance from the existing bbox / anchor
export const QUESTION_ROOM = 130; // extra height reserved under a card carrying an anchored question
export const SECTION_PAD_X = 24;
export const SECTION_PAD_TOP = 56; // journey title headroom inside a section frame
export const SECTION_PAD_BOT = 24;
export const DEFAULT_WRAP_W = 1200; // flow wrap width outside a section

// Question option limits (1-12 options; label ≤200; hint ≤300; prompt ≤1000).
export const MAX_QUESTION_OPTIONS = 12;
export const MAX_OPTION_LABEL = 200;
export const MAX_OPTION_HINT = 300;
export const MAX_QUESTION_PROMPT = 1000;
export const MAX_ANSWER_LEN = 500;

// Per-kind payload size caps.
export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_WIREFRAME_NODES = 40;

// arrange gap/padding token map (S/M/L). M matches composeGap.
export const SPACING = { S: 12, M: 24, L: 48 } as const;

export const COMPOSE_KINDS: ReadonlySet<ComposeKind> = new Set<ComposeKind>([
    "text",
    "note",
    "shape",
    "viz",
    "cluster",
    "section",
    "step",
    "callout",
    "checklist",
    "compare",
    "wireframe",
]);

export const VIZ_KINDS: ReadonlySet<string> = new Set<VizKind>([
    "table",
    "matrix",
    "flow",
    "bars",
    "timeline",
    "line",
    "stat",
]);

// step status and callout tone vocab (handlers_compose.go:52-53).
export const STEP_STATUSES: ReadonlySet<string> = new Set(["", "todo", "pass", "fail"]);
export const CALLOUT_TONES: ReadonlySet<string> = new Set(["info", "warn", "success", "decision"]);
export const WIREFRAME_DEVICES: ReadonlySet<string> = new Set(["", "phone", "tablet", "web"]);
export const WIREFRAME_FIDELITY: ReadonlySet<string> = new Set(["", "lo", "tokens"]);

/** Compose error codes (vitrinka parity, handlers_compose.go). `limit`→413, `not_found`→404,
 *  `not_ai_layer`→403, everything else→400. */
export type ComposeErrorCode =
    | "empty"
    | "limit"
    | "bad_kind"
    | "bad_payload"
    | "bad_ref"
    | "bad_question"
    | "bad_journey"
    | "not_found"
    | "not_ai_layer";
