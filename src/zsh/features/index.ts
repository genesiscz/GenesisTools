import { dotdotdotFeature } from "./dotdotdot.ts";
import { notifyFeature } from "./notify.ts";
import { portFeature } from "./port.ts";
import type { ZshFeature } from "./types.ts";

export const ALL_FEATURES: ZshFeature[] = [dotdotdotFeature, notifyFeature, portFeature];

export function getFeature(name: string): ZshFeature | undefined {
    return ALL_FEATURES.find((f) => f.name === name);
}

export function getFeatureNames(): string[] {
    return ALL_FEATURES.map((f) => f.name);
}
