import { callTo, defineRoster } from "./define";

/** C01: callers chose between the recorded and the computed cost themselves, each with a different rule. */
export default defineRoster({
    name: "roster-choose-cost-outside-priced-usage",
    candidate: "C01",
    message:
        "Price a usage record with `priceUsage` from src/utils/ai/usage/spend/priced-usage.ts; it applies the " +
        "recorded-cost rule. Calling `chooseCost` yourself brings back the per-caller drift C01 removed.",
    matcher: callTo(["chooseCost"]),
    onlyIn: /^src\//,
    allowedIn: /^src\/utils\/ai\/usage\/spend\/priced-usage\.ts$/,
});
