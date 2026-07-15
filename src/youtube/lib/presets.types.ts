export type PresetKind = "summary" | "insights" | "ask";

export interface PromptPreset {
    id: number;
    kind: PresetKind;
    name: string;
    instructions: string;
    createdAt: string;
}

export const MAX_PRESETS_PER_USER = 20;
export const MAX_PRESET_CHARS = 1000;
