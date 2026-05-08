export const MATCHER_CONFIG = {
    LAYER1_FUZZY_MIN: 0.9,
    LAYER2A_FUZZY_MIN: 0.92,
    LAYER2B_FUZZY_MIN: 0.95,
    LAYER3_AUTOLINK_MIN: 0.95,
    LAYER3_GRAYZONE_MIN: 0.92,
    LAYER4_CANDIDATE_MIN: 0.92,
} as const;

export type MatcherConfig = typeof MATCHER_CONFIG;

export function isLayer3GrayZone(score: number): boolean {
    return score >= MATCHER_CONFIG.LAYER3_GRAYZONE_MIN && score < MATCHER_CONFIG.LAYER3_AUTOLINK_MIN;
}
