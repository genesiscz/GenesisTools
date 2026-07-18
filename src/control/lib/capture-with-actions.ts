#!/usr/bin/env bun
/**
 * Declarative peekaboo capture+actions runner.
 *
 * Solves the agent-latency problem: an LLM driving capture + UI actions through
 * separate tool calls is seconds late (model thinking + MCP round-trips), so the
 * recording misses the transition. This script owns the whole timeline in one
 * process: it starts `peekaboo capture live`, detects the actual recording start
 * (first frame file on disk), then fires each action at its exact offset.
 *
 * Modes:
 *   bun capture-with-actions.ts <plan.json>                     # record + act + crop + (optional) publish
 *   bun capture-with-actions.ts recrop <result.json> <plan.json># re-crop frames of a PRIOR run (no re-record)
 *   bun capture-with-actions.ts --help                          # full TS contract
 *
 * Output (stdout): one JSON object — { sessionDir, exitCode, actions, crops, strip, vitrinka, capture }.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeJSON } from "@app/utils/json";

const HELP = `capture-with-actions — declarative peekaboo capture + timed UI actions

USAGE
  bun capture-with-actions.ts preflight [--app "<Name>"]   # RUN THIS FIRST when writing a plan:
      # prints JSON with screens (index/points/scaleFactor/framePixels/originCG),
      # frontmost app + window bounds in BOTH points and frame px, active browser
      # tab (url/title) when the app is a known browser, and a suggested plan
      # skeleton. Kills the #1 footgun (guessing units/coords).
  bun capture-with-actions.ts clickmap --app "<Name>" [--window-title <t>] [--grid <pts=100>] [--out <png>]
      # coordinate-finder for clicking INSIDE WEB PAGES (peekaboo see/find puts
      # zero boxes on web content): screenshots the app's window and overlays a
      # grid labeled in GLOBAL SCREEN POINTS -> Read the PNG, pick the target's
      # coords off the gridlines, use them directly in click actions.
  bun capture-with-actions.ts <plan.json>
  bun capture-with-actions.ts recrop <prior-result.json> <plan.json>   # reuse a finished run's frames:
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
  // time-ordered into strip.png. Originals stay untouched. Labels ASCII only
  // (imagemagick fallback font garbles unicode).

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

type OnError = "continue" | "abort";

type Coords = { x: number; y: number } | string;

type Region = { x: number; y: number; w: number; h: number } | string;

interface CropTarget {
    app: string;
    windowTitle?: string;
}

interface RelativeTo {
    app: string;
    windowTitle?: string;
}

type Action =
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

interface CaptureSpec {
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

interface CropSpec {
    fromMs: number;
    toMs?: number;
    region: Region;
    label?: string;
}

interface VitrinkaSpec {
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

interface Plan {
    capture: CaptureSpec;
    actions: Action[];
    vitrinka?: VitrinkaSpec;
    browser?: string;
    focus?: { app: string; windowTitle?: string };
}

interface FrameInfo {
    file: string;
    path: string;
    timestampMs: number;
    changePercent?: number;
}

interface FiredAction {
    action: Action;
    plannedMs: number;
    actualMs: number;
    ok: boolean;
    stdout?: string;
    error?: string;
    skipped?: boolean;
    data?: unknown;
}

interface CropOut {
    frame: string;
    timestampMs: number;
    label: string;
    path: string;
    ok: boolean;
    error?: string;
}

function fail(msg: string): never {
    console.error(`capture-with-actions: ${msg}`);
    process.exit(2);
}

function parseRegion(r: Region): { x: number; y: number; w: number; h: number } {
    if (typeof r === "string") {
        const [x, y, w, h] = r.split(",").map((n) => Number(n.trim()));
        return { x, y, w, h };
    }

    return r;
}

function coordsToString(c: Coords): string {
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
function extractCropSpecs(actions: Action[]): CropSpec[] {
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

const CHROMIUM_APPS = new Set([
    "Brave Browser",
    "Google Chrome",
    "Chromium",
    "Microsoft Edge",
    "Arc",
    "Vivaldi",
    "Opera",
]);

// Every spawned command gets a hard timeout: a wedged bridge makes peekaboo
// block for 20s+, and ONE blocking lookup inside the action loop shoves every
// later action off the timeline (observed live: atMs 2000 fired at 20369ms).
function runCmd(cmd: string[], timeoutMs = 15_000): { ok: boolean; stdout: string; stderr: string } {
    const r = Bun.spawnSync(cmd, { timeout: timeoutMs, killSignal: "SIGKILL" });
    return {
        ok: r.exitCode === 0,
        stdout: r.stdout.toString().trim().slice(0, 500),
        stderr: (r.stderr.toString().trim() || (r.exitCode !== 0 ? `timed out/killed after ${timeoutMs}ms` : "")).slice(
            0,
            500
        ),
    };
}

// peekaboo occasionally prefixes stdout with visualizer/info noise lines —
// parse from the first "{" so --json output survives it.
function runPeekabooJson(
    args: string[],
    timeoutMs = 15_000
): { ok: boolean; data?: unknown; stdout: string; stderr: string } {
    const r = Bun.spawnSync(["peekaboo", ...args, "--json"], { timeout: timeoutMs, killSignal: "SIGKILL" });
    const raw = r.stdout.toString();
    const start = raw.indexOf("{");
    let data: unknown;

    if (start >= 0) {
        try {
            const parsed: unknown = SafeJSON.parse(raw.slice(start));
            // keep results small: peekaboo envelopes carry debug_logs/metadata
            // noise — the useful payload is .data
            data =
                parsed !== null && typeof parsed === "object" && "data" in parsed
                    ? (parsed as { data: unknown }).data
                    : parsed;
        } catch {
            data = undefined;
        }
    }

    return {
        ok: r.exitCode === 0,
        data,
        stdout: raw.trim().slice(0, 500),
        stderr: r.stderr.toString().trim().slice(0, 500),
    };
}

interface ScreenInfo {
    index: number;
    name: string;
    isPrimary: boolean;
    points: { width: number; height: number };
    scaleFactor: number;
    framePixels: { width: number; height: number };
    // top-left origin of this screen in GLOBAL CG points — the space click
    // coords and window bounds live in (peekaboo `list screens` positions are
    // Cocoa-flipped; converted here so agents never have to)
    originCG: { x: number; y: number };
}

// list lookups run inside the action timeline — keep them FAST: 4s via the
// bridge, then one --no-remote retry (local AX/CG; works when the bridge is
// wedged, may lack grants in exotic setups — the caller surfaces a warning).
function runPeekabooListJson(args: string[]): { ok: boolean; data?: unknown; stdout: string; stderr: string } {
    const r = runPeekabooJson(args, 4_000);
    if (r.ok && r.data !== undefined) {
        return r;
    }

    return runPeekabooJson([...args, "--no-remote"], 6_000);
}

function listScreens(): ScreenInfo[] {
    const r = runPeekabooListJson(["list", "screens"]);
    // runPeekabooJson already unwrapped the envelope's .data
    const screens =
        (
            r.data as {
                screens?: {
                    index: number;
                    name: string;
                    isPrimary: boolean;
                    scaleFactor: number;
                    position: { x: number; y: number };
                    resolution: { width: number; height: number };
                }[];
            }
        )?.screens ?? [];
    const primary = screens.find((s) => s.isPrimary) ?? screens[0];
    const primaryH = primary?.resolution.height ?? 0;

    return screens.map((s) => ({
        index: s.index,
        name: s.name,
        isPrimary: s.isPrimary,
        points: { width: s.resolution.width, height: s.resolution.height },
        scaleFactor: s.scaleFactor,
        framePixels: { width: s.resolution.width * s.scaleFactor, height: s.resolution.height * s.scaleFactor },
        originCG: { x: s.position.x, y: primaryH - (s.position.y + s.resolution.height) },
    }));
}

interface WindowBounds {
    title: string;
    index: number;
    isMainWindow: boolean;
    // CG points: [[x, y], [w, h]]
    x: number;
    y: number;
    w: number;
    h: number;
}

function listWindowBounds(app: string): WindowBounds[] {
    const r = runPeekabooListJson(["list", "windows", "--app", app, "--include-details", "bounds"]);
    const wins =
        (
            r.data as {
                windows?: {
                    title: string;
                    index: number;
                    isMainWindow: boolean;
                    isMinimized: boolean;
                    bounds?: [[number, number], [number, number]];
                }[];
            }
        )?.windows ?? [];

    return wins
        .filter((w) => !w.isMinimized && w.bounds)
        .map((w) => ({
            title: w.title,
            index: w.index,
            isMainWindow: w.isMainWindow,
            x: w.bounds![0][0],
            y: w.bounds![0][1],
            w: w.bounds![1][0],
            h: w.bounds![1][1],
        }));
}

// Freeze a target window's bounds NOW and convert to frame pixels of the
// captured screen. Returns null (with a reason) when unresolvable.
function pickLargestWindow(wins: WindowBounds[]): WindowBounds | undefined {
    // Some apps report phantom AX windows with absurd bounds (observed live:
    // cmux "window" of 250157x350019 points) — largest-area must not pick those.
    const plausible = wins.filter((w) => w.w <= 20_000 && w.h <= 20_000);
    return (plausible.length > 0 ? plausible : wins).slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
}

function resolveTargetRegion(
    target: CropTarget,
    screen: ScreenInfo
): { region: { x: number; y: number; w: number; h: number } } | { error: string } {
    const wins = listWindowBounds(target.app);
    if (wins.length === 0) {
        return { error: `no windows for app "${target.app}"` };
    }

    // Only windows intersecting the CAPTURED screen can appear in the recording
    // — local AX lookups also list windows on other displays/Spaces (observed:
    // a stale window on another Space kept winning largest-area). Rank inside
    // the screen first; isMainWindow stays untrusted (menu-strip phantoms).
    const sx = screen.originCG.x;
    const sy = screen.originCG.y;
    const onScreen = wins.filter(
        (w) => w.x < sx + screen.points.width && w.x + w.w > sx && w.y < sy + screen.points.height && w.y + w.h > sy
    );
    const pool = onScreen.length > 0 ? onScreen : wins;

    const match = target.windowTitle
        ? pool.find((w) => w.title.toLowerCase().includes(target.windowTitle!.toLowerCase()))
        : pickLargestWindow(pool);
    if (!match) {
        return {
            error: `no window of "${target.app}" matches title "${target.windowTitle}" on captured screen ${screen.index}`,
        };
    }

    const sf = screen.scaleFactor;
    const region = {
        x: Math.round((match.x - screen.originCG.x) * sf),
        y: Math.round((match.y - screen.originCG.y) * sf),
        w: Math.round(match.w * sf),
        h: Math.round(match.h * sf),
    };

    if (
        region.x + region.w <= 0 ||
        region.y + region.h <= 0 ||
        region.x >= screen.framePixels.width ||
        region.y >= screen.framePixels.height
    ) {
        return { error: `window "${match.title || target.app}" lies outside captured screen ${screen.index}` };
    }

    // clamp to the frame so magick never crops thin air
    const x = Math.max(0, region.x);
    const y = Math.max(0, region.y);
    return {
        region: {
            x,
            y,
            w: Math.min(region.w - (x - region.x), screen.framePixels.width - x),
            h: Math.min(region.h - (y - region.y), screen.framePixels.height - y),
        },
    };
}

// Resolve window-relative coords to global CG coords at fire time.
// coords are offsets from the window's top-left in CG points; this looks up
// the window's current position and adds the offset. Returns the global coords
// string "x,y" or an error.
function resolveRelativeCoords(coords: Coords, rel: RelativeTo): { global: string } | { error: string } {
    const wins = listWindowBounds(rel.app);
    if (wins.length === 0) {
        return { error: `relativeTo: no windows for "${rel.app}"` };
    }

    const match = rel.windowTitle
        ? wins.find((w) => w.title.toLowerCase().includes(rel.windowTitle!.toLowerCase()))
        : pickLargestWindow(wins.filter((w) => w.h > 50));
    if (!match) {
        return { error: `relativeTo: no window of "${rel.app}" matches title "${rel.windowTitle}"` };
    }

    const c =
        typeof coords === "string"
            ? (() => {
                  const [x, y] = coords.split(",").map(Number);
                  return { x, y };
              })()
            : coords;

    return { global: `${match.x + c.x},${match.y + c.y}` };
}

// ax-tool binary: compiled Swift CLI (~30-75x faster than osascript).
// Source of truth is native/ax-tool/ in this repo (`bun run build:native`).
// Falls back to osascript if not built.
const AX_TOOL_PATH = join(import.meta.dir, "..", "..", "..", "native", "ax-tool", ".build", "release", "ax-tool");
const AX_TOOL_AVAILABLE = existsSync(AX_TOOL_PATH);

function runAxAction(
    app: string,
    axId: string | undefined,
    mode: "set" | "press" | "perform",
    value?: string,
    axAction?: string,
    q?: string
): { ok: boolean; stdout: string; stderr: string } {
    if (AX_TOOL_AVAILABLE) {
        return runAxActionFast(app, axId, mode, value, axAction, q);
    }
    if (mode === "perform" || q) {
        return {
            ok: false,
            stdout: "",
            stderr: "ax-perform and --q targeting require ax-tool binary (not built); only ax-set/ax-press with axId have osascript fallback",
        };
    }
    if (!axId) {
        return { ok: false, stdout: "", stderr: "axId required for osascript fallback" };
    }
    return runAxActionOsascript(app, axId, mode, value);
}

// Fast path: compiled Swift CLI calling C AX API directly (~50-200ms)
function runAxActionFast(
    app: string,
    axId: string | undefined,
    mode: "set" | "press" | "perform",
    value?: string,
    axAction?: string,
    q?: string
): { ok: boolean; stdout: string; stderr: string } {
    const args = [AX_TOOL_PATH, mode, "--app", app];
    if (q) {
        args.push("--q", q);
    } else if (axId) {
        args.push("--id", axId);
    }
    if (mode === "set" && value !== undefined) {
        args.push("--value", value);
    }
    if (mode === "perform" && axAction !== undefined) {
        args.push("--action", axAction);
    }
    const r = runCmd(args, 6_000);
    // ax-tool outputs JSON; parse to check ok field
    try {
        const parsed = SafeJSON.parse(r.stdout);
        if (parsed.ok === false) {
            return { ok: false, stdout: r.stdout, stderr: parsed.error || r.stderr };
        }
        return { ok: true, stdout: r.stdout, stderr: "" };
    } catch {
        return r;
    }
}

// Slow fallback: osascript + System Events (~2-5s)
function runAxActionOsascript(
    app: string,
    axId: string,
    mode: "set" | "press",
    value?: string
): { ok: boolean; stdout: string; stderr: string } {
    const escapedId = axId.replace(/"/g, '\\"');
    const escapedApp = app.replace(/"/g, '\\"');

    let script: string;
    if (mode === "set") {
        const escapedVal = (value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        script = `
tell application "System Events"
    tell process "${escapedApp}"
        set allElements to entire contents of window 1
        repeat with e in allElements
            try
                if value of attribute "AXIdentifier" of e is "${escapedId}" then
                    set value of e to "${escapedVal}"
                    return "ok"
                end if
            end try
        end repeat
        return "not found: ${escapedId}"
    end tell
end tell`;
    } else {
        script = `
tell application "System Events"
    tell process "${escapedApp}"
        set allElements to entire contents of window 1
        repeat with e in allElements
            try
                if value of attribute "AXIdentifier" of e is "${escapedId}" then
                    perform action "AXPress" of e
                    return "ok"
                end if
            end try
        end repeat
        return "not found: ${escapedId}"
    end tell
end tell`;
    }

    const r = runCmd(["osascript", "-e", script], 10_000);
    if (r.ok && r.stdout.includes("not found")) {
        return { ok: false, stdout: r.stdout, stderr: `AX element "${axId}" not found in ${app}` };
    }

    return r;
}

// Media keys are not in peekaboo's key vocabulary — rewrite the common ones to
// osascript so "hotkey volumeup" does what the author meant instead of erroring.
const MEDIA_KEY_SCRIPTS: Record<string, string> = {
    volumeup: "set volume output volume (((output volume of (get volume settings)) + 10))",
    volumedown: "set volume output volume (((output volume of (get volume settings)) - 10))",
    mute: "set volume with output muted",
    unmute: "set volume without output muted",
};

// "Recording in N…" countdown for user-driven captures. stderr always; plus a
// best-effort floating overlay near the mouse via JXA NSPanel. JXA landmines
// (from live debugging, do not "simplify"): CALayer.setBackgroundColor hangs
// the runtime — use NSPanel.setBackgroundColor; orderFrontRegardless/close are
// silent no-ops without the () call parens.
function countdownOverlayScript(sec: number): string {
    return `ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
function run() {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var loc = $.CGEventGetLocation($.CGEventCreate(null));
  var screenHeight = $.NSScreen.mainScreen.frame.size.height;
  var winW = 300, winH = 70;
  var rect = $.NSMakeRect(loc.x - winW / 2, (screenHeight - loc.y) - winH - 40, winW, winH);
  var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    rect, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  panel.setLevel($.NSFloatingWindowLevel + 1);
  panel.setOpaque(false);
  panel.setBackgroundColor($.NSColor.blackColor.colorWithAlphaComponent(0.8));
  panel.setIgnoresMouseEvents(true);
  var label = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, winW, winH));
  label.setEditable(false); label.setBordered(false); label.setDrawsBackground(false);
  label.setAlignment($.NSTextAlignmentCenter);
  label.setTextColor($.NSColor.whiteColor);
  label.setFont($.NSFont.boldSystemFontOfSize(20));
  panel.setContentView(label);
  panel.orderFrontRegardless();
  for (var i = ${sec}; i >= 1; i--) {
    label.setStringValue('Recording in ' + i + '\\u2026 don\\u0027t move the mouse');
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1.0));
  }
  panel.close();
}`;
}

async function runCountdown(sec: number): Promise<void> {
    // overlay runs detached and paces itself; stderr ticks are the guaranteed channel
    const overlay = Bun.spawn(["osascript", "-l", "JavaScript", "-e", countdownOverlayScript(sec)], {
        stdout: "ignore",
        stderr: "ignore",
    });
    overlay.unref();

    for (let i = sec; i >= 1; i--) {
        console.error(`capture-with-actions: recording in ${i}… don't move mouse/keyboard`);
        await Bun.sleep(1000);
    }
}

function validatePlan(plan: Plan): string[] {
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

function focusWindow(
    target: { app: string; windowTitle?: string },
    timeoutMs = 15_000
): { ok: boolean; via: "peekaboo" | "osascript" | "none"; detail: string } {
    const cmd = ["peekaboo", "window", "focus", "--app", target.app];
    if (target.windowTitle) {
        cmd.push("--window-title", target.windowTitle);
    }

    const r = runCmd(cmd, timeoutMs);
    if (r.ok) {
        return { ok: true, via: "peekaboo", detail: "" };
    }

    // window focus routes through the bridge too — osascript activate is the
    // bridge-free fallback (app-level only; windowTitle ignored)
    const f = runCmd(["osascript", "-e", `tell application "${target.app}" to activate`], timeoutMs);
    return f.ok
        ? { ok: true, via: "osascript", detail: "" }
        : { ok: false, via: "none", detail: f.stderr || f.stdout || r.stderr || r.stdout };
}

function navigateBrowser(app: string, url: string, target: "new-tab" | "active-tab") {
    if (target === "active-tab") {
        if (app === "Safari") {
            return runCmd(["osascript", "-e", `tell application "Safari" to set URL of front document to "${url}"`]);
        }

        if (CHROMIUM_APPS.has(app)) {
            return runCmd([
                "osascript",
                "-e",
                `tell application "${app}" to set URL of active tab of front window to "${url}"`,
            ]);
        }
        // No AppleScript dialect (Firefox & friends) — new tab is the only option.
    }

    return runCmd(["open", "-a", app, url]);
}

function applyCrops(
    sessionDir: string,
    frames: FrameInfo[],
    specs: CropSpec[]
): { crops: CropOut[]; strip: string | null; stripReview: string | null } {
    const crops: CropOut[] = [];
    let strip: string | null = null;
    let stripReview: string | null = null;
    const sorted = specs.slice().sort((a, b) => a.fromMs - b.fromMs);

    let cropDir = join(sessionDir, "crops");
    for (let n = 2; existsSync(cropDir); n++) {
        cropDir = join(sessionDir, `crops-${n}`);
    }

    mkdirSync(cropDir, { recursive: true });

    for (let i = 0; i < sorted.length; i++) {
        const spec = sorted[i];
        // extractCropSpecs sets an explicit toMs on every window except the final
        // still-open sequential one, which runs to capture end. Don't fall back to
        // the next spec's fromMs — that would wrongly clip overlapping windows.
        const end = spec.toMs ?? Number.POSITIVE_INFINITY;
        const { x, y, w, h } = parseRegion(spec.region);

        for (const f of frames) {
            if (f.timestampMs < spec.fromMs || f.timestampMs >= end) {
                continue;
            }

            const label = `${spec.label ?? `crop${i}`} t=${f.timestampMs}ms`;
            const outPath = join(cropDir, `${f.file.replace(/\.png$/, "")}-${spec.label ?? `crop${i}`}.png`);
            const r = Bun.spawnSync([
                "magick",
                f.path,
                "-crop",
                `${w}x${h}+${x}+${y}`,
                "+repage",
                "-bordercolor",
                "#181818",
                "-border",
                "0x2",
                "(",
                "-size",
                `${w}x34`,
                "-background",
                "#181818",
                "-fill",
                "#ffb020",
                "-pointsize",
                "20",
                "-gravity",
                "west",
                `label:  ${label}`,
                ")",
                "+swap",
                "-append",
                outPath,
            ]);
            crops.push({
                frame: f.file,
                timestampMs: f.timestampMs,
                label,
                path: outPath,
                ok: r.exitCode === 0 && existsSync(outPath),
                error: r.exitCode === 0 ? undefined : r.stderr.toString().slice(0, 200),
            });
        }
    }

    const good = crops.filter((c) => c.ok).sort((a, b) => a.timestampMs - b.timestampMs);
    if (good.length > 1) {
        const stripPath = join(cropDir, "strip.png");
        const r = Bun.spawnSync(["magick", ...good.map((c) => c.path), "-append", stripPath]);
        if (r.exitCode === 0 && existsSync(stripPath)) {
            strip = stripPath;
        }
    } else if (good.length === 1) {
        strip = good[0].path;
    }

    // Vision-sized copy: full strips grow to 4000x8000+ px, which agents should
    // never Read raw — cap the longest side, only ever shrinking.
    if (strip) {
        const reviewPath = join(cropDir, "strip-review.png");
        const r = Bun.spawnSync(["magick", strip, "-resize", "1600x1600>", reviewPath]);
        if (r.exitCode === 0 && existsSync(reviewPath)) {
            stripReview = reviewPath;
        }
    }

    return { crops, strip, stripReview };
}

function publishVitrinka(
    spec: VitrinkaSpec,
    sessionDir: string,
    frames: FrameInfo[],
    crops: CropOut[],
    strip: string | null
): { ok: boolean; urls: string[]; error?: string } {
    const urls: string[] = [];
    try {
        const include = spec.include ?? ["strip"];
        const root = join(sessionDir, `vitrinka-${spec.key}`);
        const shots = join(root, "shots");
        mkdirSync(shots, { recursive: true });

        const files: { path: string; title: string }[] = [];
        if (include.includes("strip") && strip) {
            const dest = join(shots, `strip-${basename(strip)}`);
            copyFileSync(strip, dest);
            const good = crops.filter((c) => c.ok);
            files.push({ path: dest, title: `strip (${good.length} tiles)` });
        }

        if (include.includes("crops")) {
            for (const c of crops.filter((c) => c.ok && c.path !== strip)) {
                const dest = join(shots, basename(c.path));
                copyFileSync(c.path, dest);
                files.push({ path: dest, title: c.label });
            }
        }

        if (include.includes("frames")) {
            for (const f of frames) {
                const dest = join(shots, f.file);
                copyFileSync(f.path, dest);
                files.push({ path: dest, title: `frame t=${f.timestampMs}ms` });
            }
        }

        if (files.length === 0) {
            return { ok: false, urls, error: "nothing to publish (no strip/crops/frames matched include)" };
        }

        const init = runCmd([
            "vitrinka",
            "remote-init",
            "--root",
            root,
            "--project",
            spec.project,
            "--branch",
            spec.branch ?? "review",
            "--key",
            spec.key,
        ]);
        if (!init.ok) {
            return { ok: false, urls, error: `remote-init: ${init.stderr || init.stdout}` };
        }

        for (const f of files) {
            const rel = f.path.slice(root.length + 1);
            const add = runCmd([
                "vitrinka",
                "add",
                "--root",
                root,
                "--file",
                rel,
                "--surface",
                "web",
                "--route",
                spec.route ?? "/",
                "--title",
                f.title,
                "--note",
                spec.note ?? "published by capture-with-actions",
            ]);
            if (!add.ok) {
                return { ok: false, urls, error: `add ${rel}: ${add.stderr || add.stdout}` };
            }
        }

        const push = runCmd(["vitrinka", "push", "--root", root, "--title", spec.title ?? spec.key]);
        for (const line of `${push.stdout}\n${push.stderr}`.split("\n")) {
            const m = line.match(/https?:\/\/\S+/);
            if (m) {
                urls.push(m[0]);
            }
        }

        if (!push.ok) {
            return { ok: false, urls, error: `push: ${push.stderr || push.stdout}` };
        }

        if (spec.board) {
            const b = runCmd(["vitrinka", "board-from-set", "--root", root, "--slug", spec.board]);
            for (const line of `${b.stdout}\n${b.stderr}`.split("\n")) {
                const m = line.match(/https?:\/\/\S+/);
                if (m) {
                    urls.push(m[0]);
                }
            }

            if (!b.ok) {
                return { ok: false, urls, error: `board-from-set: ${b.stderr || b.stdout}` };
            }
        }

        return { ok: true, urls };
    } catch (e) {
        return { ok: false, urls, error: (e as Error).message };
    }
}

// ---------------- entry ----------------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    process.exit(argv.length ? 0 : 2);
}

if (argv[0] === "preflight") {
    const appIdx = argv.indexOf("--app");
    const screens = listScreens();

    const frontRes = runCmd([
        "osascript",
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    const app = appIdx >= 0 ? argv[appIdx + 1] : frontRes.stdout;
    const windows = app ? listWindowBounds(app) : [];
    // Flag phantom strip windows (menu bar, titlebar): full-width x <=50px
    const phantomStrips = windows.filter((w) => w.h <= 50);
    const realWindows = windows.filter((w) => w.h > 50);
    // largest window, not isMainWindow — apps report invisible menu-bar strips as main
    const main = pickLargestWindow(realWindows.length > 0 ? realWindows : windows);

    let activeScreen: ScreenInfo | undefined;
    if (main) {
        const cx = main.x + main.w / 2;
        const cy = main.y + main.h / 2;
        activeScreen = screens.find(
            (s) =>
                cx >= s.originCG.x &&
                cx < s.originCG.x + s.points.width &&
                cy >= s.originCG.y &&
                cy < s.originCG.y + s.points.height
        );
    }

    activeScreen ??= screens.find((s) => s.isPrimary) ?? screens[0];

    let browserTab: { url?: string; title?: string } | undefined;
    if (app && (CHROMIUM_APPS.has(app) || app === "Safari")) {
        const urlScript =
            app === "Safari"
                ? `tell application "Safari" to get URL of front document`
                : `tell application "${app}" to get URL of active tab of front window`;
        const titleScript =
            app === "Safari"
                ? `tell application "Safari" to get name of front document`
                : `tell application "${app}" to get title of active tab of front window`;
        const u = runCmd(["osascript", "-e", urlScript]);
        const t = runCmd(["osascript", "-e", titleScript]);
        browserTab = { url: u.ok ? u.stdout : undefined, title: t.ok ? t.stdout : undefined };
    }

    const sf = activeScreen.scaleFactor;
    const mainFramePx = main && {
        x: Math.round((main.x - activeScreen.originCG.x) * sf),
        y: Math.round((main.y - activeScreen.originCG.y) * sf),
        w: Math.round(main.w * sf),
        h: Math.round(main.h * sf),
    };

    console.log(
        SafeJSON.stringify(
            {
                screens,
                frontmost: {
                    app,
                    // largest-first so the picked window is always visible in the list
                    windows: realWindows
                        .slice()
                        .sort((a, b) => b.w * b.h - a.w * a.h)
                        .slice(0, 8),
                    phantomStrips:
                        phantomStrips.length > 0
                            ? phantomStrips.map((w) => ({
                                  title: w.title,
                                  index: w.index,
                                  isMainWindow: w.isMainWindow,
                                  w: w.w,
                                  h: w.h,
                              }))
                            : undefined,
                    pickedWindow: main ?? null,
                    pickedBy:
                        "largest-area (isMainWindow lies: apps report menu strips/popups as main; <=50px windows filtered as phantom strips)",
                    mainWindowPoints: main ? { x: main.x, y: main.y, w: main.w, h: main.h } : null,
                    mainWindowFramePx: mainFramePx ?? null,
                    activeScreenIndex: activeScreen.index,
                    browserTab,
                },
                unitsReminder: {
                    clickCoords: "GLOBAL CG points (mainWindowPoints space; negatives legal)",
                    cropRegion: `FRAME pixels of the captured screen (points x scaleFactor=${sf}; mainWindowFramePx space)`,
                },
                suggestedPlan: {
                    capture: {
                        mode: "screen",
                        screenIndex: activeScreen.index,
                        duration: 6,
                        activeFps: 15,
                        threshold: 0.1,
                        videoOut: "/tmp/run.mp4",
                        noRemote: true,
                        captureEngine: "cg",
                    },
                    actions: [
                        mainFramePx
                            ? { atMs: 0, do: "crop", region: mainFramePx, label: "window" }
                            : {
                                  atMs: 0,
                                  do: "crop",
                                  region: { x: 0, y: 0, w: activeScreen.framePixels.width, h: 300 },
                                  label: "top-band",
                              },
                    ],
                },
            },
            null,
            2
        )
    );
    process.exit(0);
}

if (argv[0] === "clickmap") {
    // Browser pages expose no AX tree to peekaboo (`see` draws zero boxes on
    // web content), so clicking inside a page means reading coordinates off a
    // screenshot — and hand-computing global points from window origin +
    // retina scale is exactly where manual attempts burn 2-3 iterations per
    // target. clickmap bakes the arithmetic into the image: the grid labels
    // ARE global click points; no math left to get wrong.
    const appIdx = argv.indexOf("--app");
    const app = appIdx >= 0 ? argv[appIdx + 1] : undefined;
    if (!app) {
        fail(`usage: clickmap --app "<Name>" [--window-title <t>] [--grid <points=100>] [--out <png>]`);
    }

    const titleIdx = argv.indexOf("--window-title");
    const windowTitle = titleIdx >= 0 ? argv[titleIdx + 1] : undefined;
    const gridIdx = argv.indexOf("--grid");
    const gridStep = Math.max(20, gridIdx >= 0 ? Number(argv[gridIdx + 1]) || 100 : 100);
    const outIdx = argv.indexOf("--out");
    const outPath = outIdx >= 0 ? argv[outIdx + 1] : join(process.env.TMPDIR ?? "/tmp/", `clickmap-${Date.now()}.png`);

    const wins = listWindowBounds(app);
    const match = windowTitle
        ? wins.find((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()))
        : pickLargestWindow(wins);
    if (!match) {
        fail(`no window found for app "${app}"${windowTitle ? ` matching title "${windowTitle}"` : ""}`);
    }

    const rawPath = `${outPath.replace(/\.png$/, "")}-raw.png`;
    const shotCmd = ["peekaboo", "image", "--app", app, "--path", rawPath];
    if (windowTitle) {
        shotCmd.push("--window-title", windowTitle);
    }

    const shot = runCmd(shotCmd, 20_000);
    if (!shot.ok || !existsSync(rawPath)) {
        fail(`peekaboo image failed: ${shot.stderr || shot.stdout}`);
    }

    // Normalize the shot to point dimensions (retina shots are points x scale),
    // so 1 image px == 1 point and gridlines land exactly on labeled coords.
    const w = Math.round(match.w);
    const h = Math.round(match.h);
    const lines: string[] = [];
    const labels: string[] = [];
    for (let gx = Math.ceil(match.x / gridStep) * gridStep; gx < match.x + match.w; gx += gridStep) {
        const lx = Math.round(gx - match.x);
        lines.push(`line ${lx},0 ${lx},${h}`);
        labels.push("-annotate", `+${lx + 3}+3`, String(gx));
    }

    for (let gy = Math.ceil(match.y / gridStep) * gridStep; gy < match.y + match.h; gy += gridStep) {
        const ly = Math.round(gy - match.y);
        lines.push(`line 0,${ly} ${w},${ly}`);
        labels.push("-annotate", `+3+${ly + 2}`, String(gy));
    }

    const r = Bun.spawnSync([
        "magick",
        rawPath,
        "-resize",
        `${w}x${h}!`,
        "-stroke",
        "#ff00ff90",
        "-strokewidth",
        "1",
        "-fill",
        "none",
        "-draw",
        lines.join(" "),
        "-stroke",
        "none",
        "-fill",
        "#ffff00",
        "-undercolor",
        "#000000B0",
        "-pointsize",
        "12",
        "-gravity",
        "NorthWest",
        ...labels,
        outPath,
    ]);
    if (r.exitCode !== 0 || !existsSync(outPath)) {
        fail(`magick grid overlay failed: ${r.stderr.toString().slice(0, 300)}`);
    }

    console.log(
        SafeJSON.stringify(
            {
                out: outPath,
                raw: rawPath,
                app,
                window: { x: match.x, y: match.y, w: match.w, h: match.h, title: match.title },
                gridStep,
                units: "grid labels are GLOBAL screen points (CG POINTS, not pixels) — use directly as click coords {x,y}",
                tip: "Read `out`, interpolate between gridlines for the target, then verify the first click's effect before trusting a whole plan. For relativeTo coords: subtract the window origin (shown below) from the grid label values.",
                windowOrigin: { x: match.x, y: match.y },
            },
            null,
            2
        )
    );
    process.exit(0);
}

if (argv[0] === "recrop") {
    const [, resultPath, planPath] = argv;
    if (!resultPath || !planPath) {
        fail("usage: recrop <prior-result.json> <plan.json>");
    }

    const prior = SafeJSON.parse(await Bun.file(resultPath).text());
    const plan: Plan = SafeJSON.parse(await Bun.file(planPath).text());
    const frames: FrameInfo[] = (prior?.capture?.data?.frames ?? [])
        .slice()
        .sort((a: FrameInfo, b: FrameInfo) => a.timestampMs - b.timestampMs);
    if (frames.length === 0) {
        fail("prior result has no frames");
    }

    const missing = frames.filter((f) => !existsSync(f.path));
    if (missing.length > 0) {
        fail(`frames deleted (peekaboo autoclean?): ${missing[0].path}`);
    }

    const warnings = validatePlan(plan);
    for (const a of plan.actions ?? []) {
        if (a.do === "crop" && a.target && !a.region) {
            warnings.push(
                `crop target at ${a.atMs}ms cannot be resolved in recrop mode (bounds would be from NOW, not recording time) — dropped`
            );
        }
    }

    const { crops, strip, stripReview } = applyCrops(prior.sessionDir, frames, extractCropSpecs(plan.actions ?? []));
    const vitrinka = plan.vitrinka ? publishVitrinka(plan.vitrinka, prior.sessionDir, frames, crops, strip) : undefined;
    console.log(
        SafeJSON.stringify(
            { sessionDir: prior.sessionDir, mode: "recrop", warnings, crops, strip, stripReview, vitrinka },
            null,
            2
        )
    );
    process.exit(0);
}

const plan: Plan = SafeJSON.parse(await Bun.file(argv[0]).text());
const cap = plan.capture;
if (!cap?.mode || !cap?.duration) {
    fail("plan.capture.mode and plan.capture.duration are required");
}

const warnings = validatePlan(plan);
for (const w of warnings) {
    console.error(`capture-with-actions: WARNING: ${w}`);
}

const hasTargetCrops = (plan.actions ?? []).some((a) => a.do === "crop" && a.target && !a.region);
if (hasTargetCrops && cap.mode !== "screen") {
    warnings.push("crop target markers only work with capture.mode 'screen' — they will be dropped");
}

if (plan.focus) {
    const f = focusWindow(plan.focus);
    if (!f.ok) {
        warnings.push(`focus ${plan.focus.app} failed (peekaboo AND osascript): ${f.detail}`);
    } else {
        if (f.via === "osascript") {
            warnings.push(
                `focus ${plan.focus.app}: peekaboo window focus failed (bridge?), fell back to osascript activate (windowTitle ignored)`
            );
        }

        await Bun.sleep(300);
    }
}

const args = ["capture", "live", "--mode", cap.mode, "--duration", String(cap.duration), "--json"];
if (cap.screenIndex !== undefined) {
    args.push("--screen-index", String(cap.screenIndex));
}
if (cap.app) {
    args.push("--app", cap.app);
}
if (cap.windowTitle) {
    args.push("--window-title", cap.windowTitle);
}
if (cap.windowIndex !== undefined) {
    args.push("--window-index", String(cap.windowIndex));
}
if (cap.region) {
    args.push("--region", cap.region);
}
if (cap.activeFps !== undefined) {
    args.push("--active-fps", String(cap.activeFps));
}
if (cap.idleFps !== undefined) {
    args.push("--idle-fps", String(cap.idleFps));
}
if (cap.threshold !== undefined) {
    args.push("--threshold", String(cap.threshold));
}
if (cap.videoOut) {
    args.push("--video-out", cap.videoOut);
}
if (cap.noRemote) {
    args.push("--no-remote");
}
if (cap.captureEngine) {
    args.push("--capture-engine", cap.captureEngine);
}

if (cap.countdownSec && cap.countdownSec > 0) {
    await runCountdown(Math.min(cap.countdownSec, 10));
}

// Recording-start detection: peekaboo writes keep-0001.png into a fresh
// capture-<UUID> dir the moment the first frame is grabbed.
const tmpBase = process.env.TMPDIR ?? "/tmp/";
const sessionsRoot = join(tmpBase, "peekaboo", "capture-sessions");
mkdirSync(sessionsRoot, { recursive: true });

// peekaboo is a polter shim: killing the spawned pid alone orphans the REAL
// capture process, which keeps recording and then wedges the retry as a
// "concurrent capture" (observed live: auto-retry failed 4/5 while a direct
// bypass run succeeded 2/2 — the corpse of attempt 1 was the difference).
function killTree(pid: number): void {
    const kids = Bun.spawnSync(["pgrep", "-P", String(pid)], { timeout: 2_000 })
        .stdout.toString()
        .trim()
        .split("\n")
        .filter(Boolean);
    for (const k of kids) {
        killTree(Number(k));
    }

    try {
        process.kill(pid, "SIGKILL");
    } catch (e) {
        // ESRCH: already exited — exactly what we want
        void e;
    }
}

interface CaptureAttempt {
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    sessionDir: string | null;
    stdoutText: Promise<string>;
    stderrText: Promise<string>;
    failDiag: string;
}

async function startCapture(captureArgs: string[]): Promise<CaptureAttempt> {
    const preexisting = new Set(readdirSync(sessionsRoot));
    const p = Bun.spawn(["peekaboo", ...captureArgs], { stdout: "pipe", stderr: "pipe" });
    // Drain both pipes from spawn time: an undrained 64KB pipe blocks peekaboo
    // mid-write (large final JSON on long captures, or visualizer logs when
    // PEEKABOO_VISUALIZER_STDOUT=true) and is indistinguishable from a hang.
    const stdoutText = new Response(p.stdout).text();
    const stderrText = new Response(p.stderr).text();

    let dir: string | null = null;
    let exitedEarly = false;
    const armDeadline = Date.now() + 15_000;
    while (Date.now() < armDeadline) {
        const fresh = readdirSync(sessionsRoot).filter(
            (d) => !preexisting.has(d) && existsSync(join(sessionsRoot, d, "keep-0001.png"))
        );

        if (fresh.length > 0) {
            dir = join(sessionsRoot, fresh[0]);
            break;
        }

        if (p.exitCode !== null) {
            exitedEarly = true;
            break;
        }

        await Bun.sleep(50);
    }

    let failDiag = "";
    if (!dir) {
        killTree(p.pid);
        // peekaboo --json puts the REAL error in the STDOUT envelope
        // (error.code/message); stderr usually carries only visualizer noise.
        // Reading only stderr here is how a fast, explicit peekaboo error once
        // masqueraded as "recording never started ... stderr: [Visualizer][INFO] ...".
        const [so, se] = await Promise.all([stdoutText, stderrText]);
        let envelope = "";
        const jsonStart = so.indexOf("{");
        if (jsonStart >= 0) {
            try {
                const parsed = SafeJSON.parse(so.slice(jsonStart)) as { error?: { code?: string; message?: string } };
                if (parsed.error) {
                    envelope = `${parsed.error.code ?? "?"}: ${parsed.error.message ?? "?"}`;
                }
            } catch {
                // not JSON — the raw stdout tail below covers it
            }
        }

        failDiag = [
            exitedEarly
                ? `peekaboo exited (code ${p.exitCode}) before writing a frame`
                : "peekaboo still running with no frame after 15s — killed its process tree",
            envelope ? `error ${envelope}` : `stdout: ${so.trim().slice(0, 300) || "empty"}`,
            `stderr: ${se.trim().slice(0, 300) || "empty"}`,
        ].join(" · ");
    }

    return { proc: p, sessionDir: dir, stdoutText, stderrText, failDiag };
}

function stripBypassFlags(a: string[]): string[] {
    const kept: string[] = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] === "--no-remote") {
            continue;
        }

        if (a[i] === "--capture-engine") {
            i++;
            continue;
        }

        kept.push(a[i]);
    }

    return kept;
}

let attempt = await startCapture(args);

// Self-heal by flipping transport — the two paths fail for DIFFERENT reasons.
// Bridge runs stall when the bridge socket wedges or a fallback host lacks
// Screen Recording; bypass runs (--no-remote, in-process CG) fail when THIS
// process's own TCC ancestry lacks the grant — exactly the case where a bridge
// host (GUI app with its own grant) still works. So the retry always takes the
// path attempt 1 did NOT take. (The old logic only retried bridge→bypass and,
// worse, claimed a bypass retry happened even when the plan already had
// noRemote and no retry ran at all.)
if (!attempt.sessionDir) {
    const bypassed = Boolean(cap.noRemote);
    const diag1 = attempt.failDiag;
    const retryArgs = bypassed
        ? stripBypassFlags(args)
        : [...args, "--no-remote", ...(cap.captureEngine ? [] : ["--capture-engine", "cg"])];
    warnings.push(
        `recording never started via ${bypassed ? "bypass (--no-remote)" : "bridge"} — ${diag1} — retrying once via ${bypassed ? "bridge" : "--no-remote --capture-engine cg"}`
    );
    await Bun.sleep(2_000);
    attempt = await startCapture(retryArgs);

    if (!attempt.sessionDir) {
        fail(
            `recording never started on either transport.\n  attempt 1 (${bypassed ? "bypass" : "bridge"}): ${diag1}\n  retry (${bypassed ? "bridge" : "bypass"}): ${attempt.failDiag}`
        );
    }
}

const proc = attempt.proc;
// non-null: the retry block above fail()s out when no attempt produced a dir
const sessionDir = attempt.sessionDir!;

const t0 = Date.now();
const fired: FiredAction[] = [];
let aborted = false;

// Crop markers with a target STAY in the timeline: their bounds lookup runs at
// their atMs (freeze-at-marker-time semantics). Region markers and crop-stop
// fire nothing and are excluded.
let screensCache: ScreenInfo[] | null = null;

// Focus decays MID-recording (the runner's own shell-outs, OS focus drift, the
// user touching another window), and macOS silently eats synthetic input on
// non-frontmost windows — observed live: the click right after plan.focus
// landed, an identical click seconds later was swallowed with ok:true. So
// focus is re-asserted before EVERY input action (click/type/hotkey), not
// just at recording start. Deliberately osascript activate, NOT peekaboo
// window focus: app-level focus is all a mid-recording refocus needs (window
// ordering was set at the focus assertion) and it's ~120ms vs a measured ~2s
// bridge roundtrip that shoved the next click 2s off its atMs. Accepted
// tradeoff: ~120ms actualMs drift per input beats silently eaten input that
// invalidates the whole recording. No background re-assert timer: refocusing
// right before each input action IS the recheck — a timer would just race
// the action timeline for no benefit.
// The ambient target starts as plan.focus (else capture.app for window-mode
// captures) and is steerable mid-timeline by "focus"/"focus-stop" markers for
// multi-phase plans (app A for the first clicks, app B later). Plans without
// any target get no refocus — set plan.focus in any plan that clicks.
let ambientFocusApp = plan.focus?.app ?? (cap.mode === "window" ? cap.app : undefined);
let refocusWarned = false;
const REFOCUS_ACTIONS = new Set(["click", "type", "hotkey", "ax-set", "ax-press", "ax-perform"]);

const sortedActions = [...plan.actions]
    .filter((a) => (a.do === "crop" ? a.target !== undefined && a.region === undefined : a.do !== "crop-stop"))
    .sort((a, b) => a.atMs - b.atMs);
for (const action of sortedActions) {
    if (aborted) {
        fired.push({ action, plannedMs: action.atMs, actualMs: -1, ok: false, skipped: true });
        continue;
    }

    const wait = action.atMs - (Date.now() - t0);
    if (wait > 0) {
        await Bun.sleep(wait);
    }

    const actualMs = Date.now() - t0;
    let result: { ok: boolean; stdout: string; stderr: string; data?: unknown };

    if (ambientFocusApp && REFOCUS_ACTIONS.has(action.do)) {
        const f = runCmd(["osascript", "-e", `tell application "${ambientFocusApp}" to activate`], 3_000);
        if (!f.ok && !refocusWarned) {
            refocusWarned = true;
            warnings.push(
                `pre-input refocus of ${ambientFocusApp} failed (${f.stderr || f.stdout}) — input may be eaten by macOS click-to-focus`
            );
        }
    }

    switch (action.do) {
        case "url":
            result = navigateBrowser(
                action.app ?? plan.browser ?? "Brave Browser",
                action.url,
                action.target ?? "new-tab"
            );
            break;
        case "osascript":
            result = runCmd(["osascript", "-e", action.script]);
            break;
        case "click": {
            let clickCoords = coordsToString(action.coords);
            if (action.relativeTo) {
                const resolved = resolveRelativeCoords(action.coords, action.relativeTo);
                if ("error" in resolved) {
                    result = { ok: false, stdout: "", stderr: resolved.error };
                    break;
                }
                clickCoords = resolved.global;
            }
            result = runPeekabooJson(["click", "--coords", clickCoords]);
            break;
        }
        case "focus": {
            // full assertion (window-level, bridge with osascript fallback)
            // once at the marker; cheap per-input re-asserts take over after
            const f = focusWindow({ app: action.app, windowTitle: action.windowTitle }, 3_000);
            ambientFocusApp = action.app;
            result = {
                ok: f.ok,
                stdout: f.ok ? `focused via ${f.via}; ambient refocus target -> ${action.app}` : "",
                stderr: f.detail,
            };
            break;
        }
        case "focus-stop":
            ambientFocusApp = undefined;
            result = { ok: true, stdout: "ambient refocus disabled", stderr: "" };
            break;
        case "hotkey": {
            const media = MEDIA_KEY_SCRIPTS[action.keys.toLowerCase().trim()];
            if (media) {
                result = runCmd(["osascript", "-e", media]);
                break;
            }

            const cmd = ["hotkey", "--keys", action.keys];
            if (action.holdMs !== undefined) {
                cmd.push("--hold-duration", String(action.holdMs));
            }

            result = runPeekabooJson(cmd);
            if (!result.ok) {
                result.stderr = `${result.stderr} (valid keys: cmd/shift/alt/ctrl/fn, a-z, 0-9, space/return/tab/escape/delete/arrows, f1-f12; media keys only via volumeup/volumedown/mute/unmute rewrite)`;
            }

            break;
        }
        case "type":
            result = runPeekabooJson([
                "type",
                action.text,
                "--profile",
                "linear",
                "--delay",
                String(action.delayMs ?? 0),
            ]);
            break;
        case "ax-set": {
            result = runAxAction(action.app, action.axId, "set", action.value, undefined, action.q);
            break;
        }
        case "ax-press": {
            result = runAxAction(action.app, action.axId, "press", undefined, undefined, action.q);
            break;
        }
        case "ax-perform": {
            result = runAxAction(action.app, action.axId, "perform", undefined, action.action, action.q);
            break;
        }
        case "scroll": {
            if (action.coords) {
                let scrollCoords = coordsToString(action.coords);
                if (action.relativeTo) {
                    const resolved = resolveRelativeCoords(action.coords, action.relativeTo);
                    if ("error" in resolved) {
                        result = { ok: false, stdout: "", stderr: resolved.error };
                        break;
                    }
                    scrollCoords = resolved.global;
                }
                const [cx, cy] = scrollCoords.split(",").map(Number);
                if (cx < 0 || cy < 0) {
                    warnings.push(
                        `scroll at ${action.atMs}ms: peekaboo move rejects negative coords (${cx},${cy}) — scrolling at current cursor position`
                    );
                } else {
                    runCmd(["peekaboo", "move", "--coords", `${cx},${cy}`]);
                }
            }

            const cmd = ["scroll", "--direction", action.direction, "--amount", String(action.amount ?? 3)];
            if (action.app) {
                cmd.push("--app", action.app);
            }

            if (action.windowTitle) {
                cmd.push("--window-title", action.windowTitle);
            }

            result = runPeekabooJson(cmd);
            break;
        }
        case "crop": {
            // target marker: freeze the window's bounds NOW, write region back
            // so extractCropSpecs picks it up after capture
            screensCache ??= listScreens();
            const screen = screensCache.find((s) => s.index === (cap.screenIndex ?? 0));
            if (!screen || cap.mode !== "screen") {
                result = {
                    ok: false,
                    stdout: "",
                    stderr: `crop target needs screen-mode capture with a known screenIndex`,
                };
                break;
            }

            const resolved = resolveTargetRegion(action.target!, screen);
            if ("error" in resolved) {
                result = { ok: false, stdout: "", stderr: resolved.error };
                warnings.push(`crop target at ${action.atMs}ms dropped: ${resolved.error}`);
            } else {
                action.region = resolved.region;
                result = { ok: true, stdout: `region ${SafeJSON.stringify(resolved.region)}`, stderr: "" };
            }

            break;
        }
        default:
            result = { ok: false, stdout: "", stderr: "unknown action type" };
    }

    fired.push({
        action,
        plannedMs: action.atMs,
        actualMs,
        ok: result.ok,
        stdout: result.stdout || undefined,
        data: result.data,
        error: result.ok ? undefined : result.stderr || result.stdout || "failed",
    });

    if (!result.ok && (action.onError ?? "continue") === "abort") {
        aborted = true;
    }
}

// Bounded exit wait: peekaboo occasionally hangs after (or instead of)
// finishing — observed live with a duration-2 capture still alive minutes
// later, wedging the whole CG capture stack for every later run
// (CGDisplayCreateImage returned nil). Never leave a zombie behind.
const exitGraceMs = 30_000;
const exitedInTime = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(cap.duration * 1000 + exitGraceMs).then(() => false),
]);

if (!exitedInTime) {
    warnings.push(
        `peekaboo did not exit within ${cap.duration}s+${exitGraceMs / 1000}s — killed its process tree; frames salvaged from the session dir (timestamps from file mtimes)`
    );
    killTree(proc.pid);
}

const stdoutText = await attempt.stdoutText;
const stderrText = await attempt.stderrText;

let captureResult: unknown;
try {
    captureResult = SafeJSON.parse(stdoutText);
} catch {
    captureResult = { parseError: true, raw: stdoutText.slice(0, 2000), stderr: stderrText.slice(0, 1000) };
}

let frames: FrameInfo[] = ((captureResult as { data?: { frames?: FrameInfo[] } })?.data?.frames ?? [])
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs);

if (frames.length === 0) {
    // killed or crashed peekaboo → no result JSON; the kept PNGs are still on
    // disk. Rebuild FrameInfo from mtimes (relative to the first frame).
    const keeps = readdirSync(sessionDir)
        .filter((f) => /^keep-\d+\.png$/.test(f))
        .sort();
    if (keeps.length > 0) {
        const t0mtime = statSync(join(sessionDir, keeps[0])).mtimeMs;
        frames = keeps.map((f) => ({
            file: f,
            path: join(sessionDir, f),
            timestampMs: Math.round(statSync(join(sessionDir, f)).mtimeMs - t0mtime),
        }));
    }
}

let crops: CropOut[] = [];
let strip: string | null = null;
let stripReview: string | null = null;
const cropSpecs = extractCropSpecs(plan.actions);
if (cropSpecs.length > 0 && frames.length > 0) {
    ({ crops, strip, stripReview } = applyCrops(sessionDir, frames, cropSpecs));
}

// "actions succeeded" != "pixels moved": scroll over dead UI, wrong screen, or
// wrong focus all leave peekaboo with a 1-frame noMotion result.
const MOTION_ACTIONS = new Set([
    "click",
    "url",
    "osascript",
    "hotkey",
    "type",
    "scroll",
    "ax-set",
    "ax-press",
    "ax-perform",
]);
const motionFired = fired.some((f) => f.ok && MOTION_ACTIONS.has(f.action.do));
if (motionFired && frames.length <= 1) {
    warnings.push(
        `actions fired ok but capture kept ${frames.length} frame(s) — no visual motion reached the recorded screen (wrong screenIndex? wrong focus? scroll over non-scrolling UI?)`
    );
}

let vitrinka: { ok: boolean; urls: string[]; error?: string } | undefined;
if (plan.vitrinka) {
    if (motionFired && frames.length <= 1 && !plan.vitrinka.force) {
        vitrinka = {
            ok: false,
            urls: [],
            error: "refusing to publish a 1-frame no-motion capture (this is what litters boards with dead sets); fix the plan or set vitrinka.force",
        };
    } else {
        vitrinka = publishVitrinka(plan.vitrinka, sessionDir, frames, crops, strip);
    }
}

console.log(
    SafeJSON.stringify(
        {
            sessionDir,
            exitCode: proc.exitCode,
            warnings,
            actions: fired,
            crops,
            strip,
            stripReview,
            vitrinka,
            capture: captureResult,
        },
        null,
        2
    )
);
