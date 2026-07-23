import { Stack } from "expo-router";
import { useThemeColors } from "@/theme/colors";

/**
 * Self-contained Stack layout for the deferred "More" feature screens (claude-usage / daemon /
 * containers / weather / connections). expo-router v55 auto-treats every file in this directory as
 * an eligible route in this Stack — no per-screen registration needed here. This file is OWNED by
 * the features-rest agent (plan 09); it does NOT touch the tabs `_layout.tsx`.
 *
 * The header is themed to the dark "Obsidian Terminal" palette here — without this, iOS renders its
 * DEFAULT light/white navigation bar on every (more) sub-screen (the "weird white header" bug). We
 * read the tokens via `useThemeColors()` (a hook — legal inside this layout component) so the bar
 * matches the rest of the app: dark base background, light title text, mono title, no bottom hairline.
 *
 * ORCHESTRATOR CONSOLIDATION NOTE: to surface these from the tab bar, add a link from the existing
 * `more` tab (or a `(more)` group entry) in `src/app/(tabs)/_layout.tsx` / `more.tsx`. The routes
 * are reachable as `/claude-usage`, `/daemon`, `/containers`, `/weather`, `/connections` once linked.
 * See DevDashboard/research/20-impl-09-rest-notes.md.
 */
export default function MoreFeaturesLayout() {
    const c = useThemeColors();

    return (
        <Stack
            screenOptions={{
                headerShown: true,
                headerBackTitle: "More",
                headerStyle: { backgroundColor: c.bgBase },
                headerTintColor: c.textPrimary,
                headerTitleStyle: { color: c.textPrimary, fontFamily: "monospace" },
                headerShadowVisible: false,
                contentStyle: { backgroundColor: c.bgBase },
            }}
        />
    );
}
