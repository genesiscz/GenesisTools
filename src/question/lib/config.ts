import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SoundChoice } from "@app/utils/audio/runner.server";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

export interface QuestionConfig {
    sinks: { obsidian: boolean; sound: boolean; notify: boolean };
    obsidianPathTemplate: string;
    sound?: SoundChoice; // Phase 2
    soundVolume?: number; // Phase 2, 0..1
}

const DEFAULT: QuestionConfig = {
    sinks: { obsidian: true, sound: false, notify: false },
    obsidianPathTemplate: "{project}/Questions/{date}.md",
    sound: { kind: "bundled", name: "switch.wav" },
    soundVolume: 0.6,
};

export function configPath(): string {
    return env.question.getConfigPath() ?? join(homedir(), ".genesis-tools", "question", "config.json");
}

export function loadConfig(path = configPath()): QuestionConfig {
    if (!existsSync(path)) {
        return DEFAULT;
    }

    try {
        return { ...DEFAULT, ...(SafeJSON.parse(readFileSync(path, "utf8")) as Partial<QuestionConfig>) };
    } catch {
        return DEFAULT;
    }
}

export function saveConfig(patch: Partial<QuestionConfig>, path = configPath()): QuestionConfig {
    const current = loadConfig(path);
    // Deep-merge `sinks` so a partial patch like { sinks: { sound: true } }
    // can't silently drop obsidian/notify (t14 — root fix, not per-caller).
    const next: QuestionConfig = {
        ...current,
        ...patch,
        sinks: patch.sinks ? { ...current.sinks, ...patch.sinks } : current.sinks,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SafeJSON.stringify(next, null, 2));
    return next;
}
