/**
 * Plan contract + pure helpers for the declarative peekaboo capture runner.
 * Types and folding logic only — no process spawning (that's peekaboo.ts /
 * capture-runner.ts).
 */

import { type Annotation, parseRect, type PresetName } from "@genesiscz/utils/image";

export const CAPTURE_HELP = `control capture — declarative peekaboo capture + timed UI actions

USAGE
  tools control capture preflight [--app "<Name>"]   # RUN THIS FIRST when writing a plan:
      # prints JSON with screens (index/points/scaleFactor/framePixels/originCG),
      # frontmost app + window bounds in BOTH points and frame px, active browser
      # tab (url/title) when the app is a known browser, and a suggested plan
      # skeleton. Kills the #1 footgun (guessing units/coords).
  tools control capture clickmap --app "<Name>" [--window-title <t>] [--grid <pts=100>] [--out <png>]
      # coordinate-finder for clicking INSIDE WEB PAGES (peekaboo see/find puts
      # zero boxes on web content): screenshots the app's window and overlays a
      # grid labeled in GLOBAL SCREEN POINTS -> Read the PNG, pick the target's
      # coords off the gridlines, use them directly in click actions.
  tools control capture run <plan.json>       # (or: tools control capture <plan.json>)
  tools control capture recrop <prior-result.json> <plan.json>   # reuse a finished run's frames:
      # applies the new plan's crops (and optional vitrinka publish) WITHOUT re-recording.
      # This is the "reframing" flow: recorded fine but cropped wrong -> fix offline.

GLOSSARY (four different image products — do not confuse)
  frames        full-resolution kept frames from peekaboo (keep-NNNN.png, uncropped)
  crops         individual labeled crop tiles — one per kept frame per crop window
  strip         vertical stack of ALL crop tiles, time-ordered (crops/strip.png)
  strip-review  the strip downscaled to <=1600px longest side (strip-review.png) —
                READ THIS ONE for vision review; the full strip is archival
  contact sheet peekaboo's own contact.png tiling of kept frames — separate product,
                NOT published by include; lives in the session dir

UNITS (four coordinate systems — mixing them is the classic failure)
  coords (click/scroll)   GLOBAL screen POINTS, CG orientation: origin at primary
                          display top-left, negative values legal (displays above/left)
  coords + relativeTo     WINDOW-RELATIVE POINTS: offsets from the target window's
                          top-left corner, same unit as global coords (POINTS, not
                          pixels). Resolved to global points AT FIRE TIME. Don't
                          multiply by scaleFactor — that's only for crop regions.
  region (crop)           FRAME PIXELS = display points x scaleFactor of the captured
                          screen (built-in retina x2). Run preflight for framePixels.
  capture.region          screen POINTS (peekaboo --region), like screencapture -R
  duration                SECONDS (not ms)   ·   atMs / fromMs / toMs   MILLISECONDS

PLAN CONTRACT (TypeScript)

  interface Plan {
      capture: CaptureSpec;       // ignored in recrop mode
      actions: Action[];          // fired at atMs offsets from RECORDING START; ignored in recrop mode
      vitrinka?: VitrinkaSpec;    // optional: publish results to a vitrinka set/board directly
      annotate?: { annotations: Annotation[]; preset?: string };
          // one-shot capture+draw: render these annotations (tools control draw
          // contract — highlight/box/ellipse/arrow/label/blur/crop/grid) onto
          // EVERY kept frame -> <sessionDir>/annotated/<frame>.png, listed in
          // result.annotated. Coordinates are FRAME pixels (crop-region space).
          // CLI shortcut: \`capture run plan.json --annotate <json-or-path>\`.
      browser?: BrowserApp;       // default app for "url" actions (default "Brave Browser")
      focus?: { app: string; windowTitle?: string };
          // bring this app/window frontmost BEFORE recording starts (so frame 1
          // shows the right thing) AND re-asserted before EVERY input action
          // (click/type/hotkey) — focus drifts mid-recording and macOS silently
          // eats synthetic input on non-frontmost windows. Set this in ANY plan
          // that clicks. (Window-mode captures fall back to capture.app.)
          // Multi-phase timelines: "focus"/"focus-stop" ACTIONS re-steer or
          // disable the ambient refocus target mid-recording.
  }

  interface CaptureSpec {
      mode: "screen" | "window" | "region";
      screenIndex?: number;       // screen mode: index from \`peekaboo list screens --json\`
      app?: string;               // window mode
      windowTitle?: string;       // window mode narrowing
      windowIndex?: number;       // window mode narrowing
      region?: string;            // region mode: "x,y,w,h"
      duration: number;           // seconds — REQUIRED (never rely on peekaboo's 60s default)
      activeFps?: number;         // default 8, max 15
      idleFps?: number;           // default 2
      threshold?: number;         // change %% cutoff, default 2.5; ~0.1 for sub-second blips
      videoOut?: string;          // KEEP THE MP4 — enables post-hoc \`peekaboo capture video\` re-sampling
      countdownSec?: number;      // "Recording in 3…2…1" BEFORE capture starts — for USER-driven
          // transitions (human clicks during the recording). Prints to stderr
          // (reliable) and best-effort shows a floating JXA NSPanel near the
          // mouse — CONFIRMED NOT rendering when the runner is agent-spawned
          // (WindowServer compositing limitation; screenshots during countdown
          // show no panel); may render from a human Terminal session. Treat
          // stderr as the real channel. Pointless for fully synthetic plans.
      noRemote?: boolean;         // pass --no-remote (skip bridge hosts, run local)
      captureEngine?: "cg" | "sc"; // pass --capture-engine; "cg" = CoreGraphics.
          // RECOMMENDED DEFAULT FOR AGENT-DRIVEN PLANS: \`noRemote: true,
          // captureEngine: "cg"\` — skips the bridge entirely, which is the
          // flaky part in subprocess contexts (bypass went 4/4 in testing while
          // bridge-path runs stalled). Leave unset only when a human is watching
          // and wants Peekaboo.app's visual feedback. Safety net: if recording
          // never starts within 15s the runner kills the whole attempt-1 process
          // tree, settles 2s, and retries once on the OPPOSITE transport (bridge
          // plan -> bypass retry; bypass plan -> bridge retry — in-process CG
          // needs its own Screen Recording grant, which agent/subprocess TCC
          // ancestry can lack while a bridge host still has it). Failures surface
          // peekaboo's stdout JSON error envelope, not just stderr (warnings[]).
  }

  type OnError = "continue" | "abort";   // default "continue".
      // "abort" skips all REMAINING actions (the capture itself still runs to
      // completion and crops/publish still happen — you get the evidence of what
      // went wrong instead of a torn-down run). Allowed on ANY action — clicks can
      // fail too (bridge crash) — but it earns its keep on the genuinely errorable
      // ones: "osascript" and "url" (AppleScript can reject the dialect, app can
      // be missing), which is where you should reach for it first.

  type Coords = { x: number; y: number } | string;   // GLOBAL screen points;
      // object form preferred; negative values legal on multi-display setups

  interface RelativeTo { app: string; windowTitle?: string }
      // Window-relative coords: when set, coords are treated as POINT offsets
      // from the target window's top-left corner (CG points, same unit as
      // regular click coords), resolved to GLOBAL screen points AT FIRE TIME.
      // This is the fix for stale-coordinate bugs: the window can move between
      // plan authoring and recording, and clicks still land right.
      // ⚠ Units: coords with relativeTo are POINTS (same as without), NOT
      // frame pixels — don't multiply by scaleFactor. Crop regions remain in
      // frame pixels. The UNITS block above documents all three systems.
      // Available on click, hotkey, scroll (coords).

  type Action =
      | { atMs: number; do: "click"; coords: Coords; relativeTo?: RelativeTo; onError?: OnError }

      | { atMs: number; do: "url"; url: string; app?: BrowserApp;
          target?: "new-tab" | "active-tab"; onError?: OnError }
        // DEFAULT target is "new-tab" (\`open -a <app> <url>\`): works in EVERY browser
        // and never clobbers what the user is reading. Use "active-tab" ONLY when the
        // active tab is known to be yours (user said so, or you navigated it earlier
        // this session). active-tab uses AppleScript dialects: Chromium family
        // (set URL of active tab of front window), Safari (front document);
        // Firefox has no dialect -> falls back to new-tab.
        // ALWAYS prefer a url action over hotkey(cmd+l)+type: user keybindings
        // shadow shortcuts (a real cmd+l emitted "$").

      | { atMs: number; do: "osascript"; script: string; onError?: OnError }
        // raw AppleScript escape hatch; stdout/stderr are captured into the
        // action result so you can SEE what it returned or why it failed

      | { atMs: number; do: "hotkey"; keys: string; holdMs?: number; relativeTo?: RelativeTo; onError?: OnError }
        // Key vocabulary: modifiers (cmd/shift/alt/ctrl/fn), a-z, 0-9, space/return/
        // tab/escape/delete/arrows, f1-f12. NO media keys — "volumeup"/"volumedown"/
        // "mute" are auto-rewritten to an osascript volume change; brightness &
        // other media keys just fail. Never invent media keys for screen motion:
        // use a window move (osascript), a url action, or scroll on real content.
      | { atMs: number; do: "type"; text: string; delayMs?: number; relativeTo?: RelativeTo; onError?: OnError }
        // typed with --profile linear (default "human" profile ignores --delay; 26 chars ≈ 7s)
      | { atMs: number; do: "scroll"; direction: "up" | "down" | "left" | "right";
          amount?: number; coords?: Coords; relativeTo?: RelativeTo; app?: string;
          windowTitle?: string; onError?: OnError }
        // ⚠ scroll ok:true only means wheel events were injected — NOT that any
        // content scrolled or pixels changed. Target it: coords moves the cursor
        // there first (macOS scrolls under cursor; negative coords can't be moved
        // to — peekaboo move rejects them); app/windowTitle make peekaboo focus
        // that window first. Untargeted scroll over wallpaper = zero motion.

      | { atMs: number; do: "focus"; app: string; windowTitle?: string; onError?: OnError }
      | { atMs: number; do: "focus-stop"; onError?: OnError }

      | { atMs: number; do: "ax-set"; axId?: string; q?: string; value: string; app: string; onError?: OnError }
      | { atMs: number; do: "ax-press"; axId?: string; q?: string; app: string; onError?: OnError }
      | { atMs: number; do: "ax-perform"; axId?: string; q?: string; action: string; app: string; onError?: OnError }
        // AX actions: interact with native app controls via accessibilityIdentifier
        // (the value of AXIdentifier attribute). Position-independent — immune to
        // window moves. Use for SwiftUI/AppKit apps that set .accessibilityIdentifier()
        // on their controls. ax-set writes the value (text fields); ax-press clicks
        // (buttons/toggles); ax-perform triggers any AX action (AXShowMenu, AXRaise,
        // AXConfirm, AXCancel, AXIncrement, AXDecrement, AXPick — use \`tools ax
        // actions --app X --id Y\` to discover what's available). ax-perform requires
        // the compiled ax-tool binary (no osascript fallback). All three use the fast
        // ax-tool CLI (~50-200ms) when built, osascript fallback for set/press only.
        // Discovery workflow: run \`tools ax find --app X --role AXButton\` or
        // \`tools ax list --app X\` to find element AXIdentifiers, then use them in
        // the plan. \`tools ax window --app X\` gives window bounds in CG points
        // (same coordinate system as click coords / relativeTo).
        // Requires the app process name (as shown in Activity Monitor), NOT the
        // display name — for "Genesis.app", app is "Genesis".
        // Examples:
        //   // Fill a login form without coordinates:
        //   { "atMs": 500, "do": "ax-set", "axId": "auth-email", "value": "a@b.com", "app": "Genesis" },
        //   { "atMs": 1500, "do": "ax-set", "axId": "auth-password", "value": "s3cr3t", "app": "Genesis" },
        //   { "atMs": 2500, "do": "ax-press", "axId": "auth-continue", "app": "Genesis" }
        //   // Open a dropdown menu:
        //   { "atMs": 500, "do": "ax-perform", "axId": "theme-picker", "action": "AXShowMenu", "app": "Genesis" }
        // Focus WINDOW markers (same timeline-marker pattern as crop/crop-stop):
        // "focus" asserts the app/window frontmost at its atMs AND makes that app
        // the ambient refocus target — every later click/type/hotkey re-asserts
        // it (~120ms osascript activate) right before firing, so mid-recording
        // focus drift can't eat input. "focus-stop" disables refocusing from its
        // atMs on. Until the first marker the ambient target is plan.focus (or
        // capture.app in window mode). There is NO background re-assert timer:
        // refocusing per input action IS the recheck. Use for multi-phase plans
        // (click app A, then app B) — single-app plans just set plan.focus.

      | { atMs: number; do: "crop"; region?: Region; label?: string; toMs?: number;
          target?: { app: string; windowTitle?: string } }
      | { atMs: number; do: "crop-stop" };
        // Crop markers live in the SAME timeline as interactions. Two modes:
        //   SEQUENTIAL (no toMs): a "crop" opens a window at atMs (closing the
        //     previous open one), "crop-stop" closes it; the last open window runs
        //     to capture end. One region at a time.
        //   EXPLICIT-WINDOW (toMs set): the crop covers [atMs, toMs] as its own
        //     standalone window and does NOT open/close the sequential one — so
        //     you can OVERLAP crops: two (or more) regions cropped from the SAME
        //     frames (e.g. topbar + a modal at once). Give each an explicit toMs.
        // Give region (frame px) OR target: with target, the window's bounds are
        // looked up AT THE MARKER'S atMs (frozen then — later window moves are NOT
        // tracked) and converted to frame px automatically. target only works for
        // screen-mode captures; if the lookup fails the marker is dropped with a
        // warning. Example (sequential + one overlapping explicit-window crop):
        //   { "atMs": 0,    "do": "crop", "region": {...}, "label": "topbar" },
        //   { "atMs": 0,    "do": "crop", "region": {...}, "label": "sidebar", "toMs": 8000 },
        //   { "atMs": 4200, "do": "click", "coords": { "x": 553, "y": 693 } },
        //   { "atMs": 5200, "do": "crop", "target": { "app": "Finder" }, "label": "finder" },
        //   { "atMs": 8000, "do": "crop-stop" }

  type BrowserApp = "Brave Browser" | "Google Chrome" | "Chromium" | "Microsoft Edge"
      | "Arc" | "Vivaldi" | "Opera" | "Safari" | "Firefox" | string;

  type Region = { x: number; y: number; w: number; h: number } | string;  // string "x,y,w,h" accepted too
      // ⚠ Region is in FRAME pixels. Kept frames are FULL-RETINA: display points ×
      // scaleFactor (built-in retina = ×2; external 1x displays = ×1). Check
      // \`peekaboo list screens --json\` scaleFactor and multiply your point coords.

  // Every kept frame in a crop window gets that region cropped into
  // <sessionDir>/crops[-N]/ with a timestamp label row; all crops stack
  // time-ordered into strip.png. Originals stay untouched. Labels ASCII only.

  interface VitrinkaSpec {
      project: string;            // e.g. "pizzeria"
      key: string;                // set key (unique per publish)
      branch?: string;            // default "review"
      title?: string;             // set title
      board?: string;             // board slug -> \`vitrinka board-from-set --slug <board>\` after push
      include?: ("strip" | "crops" | "frames")[];  // what to publish; default ["strip"]
      route?: string;             // vitrinka add --route (default "/")
      note?: string;              // shared note for the shots
      force?: boolean;            // publish even a 1-frame no-motion capture (default: refuse)
  }
  // include semantics — PUBLISH filter only; crops/strip are still COMPUTED
  // locally whenever crop windows exist. Entries are ADDITIVE:
  //   ["strip"]           strip.png only (default) — errors if no crop produced one
  //   ["frames"]          full frames only; strip stays local, never uploaded
  //   ["crops"]           each labeled tile (excludes the strip file itself)
  //   ["strip","frames"]  both, as separate shots in the set
  // Shot titles come from crop labels/timestamps ("topbar t=1620ms"), frames
  // get "frame t=<ms>". Publishing is best-effort: failures land in
  // output.vitrinka.error, never crash the run. URLs are relayed verbatim.
  // DEAD-PUBLISH GUARD: when the plan fired motion actions but peekaboo kept
  // <=1 frame (noMotion), publish is refused unless force — this is what used
  // to litter boards with 1-frame "strips".

RESULT SCHEMA (stdout JSON)
  interface RunResult {
      sessionDir: string;           // peekaboo session dir with kept frames
      exitCode: number;             // peekaboo exit code
      warnings: string[];           // READ THESE — "ok" actions can still be wrong
      actions: ActionResult[];      // one per fired action, in timeline order
      crops: CropOut[];             // one per cropped tile (label + path + ok)
      strip: string | null;         // path to crops/strip.png (all tiles stacked)
      stripReview: string | null;   // path to crops/strip-review.png (<=1600px)
      vitrinka?: { ok: boolean; urls: string[]; error?: string };
      annotated?: string[];         // paths under <sessionDir>/annotated/, when plan.annotate is set
      captureFailed: boolean;       // true when the recording itself failed
      capture: unknown;             // raw peekaboo result JSON
  }
  interface ActionResult {
      action: Action;               // the original action from the plan
      plannedMs: number;            // the atMs from the plan
      actualMs: number;             // wall-clock ms from recording start (-1 if skipped)
      ok: boolean;
      skipped?: boolean;            // true if aborted by a prior onError:"abort"
      stdout?: string;              // peekaboo/osascript stdout (truncated to 500)
      data?: unknown;               // parsed JSON data from peekaboo --json
      error?: string;               // present when ok is false
  }
  interface CropOut {
      frame: string;                // source frame filename
      timestampMs: number;
      label: string;
      path: string;                 // absolute path to cropped tile PNG
      ok: boolean;
  }

EXAMPLE PLAN
  {
    "capture": { "mode": "screen", "screenIndex": 0, "duration": 9, "activeFps": 15,
                 "threshold": 0.1, "videoOut": "/tmp/run.mp4" },
    "actions": [
      { "atMs": 0,    "do": "crop", "region": { "x": 880, "y": 296, "w": 2360, "h": 170 }, "label": "topbar" },
      { "atMs": 400,  "do": "url", "url": "http://localhost:2021/restaurants",
        "app": "Brave Browser", "target": "active-tab" },
      { "atMs": 3200, "do": "click", "coords": { "x": 200, "y": 539 }, "relativeTo": { "app": "Brave Browser" } },
      { "atMs": 4200, "do": "click", "coords": { "x": 553, "y": 693 }, "onError": "abort" }
    ],
    "vitrinka": { "project": "pizzeria", "key": "run-topbar", "board": "my-board", "include": ["strip"] }
  }

NOTES
  - SPA links can swallow the first synthetic click when the app isn't frontmost
    (macOS click-to-focus). Plan a sacrificial click ~1s before the real one, or
    use plan.focus to make the target frontmost before recording.
  - Actions that run long push later actions back; every action reports plannedMs
    vs actualMs (plus stdout/stderr for url/osascript) — audit before trusting frames.
  - You CANNOT request "exactly N frames": duration/fps/threshold set a budget and
    peekaboo keeps K frames where motion crossed threshold. Need fewer tiles?
    Raise threshold, lower fps, shorten the crop window — or recrop.
  - Plans are validated on load; suspicious values (duration > 180 — seconds, not
    ms!; threshold > 100; zero-size regions) produce warnings in the result JSON.
  - The run result carries a warnings[] array — READ IT. "actions fired but only
    1 frame kept" means your motion never made it to pixels (wrong screen, wrong
    focus, scroll over dead UI).
  - ⚠ BLUE BUG: \`peekaboo capture video <mp4> --no-diff\` (the offline re-sample
    path) currently corrupts colors — frames come out blue-tinted (decode bug,
    avg RGB 26,28,32 -> 28,26,253). Live-kept frames from the same recording are
    fine. Until fixed upstream, prefer higher --active-fps live capture over
    no-diff re-sampling; keep videoOut anyway for when the bug is fixed.
`;

