/**
 * Barrel for Tier-1 SHARED presentational primitives (the "Obsidian Terminal" aesthetic). Feature
 * agents CONSUME these — they must NOT modify them (parallel edits to shared files = merge
 * conflicts). Feature-specific components live in `src/features/<x>/components/`. If a feature needs
 * a NEW shared primitive, build it feature-local and FLAG it for the orchestrator to promote here.
 */
export { Banner } from "@/ui/Banner";
export { Card } from "@/ui/Card";
export { Empty } from "@/ui/Empty";
export { ErrorBoundary } from "@/ui/ErrorBoundary";
export { KeyValueRow } from "@/ui/KeyValueRow";
export { ListRow } from "@/ui/ListRow";
export { Loading } from "@/ui/Loading";
export { MetricChart, type MetricChartProps, type MetricPoint, VictoryMetricChart } from "@/ui/MetricChart";
export { MockBadge } from "@/ui/MockBadge";
export { Screen } from "@/ui/Screen";
export { SectionHeader } from "@/ui/SectionHeader";
export { StatTile } from "@/ui/StatTile";
export { type PillTone, StatusPill } from "@/ui/StatusPill";
export { TabPlaceholder } from "@/ui/TabPlaceholder";
