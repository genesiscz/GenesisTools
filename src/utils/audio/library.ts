import { existsSync } from "node:fs";
import { type BundledSound, BUNDLED_SOUNDS } from "./assets/manifest";
import { DING_PRESETS } from "./ding-presets";
import type { SoundChoice } from "./runner.server";

export interface AudioLibraryEntry {
    /** Doubles as the `tools question config --sound <id>` / dashboard spec, so it round-trips. */
    id: `bundled:${string}` | `synth:${string}`;
    label: string;
    kind: "bundled" | "synth";
    choice: SoundChoice;
    isDefault: boolean;
}

export interface AudioLibrary {
    bundled: AudioLibraryEntry[];
    synth: AudioLibraryEntry[];
    /** The audio layer's own sensible default (a consumer's config may override). */
    default: AudioLibraryEntry;
}

/** The audio layer's default bundled sound when nothing else is configured. */
export const DEFAULT_BUNDLED: BundledSound = "switch.wav";

function humanize(s: string): string {
    const spaced = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Programmatic catalog of every playable sound: the bundled Kenney CC0 set
 * (from the manifest, single source of truth) plus the synth presets. Consumers
 * (CLI picker, dashboard dropdown) enumerate this instead of hardcoding names.
 */
export function getAudioLibrary(): AudioLibrary {
    const bundled: AudioLibraryEntry[] = BUNDLED_SOUNDS.map((name) => ({
        id: `bundled:${name}`,
        label: humanize(name.replace(/\.wav$/, "")),
        kind: "bundled",
        choice: { kind: "bundled", name },
        isDefault: name === DEFAULT_BUNDLED,
    }));

    const synth: AudioLibraryEntry[] = Object.keys(DING_PRESETS).map((preset) => ({
        id: `synth:${preset}`,
        label: humanize(preset),
        kind: "synth",
        choice: { kind: "synth", preset },
        isDefault: false,
    }));

    const def = bundled.find((e) => e.isDefault);
    if (!def) {
        throw new Error(`getAudioLibrary: default bundled sound '${DEFAULT_BUNDLED}' missing from manifest`);
    }

    return { bundled, synth, default: def };
}

export type ParseSoundResult =
    | { ok: true; sound?: SoundChoice; enabled: boolean }
    | { ok: false; error: string };

/**
 * Parse a `--sound` / dashboard spec into a validated `SoundChoice`.
 * Accepts: `off` · `synth:<preset>` · `bundled:<file>` · `custom:<abs path>`
 * · a bare known synth preset name. Unknown/invalid → `{ ok:false, error }`.
 */
export function parseSoundSpec(spec: string): ParseSoundResult {
    if (spec === "off") {
        return { ok: true, enabled: false };
    }

    const lib = getAudioLibrary();
    const presets = new Set(lib.synth.map((e) => e.id.slice("synth:".length)));
    const bundledNames = new Set(lib.bundled.map((e) => e.id.slice("bundled:".length)));
    const idx = spec.indexOf(":");
    const kind = idx === -1 ? "" : spec.slice(0, idx);
    const value = idx === -1 ? "" : spec.slice(idx + 1);

    if (kind === "synth") {
        if (!presets.has(value)) {
            return { ok: false, error: `unknown synth preset: '${value}'` };
        }

        return { ok: true, sound: { kind: "synth", preset: value }, enabled: true };
    }

    if (kind === "bundled") {
        if (!bundledNames.has(value)) {
            return { ok: false, error: `unknown bundled sound: '${value}'` };
        }

        return { ok: true, sound: { kind: "bundled", name: value as BundledSound }, enabled: true };
    }

    if (kind === "custom") {
        if (!value || !existsSync(value)) {
            return { ok: false, error: `custom sound file not found: '${value}'` };
        }

        return { ok: true, sound: { kind: "custom", path: value }, enabled: true };
    }

    if (presets.has(spec)) {
        return { ok: true, sound: { kind: "synth", preset: spec }, enabled: true };
    }

    return { ok: false, error: `unrecognized sound spec: '${spec}'` };
}

/** Human-readable list of every available sound (for `--list-sounds` / errors). */
export function formatAudioLibrary(): string {
    const lib = getAudioLibrary();
    const bundled = lib.bundled
        .map((e) => `  ${e.id}${e.isDefault ? "  (default)" : ""}  — ${e.label}`)
        .join("\n");
    const synth = lib.synth.map((e) => `  ${e.id}  — ${e.label}`).join("\n");
    return `Available sounds:\n\nBundled (Kenney CC0):\n${bundled}\n\nSynth presets:\n${synth}\n\nAlso valid:  custom:/abs/path.wav  |  off`;
}
