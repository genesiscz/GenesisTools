/**
 * The views that still break the dense-row gates of swift-lint-rules.ts, counted 2026-10-30 when the gates were
 * added. One key per view: `<file>#<struct>`. A ratchet: no view joins a list, and a view leaves it as soon as it
 * is converted (a value row under `.liveRow(selected:)`, a `static let` formatter, an `==` that compares every
 * stored value). `lint-rules.test.ts` fails when a listed view no longer trips its gate, so a list cannot go stale.
 *
 * The lists were taken from `checkSwiftSource(file, text, { ratchets: false })` over every Swift file of
 * src/macos; the proposals behind the gates are in `.claude/plans/2026-10-29-SwiftLintRuleProposals/`.
 */

/** `swift-row-observes-store`: rows a `ForEach` makes that still hold an observed store. */
export const SWIFT_ROW_OBSERVES_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/macos/GenesisKit/Sources/GenesisKit/Clicky/ClickyOutputSettings.swift#ClickyOutputRuleRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Flow/FlowView.swift#FlowEntryRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Flow/FlowView.swift#FlowSuggestionRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Keymap/KeymapViews.swift#KeymapCommandRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Keymap/KeymapViews.swift#KeymapPageRefresh",
    "src/macos/GenesisKit/Sources/GenesisKit/Markdown/Views/MarkdownFileTreeView.swift#MarkdownFileTreeResultRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Transcript/SessionTranscriptList.swift#ActivitySlot",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Transcript/SessionTranscriptList.swift#TranscriptThumbnail",
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/Shelf/WidgetShelfModules.swift#WidgetShelfRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetStagedViews.swift#WidgetStagedDecisionRow",
    "src/macos/GenesisTools/Sources/Parts/Features/Settings/DaemonSettings.swift#DaemonTaskCard",
    "src/macos/GenesisTools/Sources/Parts/Hub/Settings/PRActivitySettings.swift#PRActivityProjectRow",
]);

/** `swift-row-control-at-rest`: rows a `ForEach` makes that still carry a control at rest (no `.liveRow`). */
export const SWIFT_ROW_CONTROL_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/macos/GenesisKit/Sources/GenesisKit/Clicky/ClickyOutputSettings.swift#ClickyOutputRuleRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Diff/Views/GitCommitPicker.swift#GitCommitPickerRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Files/FileTree.swift#FileTreeRowView",
    "src/macos/GenesisKit/Sources/GenesisKit/Flow/FlowView.swift#FlowEntryRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Flow/FlowView.swift#FlowSuggestionRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Focus/Studio/FocusSessionDetailView.swift#FocusSessionEventRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Focus/Studio/FocusStudioView.swift#FocusSessionCardView",
    "src/macos/GenesisKit/Sources/GenesisKit/Keymap/KeymapViews.swift#KeymapCommandRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Markdown/Views/MarkdownContentView.swift#MarkdownBlockView",
    "src/macos/GenesisKit/Sources/GenesisKit/Markdown/Views/MarkdownFileTreeView.swift#MarkdownFileTreeResultRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Navigation/NavigationHistoryList.swift#NavigationHistoryRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Paths/PathMenu.swift#PathMenuEntriesView",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Detail/SessionDetailScreen.swift#FileTouchRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Transcript/PromptParts.swift#SystemPartLine",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Transcript/PromptParts.swift#TaskPartLine",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Transcript/PromptParts.swift#TeammatePartCard",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Transcript/SessionTranscriptList.swift#FilterChip",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Transcript/SessionTranscriptList.swift#TranscriptSectionHeader",
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/Transcript/SessionTranscriptList.swift#TranscriptThumbnail",
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/AgentWidgetViews.swift#WidgetChoiceRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/Shelf/WidgetShelfModules.swift#WidgetShelfRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetAttachmentViews.swift#WidgetAssetTile",
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetStagedViews.swift#WidgetStagedDecisionRow",
    "src/macos/GenesisTools/Sources/Host/LocalNetworkWatch.swift#LocalNetworkPromptRow",
    "src/macos/GenesisTools/Sources/Parts/Features/Settings/DaemonSettings.swift#DaemonTaskCard",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubAgents.swift#AgentMailRow",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubFolders.swift#HubFolderTreeHeader",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubInbox.swift#InboxExcerptCard",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubPRs.swift#PRLabelPill",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubTranscriptSearch.swift#HubSearchHitRow",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubWindow.swift#PaneToggle",
    "src/macos/GenesisTools/Sources/Parts/Hub/Review/ReviewWindow.swift#RootFolderRow",
    "src/macos/GenesisTools/Sources/Parts/Hub/Settings/PRActivitySettings.swift#PRActivityProjectRow",
]);

/** `swift-formatter-in-view`: views that still make a formatter or a regex in a body or a computed property. */
export const SWIFT_FORMATTER_IN_VIEW_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/macos/GenesisKit/Sources/GenesisKit/Diff/Views/GitCommitPicker.swift#GitCommitPickerRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Flow/FlowView.swift#FlowEntryRow",
    "src/macos/GenesisKit/Sources/GenesisKit/Flow/FlowView.swift#FlowHistoryPane",
    "src/macos/GenesisKit/Sources/GenesisKit/Markdown/Views/MarkdownStatusBar.swift#MarkdownStatusBar",
    "src/macos/GenesisTools/Sources/Host/LocalNetworkWatch.swift#LocalNetworkPromptRow",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubPRSessions.swift#PRSessionRow",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubTimeline.swift#TimelineMain",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubTimeline.swift#TimelineRowView",
]);

/** `swift-equatable-eq-skips-value`: `==` bodies that skip a stored value, not yet reviewed (a proxy such as `revision`, or a stale view). */
export const SWIFT_EQUATABLE_SKIPS_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/ToolCalls/SessionToolCallView.swift#ToolCallRowView",
    "src/macos/GenesisKit/Sources/GenesisKitCharts/SunburstChart.swift#SunburstArcsLayer",
    "src/macos/GenesisKit/Sources/GenesisKitCharts/TreemapView.swift#TreemapCellsLayer",
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubAgents.swift#AgentTranscriptPane",
]);
