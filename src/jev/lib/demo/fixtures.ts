import type { ControlDriver } from "@app/control/lib/decision/native";
import type { Observation } from "@app/control/lib/decision/observation";
import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import type { GoalSurface, SurfaceSnapshot } from "../loop/surface";
import type { ToolCatalogue } from "../route/catalogue";

/**
 * Every input the reel feeds its real lib functions. Nothing here touches the user's machine:
 * no app is launched, no window is observed, no microphone is opened. The AppKit fixture app
 * (native/ax-tool/Fixtures/ControlFixture.swift) is driven only by `src/control/scripts/live-smoke.ts`,
 * which exports no reusable launcher, so the observe / loop / watch chapters run on the in-memory
 * observations below and say so in their trace.
 */

export const FIXTURE_SURFACE_NOTE = "in-memory fixture observation (ControlFixture.app is not launched)";

function button(index: number, title: string, enabled = true): Observation["elements"][number] {
    return {
        index,
        depth: 1,
        role: "AXButton",
        AXTitle: title,
        AXEnabled: enabled ? "1" : "0",
        visible: true,
        actions: ["AXPress"],
    };
}

function staticText(index: number, value: string): Observation["elements"][number] {
    return { index, depth: 1, role: "AXStaticText", AXTitle: value, AXValue: value, visible: true };
}

/** The pre-act state: an Export button to press and a status line that does not yet say Done. */
export function pendingObservation(): Observation {
    return {
        ok: true,
        app: "ControlFixture",
        pid: 4242,
        snapshot: "fixture-snapshot-pending",
        window: { id: 1, title: "Control Fixture" },
        scope: "window",
        elements: [staticText(0, "Export pending"), button(1, "Export"), button(2, "Cancel")],
    };
}

/** The post-act state. `Done` is the readback every chapter checks for. */
export function doneObservation(): Observation {
    return {
        ok: true,
        app: "ControlFixture",
        pid: 4242,
        snapshot: "fixture-snapshot-done",
        window: { id: 1, title: "Control Fixture" },
        scope: "window",
        elements: [staticText(0, "Export Done"), button(1, "Export"), button(2, "Cancel")],
    };
}

/** A keypad the listen chapter speaks to. `Seven` is the only reasonable target for "press seven". */
export function keypadObservation(): Observation {
    return {
        ok: true,
        app: "ControlFixture",
        pid: 4242,
        snapshot: "fixture-snapshot-keypad",
        window: { id: 1, title: "Control Fixture Keypad" },
        scope: "window",
        elements: [staticText(0, "0"), button(1, "Seven"), button(2, "Clear"), button(3, "Equals")],
    };
}

/** A two-step surface: the first `see` offers Export, every later one reports Done. */
export function createFixtureGoalSurface(): { surface: GoalSurface; acted: string[]; sees: () => number } {
    const acted: string[] = [];
    let sees = 0;
    const surface: GoalSurface = {
        kind: "ax",
        async see(): Promise<SurfaceSnapshot> {
            sees += 1;
            const observation = acted.length > 0 ? doneObservation() : pendingObservation();
            return {
                id: observation.snapshot,
                label: `${observation.app} ${observation.window.title}`,
                observation,
                candidates: [
                    { id: "c0", label: "Export", element: 1, action: "press", role: "AXButton" },
                    { id: "c1", label: "Cancel", element: 2, action: "press", role: "AXButton" },
                ],
            };
        },
        async act(_snapshot, candidate) {
            acted.push(candidate.id);
            return { ok: true };
        },
    };
    return { surface, acted, sees: () => sees };
}

/** A watch driver whose second observation reports Done, so the fan-out can verify on evidence. */
export function createFixtureWatchDriver(): { driver: ControlDriver; observes: () => number } {
    let observes = 0;
    const driver: ControlDriver = {
        async observe() {
            observes += 1;
            return observes === 1 ? pendingObservation() : doneObservation();
        },
        async act() {
            return { ok: false, error: "The watch chapter never acts." };
        },
    };
    return { driver, observes: () => observes };
}

export function transcriptEvent(
    kind: LiveTranscriptEvent["kind"],
    text: string,
    startedAtMs: number
): LiveTranscriptEvent {
    return { kind, text, isFinal: kind === "final", startedAtMs, endedAtMs: startedAtMs + 400 };
}

/** The listen chapter's script: one partial that must only be "would", then a final that acts. */
export const LISTEN_TRANSCRIPT: LiveTranscriptEvent[] = [
    transcriptEvent("partial", "press sev", 0),
    transcriptEvent("final", "press seven", 400),
    transcriptEvent("final", "never mind", 1200),
];

/** The voice chapter's script: the pre-wake command must be refused, the post-wake one must act. */
export const VOICE_TRANSCRIPT: LiveTranscriptEvent[] = [
    transcriptEvent("final", "press seven", 0),
    transcriptEvent("final", "hey jev press seven", 600),
];

export const VOICE_WAKE_PHRASES = ["hey jev"];

export function fixtureCatalogue(): ToolCatalogue {
    return {
        commit: "fixture",
        tools: [
            {
                name: "github",
                oneLine: "GitHub issues, pull requests and review threads",
                commands: [
                    {
                        path: "github review",
                        description: "Show the unresolved review threads of a pull request",
                        argHint: "<pr>",
                        destructive: false,
                    },
                    { path: "github issue", description: "Show one issue", argHint: "<id>", destructive: false },
                ],
            },
            {
                name: "say",
                oneLine: "Speak a line of text out loud",
                commands: [{ path: "say", description: "Speak text", argHint: "<text>", destructive: false }],
            },
        ],
    };
}

/**
 * A session with two oversized tool results, so layer 1 has something to truncate and layer 2 has
 * a per-call verdict to change. `toolCalls` is the generic JSONL shape the parser pairs on; an
 * OpenAI-style `tool_calls` block would leave the results orphaned and the reduction at zero.
 */
export function compactFixtureSession(): string {
    const body = (label: string) => `${label} `.repeat(120).trim();
    return [
        `{"role":"user","content":"review the unresolved threads on 409"}`,
        `{"role":"assistant","content":"reading the diff","toolCalls":[{"id":"t1","name":"github","input":"pr 409","result":"${body("thread body")}"},{"id":"t2","name":"read","input":"src/jev/index.ts","result":"${body("file body")}"}]}`,
        `{"role":"assistant","content":"summarised the threads"}`,
        `{"role":"user","content":"now open the first one"}`,
        `{"role":"assistant","content":"opening"}`,
    ].join("\n");
}

/** Invented identities only: the verify chapter must never carry a real address or key. */
export const VERIFY_DOCUMENT =
    "Release notes draft. Contact alice@example.com for access. " +
    "The deploy script still reads DEPLOY_TOKEN=fixture-not-a-real-credential from the checked-in .env file. " +
    "No customer data is exported.";

export const VERIFY_CLAIMS = [
    { id: "c1", text: "The text names a contact email address." },
    { id: "c2", text: "The text says no credential material is present." },
];
