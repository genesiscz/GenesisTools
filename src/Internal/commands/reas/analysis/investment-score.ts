export interface InvestmentScore {
    overall: number; // 0-100
    grade: "A" | "B" | "C" | "D" | "F";
    factors: {
        yieldScore: number;
        discountScore: number;
        trendScore: number;
        marketVelocityScore: number;
    };
    reasoning: string[];
    recommendation: "strong-buy" | "buy" | "hold" | "avoid" | "strong-avoid";
}

interface ScoreInput {
    netYield: number;
    discount: number; // negative = below market (good)
    trendDirection: "rising" | "stable" | "declining";
    trendYoY: number; // % year-over-year
    medianDaysOnMarket: number;
    districtMedianDays: number;
}

const BOND_YIELD = 4.2;
const PRAGUE_AVG_YIELD = 3.5;

// Weight distribution
const W_YIELD = 0.3;
const W_DISCOUNT = 0.25;
const W_TREND = 0.25;
const W_VELOCITY = 0.2;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function scoreYield(netYield: number): { score: number; reasoning: string } {
    // 0% yield -> 0 score, bond rate -> 50, 2x bonds -> 100
    const score = clamp((netYield / (BOND_YIELD * 2)) * 100, 0, 100);

    let reasoning: string;

    if (netYield >= BOND_YIELD * 1.5) {
        reasoning = `Excellent yield (${netYield.toFixed(1)}%) — well above bonds (${BOND_YIELD}%)`;
    } else if (netYield >= BOND_YIELD) {
        reasoning = `Good yield (${netYield.toFixed(1)}%) — above bonds (${BOND_YIELD}%)`;
    } else if (netYield >= PRAGUE_AVG_YIELD) {
        reasoning = `Average yield (${netYield.toFixed(1)}%) — near Prague average (${PRAGUE_AVG_YIELD}%)`;
    } else {
        reasoning = `Low yield (${netYield.toFixed(1)}%) — below Prague average (${PRAGUE_AVG_YIELD}%)`;
    }

    return { score, reasoning };
}

function scoreDiscount(discount: number): { score: number; reasoning: string } {
    // -15% discount -> 100, 0% -> 50, +15% premium -> 0
    const score = clamp(50 - (discount / 15) * 50, 0, 100);

    let reasoning: string;

    if (discount <= -8) {
        reasoning = `Strong discount (${discount.toFixed(1)}%) — significant negotiation margin`;
    } else if (discount <= -3) {
        reasoning = `Moderate discount (${discount.toFixed(1)}%)`;
    } else if (discount <= 3) {
        reasoning = `Near asking price (${discount > 0 ? "+" : ""}${discount.toFixed(1)}%)`;
    } else {
        reasoning = `Premium over market (+${discount.toFixed(1)}%) — overpaying`;
    }

    return { score, reasoning };
}

function scoreTrend(direction: string, yoy: number): { score: number; reasoning: string } {
    let score: number;

    if (direction === "rising") {
        score = clamp(60 + yoy * 4, 60, 100);
    } else if (direction === "stable") {
        score = 50;
    } else {
        score = clamp(40 + yoy * 4, 0, 40);
    }

    let reasoning: string;

    if (yoy > 5) {
        reasoning = `Strong appreciation (+${yoy.toFixed(1)}% YoY) — market momentum`;
    } else if (yoy > 0) {
        reasoning = `Moderate appreciation (+${yoy.toFixed(1)}% YoY)`;
    } else if (yoy > -3) {
        reasoning = `Flat/slight decline (${yoy.toFixed(1)}% YoY)`;
    } else {
        reasoning = `Declining market (${yoy.toFixed(1)}% YoY) — capital risk`;
    }

    return { score, reasoning };
}

function scoreVelocity(days: number, districtMedian: number): { score: number; reasoning: string } {
    if (!Number.isFinite(districtMedian) || districtMedian <= 0) {
        return { score: 50, reasoning: "Market velocity unavailable — using neutral score" };
    }

    const ratio = days / districtMedian;
    // Faster than median -> high score
    const score = clamp((1 - (ratio - 1)) * 70 + 30, 0, 100);

    let reasoning: string;

    if (days < 30) {
        reasoning = `Hot market — properties sell in ${days} days (district median: ${districtMedian})`;
    } else if (days <= districtMedian) {
        reasoning = `Normal velocity — ${days} days (district median: ${districtMedian})`;
    } else {
        reasoning = `Slow market — ${days} days (district median: ${districtMedian})`;
    }

    return { score, reasoning };
}

function gradeFromScore(score: number): InvestmentScore["grade"] {
    if (score >= 80) {
        return "A";
    }

    if (score >= 65) {
        return "B";
    }

    if (score >= 50) {
        return "C";
    }

    if (score >= 35) {
        return "D";
    }

    return "F";
}

function recommendationFromScore(score: number): InvestmentScore["recommendation"] {
    if (score >= 80) {
        return "strong-buy";
    }

    if (score >= 65) {
        return "buy";
    }

    if (score >= 50) {
        return "hold";
    }

    if (score >= 35) {
        return "avoid";
    }

    return "strong-avoid";
}

export function computeInvestmentScore(input: ScoreInput): InvestmentScore {
    const yieldResult = scoreYield(input.netYield);
    const discountResult = scoreDiscount(input.discount);
    const trendResult = scoreTrend(input.trendDirection, input.trendYoY);
    const velocityResult = scoreVelocity(input.medianDaysOnMarket, input.districtMedianDays);

    const overall = Math.round(
        yieldResult.score * W_YIELD +
            discountResult.score * W_DISCOUNT +
            trendResult.score * W_TREND +
            velocityResult.score * W_VELOCITY
    );

    return {
        overall,
        grade: gradeFromScore(overall),
        factors: {
            yieldScore: Math.round(yieldResult.score),
            discountScore: Math.round(discountResult.score),
            trendScore: Math.round(trendResult.score),
            marketVelocityScore: Math.round(velocityResult.score),
        },
        reasoning: [yieldResult.reasoning, discountResult.reasoning, trendResult.reasoning, velocityResult.reasoning],
        recommendation: recommendationFromScore(overall),
    };
}