export type OnError = "continue" | "abort";

export type Coords = { x: number; y: number } | string;

export type Region = { x: number; y: number; w: number; h: number } | string;

export interface CropTarget {
    app: string;
    windowTitle?: string;
}

export interface RelativeTo {
    app: string;
    windowTitle?: string;
}

export type Action =
    | { atMs: number; do: "click"; coords: Coords; relativeTo?: RelativeTo; onError?: OnError }
    | { atMs: number; do: "url"; url: string; app?: string; target?: "new-tab" | "active-tab"; onError?: OnError }
    | { atMs: number; do: "osascript"; script: string; onError?: OnError }
    | { atMs: number; do: "hotkey"; keys: string; holdMs?: number; relativeTo?: RelativeTo; onError?: OnError }
    | { atMs: number; do: "type"; text: string; delayMs?: number; relativeTo?: RelativeTo; onError?: OnError }
    | {
          atMs: number;
          do: "scroll";
          direction: "up" | "down" | "left" | "right";
          amount?: number;
          coords?: Coords;
          relativeTo?: RelativeTo;
          app?: string;
          windowTitle?: string;
          onError?: OnError;
      }
    // focus markers steer the ambient refocus target mid-timeline (same
    // marker pattern as crop/crop-stop); see the ambientFocusApp comment.
    | { atMs: number; do: "focus"; app: string; windowTitle?: string; onError?: OnError }
    | { atMs: number; do: "focus-stop"; onError?: OnError }
    // crop markers live in the SAME timeline as interactions; region markers fire
    // nothing at runtime, target markers do a bounds lookup at their atMs.
    // toMs makes the crop a standalone [atMs, toMs] window (overlap-capable);
    // without it the marker is sequential (opens/closes the single running window).
    | {
          atMs: number;
          do: "crop";
          region?: Region;
          label?: string;
          toMs?: number;
          target?: CropTarget;
          onError?: OnError;
      }
    | { atMs: number; do: "crop-stop"; onError?: OnError }
    // AX actions: target by axId (AXIdentifier, exact) OR q (universal search:
    // id > title > desc > value > role > subrole, fuzzy, refuses if ambiguous).
    // Elements WITHOUT AXIdentifier (browser tabs, toolbar buttons) work via q.
    | { atMs: number; do: "ax-set"; axId?: string; q?: string; value: string; app: string; onError?: OnError }
    | { atMs: number; do: "ax-press"; axId?: string; q?: string; app: string; onError?: OnError }
    | { atMs: number; do: "ax-perform"; axId?: string; q?: string; action: string; app: string; onError?: OnError };

