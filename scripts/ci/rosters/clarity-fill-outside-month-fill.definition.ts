import { callTo, defineRoster } from "./define";

/** C11: the CLI, the dashboard and the hub each planned and ran a Clarity month fill with their own steps. */
export default defineRoster({
    name: "roster-clarity-fill-outside-month-fill",
    candidate: "C11",
    message:
        "Plan and run a Clarity month fill through src/clarity/lib/month-fill.ts, the one module the CLI, the " +
        "dashboard and the hub share; calling the fill steps (loadFillMonth, discoverFillWeeks, planFill, " +
        "executeFillPlan) yourself builds a fourth copy of the flow C11 merged.",
    matcher: callTo(["loadFillMonth", "discoverFillWeeks", "planFill", "executeFillPlan"]),
    onlyIn: /^src\//,
    allowedIn: /^src\/clarity\/lib\/(?:month-fill|fill)\.ts$/,
});
