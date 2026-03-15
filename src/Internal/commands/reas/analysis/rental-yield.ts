import type { TargetProperty } from "../types";

export interface YieldResult {
    grossYield: number;
    netYield: number;
    paybackYears: number;
    atMarketPrice: {
        price: number;
        grossYield: number;
        netYield: number;
        paybackYears: number;
    };
    benchmarks: Array<{ name: string; yield: number }>;
}

const BENCHMARKS: Array<{ name: string; yield: number }> = [
    { name: "Czech govt bonds", yield: 4.2 },
    { name: "S&P 500 avg", yield: 10 },
    { name: "Prague avg yield", yield: 3.5 },
];

function computeYields(price: number, monthlyRent: number, monthlyCosts: number) {
    const annualGross = monthlyRent * 12;
    const annualNet = (monthlyRent - monthlyCosts) * 12;

    const grossYield = price > 0 ? (annualGross / price) * 100 : 0;
    const netYield = price > 0 ? (annualNet / price) * 100 : 0;
    const paybackYears = annualNet > 0 ? price / annualNet : Infinity;

    return { grossYield, netYield, paybackYears };
}

export function analyzeRentalYield(
    target: TargetProperty,
    medianPricePerM2: number,
    rentalEstimate: number
): YieldResult {
    const monthlyRent = rentalEstimate > 0 ? rentalEstimate : target.monthlyRent;
    const monthlyCosts = target.monthlyCosts;

    const { grossYield, netYield, paybackYears } = computeYields(target.price, monthlyRent, monthlyCosts);

    const marketPrice = medianPricePerM2 * target.area;
    const atMarket = computeYields(marketPrice, monthlyRent, monthlyCosts);

    return {
        grossYield,
        netYield,
        paybackYears,
        atMarketPrice: {
            price: marketPrice,
            grossYield: atMarket.grossYield,
            netYield: atMarket.netYield,
            paybackYears: atMarket.paybackYears,
        },
        benchmarks: BENCHMARKS,
    };
}