export interface CaptureSpec {
    mode: "screen" | "window" | "region";
    screenIndex?: number;
    app?: string;
    windowTitle?: string;
    windowIndex?: number;
    region?: string;
    duration: number;
    activeFps?: number;
    idleFps?: number;
    threshold?: number;
    videoOut?: string;
    countdownSec?: number;
    noRemote?: boolean;
    captureEngine?: "cg" | "sc";
}

export interface CropSpec {
    fromMs: number;
    toMs?: number;
    region: Region;
    label?: string;
}

export interface VitrinkaSpec {
    project: string;
    key: string;
    branch?: string;
    title?: string;
    board?: string;
    include?: ("strip" | "crops" | "frames")[];
    route?: string;
    note?: string;
    force?: boolean;
}

export interface Plan {
    capture: CaptureSpec;
    actions: Action[];
    vitrinka?: VitrinkaSpec;
    browser?: string;
    focus?: { app: string; windowTitle?: string };
    /**
     * One-shot capture+draw (spec §1.1): after the recording, render these
     * annotations onto every kept frame → <sessionDir>/annotated/<frame>.png.
     * Coordinates are FRAME pixels (same space as crop regions). The CLI
     * `--annotate <json-or-path>` flag fills this field.
     */
    annotate?: { annotations: Annotation[]; preset?: PresetName };
}

