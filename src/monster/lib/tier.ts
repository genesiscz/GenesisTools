import type { Tier } from "./types";

export const TIERS: ReadonlyArray<{ tier: Tier; min: number; name: string }> = [
    { tier: 0, min: 0, name: "slime" },
    { tier: 1, min: 15, name: "imp" },
    { tier: 2, min: 40, name: "ogre" },
    { tier: 3, min: 80, name: "kraken" },
];

export function tierForScore(score: number): Tier {
    let result: Tier = 0;
    for (const entry of TIERS) {
        if (score >= entry.min) {
            result = entry.tier;
        }
    }

    return result;
}

export function tierName(tier: Tier): string {
    return TIERS[tier].name;
}

const FACES: Record<Tier, string> = {
    0: ["  .---.", " ( o.o )", "  `~~~'"].join("\n"),
    1: ["  /\\_/\\", " ( o o )", "  > ^ <"].join("\n"),
    2: ['   .-""-.', "  / o  o \\", "  \\ wwww /", "   '----'"].join("\n"),
    3: ["   .---.", "  /o o o\\", "  |\\___/|", "  /vvvvv\\", "  \\^^^^^/"].join("\n"),
};

export function faceForTier(tier: Tier): string {
    return FACES[tier];
}
