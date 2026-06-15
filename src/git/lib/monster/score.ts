export interface ScarinessInput {
    lines: number;
    ageDays: number;
    fanIn: number;
    fanOut: number;
}

export const WEIGHTS = {
    lines: 3,
    age: 0.15,
    tangle: 2,
} as const;

export function scariness(input: ScarinessInput): number {
    const sizeTerm = WEIGHTS.lines * Math.log1p(Math.max(0, input.lines));
    const ageTerm = WEIGHTS.age * Math.max(0, input.ageDays);
    const tangleTerm = WEIGHTS.tangle * (Math.max(0, input.fanIn) + Math.max(0, input.fanOut));
    return sizeTerm + ageTerm + tangleTerm;
}