export interface FrameInfo {
    file: string;
    path: string;
    timestampMs: number;
    changePercent?: number;
}

export interface FiredAction {
    action: Action;
    plannedMs: number;
    actualMs: number;
    ok: boolean;
    stdout?: string;
    error?: string;
    skipped?: boolean;
    data?: unknown;
}

export interface CropOut {
    frame: string;
    timestampMs: number;
    label: string;
    path: string;
    ok: boolean;
    error?: string;
}

export function parseRegion(r: Region): { x: number; y: number; w: number; h: number } {
    return parseRect(r);
}

export function coordsToString(c: Coords): string {
    if (typeof c === "string") {
        return c;
    }

    return `${c.x},${c.y}`;
}

// Fold timeline crop markers into CropSpecs. Two modes:
//   SEQUENTIAL (no toMs): a "crop" opens a window at its atMs (closing any
//     previous open one); "crop-stop" closes it; the last open window runs to
//     capture end. Only one open at a time.
//   EXPLICIT-WINDOW (toMs set): the crop is its own standalone [atMs, toMs]
//     spec that does NOT touch the sequential open window — this is what lets
//     crops OVERLAP (multiple regions cropped from the same frames).
export function extractCropSpecs(actions: Action[]): CropSpec[] {
    const specs: CropSpec[] = [];
    let open: CropSpec | null = null;

    for (const a of [...actions].sort((x, y) => x.atMs - y.atMs)) {
        if (a.do === "crop") {
            if (!a.region) {
                // target marker whose bounds lookup failed (or was never run) —
                // already surfaced as a warning; don't produce a broken spec
                continue;
            }

            if (a.toMs !== undefined) {
                // explicit-window: standalone, overlap-capable, leaves the
                // sequential open window untouched
                specs.push({ fromMs: a.atMs, toMs: a.toMs, region: a.region, label: a.label });
                continue;
            }

            if (open) {
                open.toMs = a.atMs;
            }

            open = { fromMs: a.atMs, region: a.region, label: a.label };
            specs.push(open);
        } else if (a.do === "crop-stop") {
            if (open) {
                open.toMs = a.atMs;
                open = null;
            }
        }
    }

    return specs;
}

export function validatePlan(plan: Plan): string[] {
    const warnings: string[] = [];
    const cap = plan.capture;

    if (cap?.duration > 180) {
        warnings.push(`capture.duration=${cap.duration} — unit is SECONDS; did you mean ms?`);
    }

    if (cap?.threshold !== undefined && cap.threshold > 100) {
        warnings.push(`capture.threshold=${cap.threshold} — unit is percent (0-100)`);
    }

    for (const a of plan.actions ?? []) {
        if (a.do === "crop") {
            if (!a.region && !a.target) {
                warnings.push(`crop marker at ${a.atMs}ms has neither region nor target — dropped`);
            } else if (a.region) {
                const r = parseRegion(a.region);
                if (!(r.w > 0) || !(r.h > 0)) {
                    warnings.push(`crop marker at ${a.atMs}ms has zero-size region`);
                }
            }
            if (a.toMs !== undefined && a.toMs <= a.atMs) {
                warnings.push(`crop marker at ${a.atMs}ms has toMs (${a.toMs}) <= atMs — empty window`);
            }
        }
    }

    return warnings;
}
