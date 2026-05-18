import { readFileSync } from "node:fs";
import { playBuffer } from "@app/utils/audio/playback";
import { type BundledSound, bundledPath } from "./assets/manifest";
import { renderPresetWav } from "./ding-presets";

export type SoundChoice =
    | { kind: "synth"; preset: string }
    | { kind: "bundled"; name: BundledSound }
    | { kind: "custom"; path: string };

export function resolveSoundBuffer(choice: SoundChoice): Buffer {
    if (choice.kind === "synth") {
        return renderPresetWav(choice.preset);
    }

    if (choice.kind === "bundled") {
        return readFileSync(bundledPath(choice.name));
    }

    return readFileSync(choice.path);
}

export async function playDing(choice: SoundChoice, volume = 0.6): Promise<void> {
    const buf = resolveSoundBuffer(choice);
    await playBuffer(buf, "audio/wav", { volume, wait: false });
}

/**
 * Friendly names for the bundled CC0 sounds. Const-object (not `enum`) on
 * purpose: gives `Sounds.Switch` ergonomics + literal value types, no runtime
 * reverse-map, tree-shakeable. `satisfies` makes the compiler reject any value
 * that isn't a real `BundledSound` — rename a file in the manifest and this
 * fails to build instead of throwing ENOENT at runtime.
 */
export const Sounds = {
    Switch: "switch.wav",
    Confirm: "confirm.wav",
    ConfirmSoft: "confirm-soft.wav",
    Glass: "glass.wav",
    GlassChime: "glass-chime.wav",
    Pluck: "pluck.wav",
    Question: "question.wav",
    Select: "select.wav",
    Open: "open.wav",
    Close: "close.wav",
    Error: "error.wav",
    Drop: "drop.wav",
} as const satisfies Record<string, BundledSound>;

export type Sound = (typeof Sounds)[keyof typeof Sounds];

/** Ergonomic one-liner: `playSound({ sound: Sounds.Switch, volume: 0.1 })`. */
export async function playSound(opts: { sound: Sound; volume?: number }): Promise<void> {
    await playDing({ kind: "bundled", name: opts.sound }, opts.volume ?? 0.6);
}

/** Alias — same call, the name from the API sketch. */
export const makeSound = playSound;
