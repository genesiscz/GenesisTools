import SwiftUI

// Hub UX wave 2, area "usageSettings", option A for the settings pages: grouped rows like System Settings. Drawn only
// in a run started with `--sketch usageSettings=a` (`DesignSketch`); without the flag every page draws its current
// cards.
//
// - One quiet group per topic: a heading outside, one fill, hairlines between rows. No card inside a card, and a
//   choice's explanation is the row's own detail, not a filled strip under it (C61).
// - Panes: one group per hub mode that owns the setting, with the mode's symbol (C57).
// - Usage charts: a preview of a sample lane pinned at the top of the page, drawn with the page's own choices (C60).
// The Daemon page of this option is in the features part (Parts/Features/Sketches/UsageSettingsSketchDaemonA.swift)
// and uses the group below.

/// A titled group of settings rows on one quiet fill, with hairlines between rows (`UsageSettingsSketchSeparatorA`).
public struct UsageSettingsSketchGroupA<Content: View>: View {
    private let title: String?
    private let symbol: String?
    private let footer: String?
    private let content: Content

    public init(_ title: String? = nil, symbol: String? = nil, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.footer = footer
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let title {
                HStack(spacing: 6) {
                    if let symbol {
                        Image(systemName: symbol)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 16)
                            .accessibilityHidden(true)
                    }
                    Text(title).font(.system(size: 13, weight: .semibold))
                }
                .padding(.leading, 6)
                .accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: 0) {
                content.environment(\.nativeSettingsSearchCard, title)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
            if let footer {
                Text(footer)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The hairline between two rows of a group.
public struct UsageSettingsSketchSeparatorA: View {
    public init() {}

    public var body: some View {
        Rectangle().fill(Color.primary.opacity(0.09)).frame(height: 0.5)
    }
}

extension View {
    /// The vertical rhythm of one row in a group.
    public func usageSketchRowA() -> some View {
        padding(.vertical, 10)
    }
}

/// A row whose choice is a few words side by side; the selected option's sentence is the row's detail, so nothing
/// is drawn under the row.
struct UsageSettingsSketchChoiceA<Value: Hashable>: View {
    let title: String
    let identifier: String
    let options: [NativeSettingsOption<Value>]
    @Binding var selection: Value
    var minSegmentWidth: CGFloat = 72
    var fallbackDetail: String?

    var body: some View {
        NativeSettingsRow(title, detail: options.first { $0.value == selection }?.detail ?? fallbackDetail) {
            GenSegmentedTabs(
                title, items: options.map { GenSegmentedTabs.Item($0.value, $0.title) }, selection: $selection,
                minSegmentWidth: minSegmentWidth, identifier: identifier)
                .nativeSettingsDisabledLook()
        }
        .usageSketchRowA()
    }
}

// MARK: - Panes

/// Hub → Panes, option A: the same settings, grouped by the hub mode that shows them.
@MainActor
struct UsageSettingsSketchPanesA: View {
    @ObservedObject var preferences: HubPreferences
    @AppStorage(GitCommitClickMode.defaultsKey) private var commitClick = GitCommitClickMode.chooseThenShow.rawValue
    @AppStorage(HubResizeGrips.key) private var resizeGrips = HubResizeGrips.auto.rawValue
    @AppStorage(HubDiffLayout.key) private var diffLayout = HubDiffLayout.auto.rawValue
    @AppStorage(HubInboxCards.contextOpenKey) private var inboxContextOpen = false
    @AppStorage(HubAgentsEntry.openNewestKey) private var agentsOpenNewest = true
    @AppStorage(HubAgentsEntry.foldFinishedKey) private var agentsFoldFinished = true
    @AppStorage(HubPROverview.descriptionWholeKey) private var prDescriptionWhole = false
    @AppStorage(HubActivityRows.allActionsKey) private var activityAllActions = false
    @AppStorage(HubActivityRows.commitPrefixKey) private var activityCommitPrefix = false
    @AppStorage(HubSessionRows.hideSharedKey) private var sessionsHideShared = true
    @AppStorage(HubPRRowCI.key) private var prRowCI = HubPRRowCI.unusual.rawValue
    @AppStorage(HubPRRowHoverChecks.key) private var prHoverChecks = HubPRRowHoverChecks.onRest.rawValue
    @AppStorage(HubFileTreeFold.key) private var filesFoldAbove = HubFileTreeFold.defaultAbove
    @AppStorage(TranscriptOutputFold.key) private var transcriptOutputFold = TranscriptOutputFold.defaultLines
    @AppStorage(HubChrome.glassButtonKey) private var glassButton = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            UsageSettingsSketchGroupA("Sessions", symbol: "bubble.left.and.text.bubble.right") {
                NativeSettingsToggle(
                    "Hide what every session in a group shares",
                    detail: "A project, account or app chip that every row of a group shows appears on the group's first row only.",
                    identifier: "hub.sessions.hideShared", isOn: $sessionsHideShared)
                    .usageSketchRowA()
                UsageSettingsSketchSeparatorA()
                number("Fold tool output after", detail: "Longer output shows these lines and \"… +N lines\". 0 shows it all in Verbose.",
                       unit: "lines", range: TranscriptOutputFold.range, identifier: "sessionTranscript.outputFold",
                       value: $transcriptOutputFold)
            }
            UsageSettingsSketchGroupA("Changes and commits", symbol: "plus.forwardslash.minus",
                                      footer: "The Split / Unified button in a review's header picks for that review only.") {
                UsageSettingsSketchChoiceA(
                    title: "Diff layout", identifier: "hub.diff.layout",
                    options: HubDiffLayout.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: Binding(get: { HubDiffLayout(rawValue: diffLayout) ?? .auto }, set: { diffLayout = $0.rawValue }),
                    minSegmentWidth: 90)
                UsageSettingsSketchSeparatorA()
                number("Fold a files folder above", detail: "A folder with more changed files starts folded, unless it holds half of the change. 0 never folds.",
                       unit: "files", range: HubFileTreeFold.range, identifier: "hub.files.foldAbove", value: $filesFoldAbove)
                UsageSettingsSketchSeparatorA()
                UsageSettingsSketchChoiceA(
                    title: "A click on a commit", identifier: "hub.commitPicker.click",
                    options: [
                        NativeSettingsOption(GitCommitClickMode.chooseThenShow, "Choose",
                                             detail: "The first click chooses it and a second click shows it."),
                        NativeSettingsOption(GitCommitClickMode.showAtOnce, "Show",
                                             detail: "A click shows the commit at once. Shift-click chooses a run of commits."),
                    ],
                    selection: Binding(
                        get: { GitCommitClickMode(rawValue: commitClick) ?? .chooseThenShow }, set: { commitClick = $0.rawValue }))
            }
            UsageSettingsSketchGroupA("Pull requests", symbol: "arrow.triangle.pull") {
                NativeSettingsToggle(
                    "Show each PR's whole description",
                    detail: "Off: a long description shows as much as fits in 60% of the column, then Show description.",
                    identifier: "hub.prs.descriptionWhole", isOn: $prDescriptionWhole)
                    .usageSketchRowA()
                UsageSettingsSketchSeparatorA()
                UsageSettingsSketchChoiceA(
                    title: "PR rows show CI", identifier: "hub.prs.rowCI",
                    options: HubPRRowCI.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: Binding(get: { HubPRRowCI.stored(prRowCI) }, set: { prRowCI = $0.rawValue }),
                    minSegmentWidth: 90)
                UsageSettingsSketchSeparatorA()
                UsageSettingsSketchChoiceA(
                    title: "Load failed checks for a row's tooltip", identifier: "hub.prs.hoverChecks",
                    options: HubPRRowHoverChecks.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: Binding(get: { HubPRRowHoverChecks.stored(prHoverChecks) }, set: { prHoverChecks = $0.rawValue }),
                    minSegmentWidth: 90)
            }
            UsageSettingsSketchGroupA("Inbox", symbol: "tray") {
                NativeSettingsToggle(
                    "Show each decision's context in full",
                    detail: "Off: a card shows five lines of its context and Show more.",
                    identifier: "hub.inbox.contextOpen", isOn: $inboxContextOpen)
                    .usageSketchRowA()
            }
            UsageSettingsSketchGroupA("Activity", symbol: "clock") {
                NativeSettingsToggle(
                    "Show every action on a row",
                    detail: "Off: a hovered row shows open and copy, and one menu holds the rest.",
                    identifier: "hub.activity.allActions", isOn: $activityAllActions)
                    .usageSketchRowA()
                UsageSettingsSketchSeparatorA()
                NativeSettingsToggle(
                    "Start commit titles with their type and scope",
                    detail: "Off: a commit row starts with what changed.",
                    identifier: "hub.activity.commitPrefix", isOn: $activityCommitPrefix)
                    .usageSketchRowA()
            }
            UsageSettingsSketchGroupA("Agents", symbol: "person.2.wave.2") {
                NativeSettingsToggle(
                    "Open the newest live agent",
                    detail: "Entering Agents with nothing open shows the newest running sub-agent, or the newest live session.",
                    identifier: "hub.agents.openNewest", isOn: $agentsOpenNewest)
                    .usageSketchRowA()
                UsageSettingsSketchSeparatorA()
                NativeSettingsToggle(
                    "Fold finished sub-agents",
                    detail: "A session's finished sub-agents sit in one row under its running ones until you open it.",
                    identifier: "hub.agents.foldFinished", isOn: $agentsFoldFinished)
                    .usageSketchRowA()
                UsageSettingsSketchSeparatorA()
                UsageSettingsSketchChoiceA(
                    title: "When a refresh moves a row", identifier: "hub.agents.motion",
                    options: HubListMotion.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: $preferences.agentsMotion, minSegmentWidth: 80)
                UsageSettingsSketchSeparatorA()
                NativeSettingsToggle(
                    "Measure energy impact of agent processes",
                    detail: "Adds macOS energy impact to each process. Every refresh takes one top sample of about 1 s.",
                    identifier: "hub.procs.energy", isOn: $preferences.processEnergy)
                    .usageSketchRowA()
            }
            UsageSettingsSketchGroupA("Worktrees", symbol: "arrow.triangle.branch") {
                number("Removable after idle for", detail: "Only worktrees idle this long count as removable. 0 days means any idle time.",
                       unit: "days", range: HubPreferences.cleanupIdleDaysRange, identifier: "hub.cleanup.idleDays",
                       value: $preferences.cleanupIdleDays)
            }
            UsageSettingsSketchGroupA("Every mode", symbol: "macwindow",
                                      footer: "Changes apply to a running hub at once.") {
                UsageSettingsSketchChoiceA(
                    title: "Show the resize grip", identifier: "hub.resizeGrips",
                    options: HubResizeGrips.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: Binding(get: { HubResizeGrips(rawValue: resizeGrips) ?? .auto }, set: { resizeGrips = $0.rawValue }),
                    minSegmentWidth: 80)
                UsageSettingsSketchSeparatorA()
                NativeSettingsToggle(
                    "Show a Glass button beside Settings",
                    detail: "Off: Glass stays in View → Glass (⌘⇧G), the command palette and Appearance.",
                    identifier: "hub.chrome.glassButton", isOn: $glassButton)
                    .usageSketchRowA()
            }
        }
    }

    private func number(_ title: String, detail: String, unit: String, range: ClosedRange<Int>, identifier: String,
                        value: Binding<Int>) -> some View {
        NativeSettingsRow(title, detail: detail) {
            HStack(spacing: 8) {
                NativeSettingsNumberPicker(title, range: range.lowerBound ..< (range.upperBound + 1), identifier: identifier, value: value)
                Text(unit).font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .usageSketchRowA()
    }
}

// MARK: - Usage charts

/// AI usage → Usage charts, option A: a sample lane pinned at the top of the page follows every choice under it.
@MainActor
struct UsageSettingsSketchChartsA: View {
    @ObservedObject var preferences: UsagePreferences
    @Environment(\.nativeSettingsIndexing) private var indexing

    var body: some View {
        if indexing {
            VStack(alignment: .leading, spacing: 22) { groups }
        } else {
            LazyVStack(alignment: .leading, spacing: 22, pinnedViews: [.sectionHeaders]) {
                Section {
                    groups
                } header: {
                    preview
                        .padding(.bottom, 8)
                        .background(.regularMaterial)
                }
            }
        }
    }

    private var preview: some View {
        let now = Date()
        let sample = UsageSketchSampleA.account(settings: preferences.settings, now: now)
        return UsageSettingsSketchGroupA(
            "Preview", symbol: "eye",
            footer: "A fixed sample account, drawn with the choices below. Resolution changes what the hub reads, so the sample cannot show it."
        ) {
            UsageBurnChart(accounts: [sample.account], domain: sample.domain, settings: preferences.settings, now: now)
                .padding(.vertical, 10)
                .environment(\.colorScheme, .dark)
                .accessibilityLabel("Sample burn lanes drawn with these settings")
        }
    }

    @ViewBuilder
    private var groups: some View {
        UsageSettingsSketchGroupA("Limits table", symbol: "tablecells") {
            NativeSettingsToggle("Hide empty columns", detail: "Leave out a window column that no account has a reading for.",
                                 identifier: "usage.hideEmptyColumns", isOn: preferences.binding(\.hideEmptyColumns))
                .usageSketchRowA()
        }
        UsageSettingsSketchGroupA("Burn lanes", symbol: "chart.xyaxis.line") {
            UsageSettingsSketchChoiceA(
                title: "Range", identifier: "usage.range",
                options: UsageRange.allCases.map { NativeSettingsOption($0, $0.title) },
                selection: preferences.binding(\.range), minSegmentWidth: 52,
                fallbackDetail: "How far back the lanes reach when the Usage mode opens.")
            UsageSettingsSketchSeparatorA()
            UsageSettingsSketchChoiceA(
                title: "Resolution", identifier: "usage.resolution",
                options: UsageResolution.allCases.map { NativeSettingsOption($0, $0.title) },
                selection: preferences.binding(\.resolution), minSegmentWidth: 52,
                fallbackDetail: "Auto draws every reading up to 48 h and min-max bins above, so a short peak stays visible.")
            UsageSettingsSketchSeparatorA()
            UsageSettingsSketchChoiceA(
                title: "Line shape", identifier: "usage.lineShape",
                options: [
                    NativeSettingsOption(UsageLineShape.step, "Step", detail: "Holds a value until the next reading, as the store records it."),
                    NativeSettingsOption(UsageLineShape.linear, "Linear", detail: "Joins the readings with straight lines."),
                ],
                selection: preferences.binding(\.lineShape))
            UsageSettingsSketchSeparatorA()
            UsageSettingsSketchChoiceA(
                title: "Window with no limit", identifier: "usage.absentWindow",
                options: [
                    NativeSettingsOption(UsageAbsentWindow.band, "Show a band", detail: "An account without a 5h limit gets a hatched band."),
                    NativeSettingsOption(UsageAbsentWindow.hide, "Hide the lane", detail: "An account without a 5h limit gets no 5h lane."),
                ],
                selection: preferences.binding(\.absentWindow), minSegmentWidth: 96)
            UsageSettingsSketchSeparatorA()
            toggle("Scoped windows", "Give Fable and other scoped windows lanes of their own.", "usage.scopedWindows", \.scopedWindows)
            UsageSettingsSketchSeparatorA()
            toggle("Reset bands", "Shade every other window period and draw a line at each reset.", "usage.resetBands", \.resetBands)
            UsageSettingsSketchSeparatorA()
            toggle("Severity colour", "Green, orange at 75%, red at 90%. Off uses the provider's colour.", "usage.severityColour", \.severityColour)
        }
        UsageSettingsSketchGroupA("Forecast", symbol: "chart.line.uptrend.xyaxis") {
            toggle("Projection", "A dashed line from now to the reset at the current rate.", "usage.projection", \.projection)
            UsageSettingsSketchSeparatorA()
            toggle("Cone", "Shade between the slow and the fast pace.", "usage.cone", \.cone)
            UsageSettingsSketchSeparatorA()
            toggle("Safe pace", "A thin line at the rate that lands at exactly 100% at the reset.", "usage.safePace", \.safePace)
            UsageSettingsSketchSeparatorA()
            toggle("Cone in the Today digest", "A small cone beside each account in the hub's Today digest.", "usage.digestCone", \.digestCone)
        }
        UsageSettingsSketchGroupA("Markers", symbol: "diamond") {
            toggle("Spikes", "A diamond on each sharp rise. A click lists the sessions that spent then.", "usage.spikeMarkers", \.spikeMarkers)
            UsageSettingsSketchSeparatorA()
            toggle("Events", "A tick for each rate limit, cooldown, poll pause, block and refused probe.", "usage.eventMarkers", \.eventMarkers)
            UsageSettingsSketchSeparatorA()
            toggle("Poll coverage", "A strip under each account: measured, stale, blocked, held back or not measured.", "usage.coverageStrip", \.coverageStrip)
        }
        UsageSettingsSketchGroupA("Spend", symbol: "chart.bar.xaxis", footer: "Changes apply to a running hub at once.") {
            UsageSettingsSketchChoiceA(
                title: "Stack by", identifier: "usage.spendStack",
                options: UsageSpendStack.allCases.map { NativeSettingsOption($0, $0.title) },
                selection: preferences.binding(\.spendStack), minSegmentWidth: 60,
                fallbackDetail: "What the Spend tab's bars are split by when it opens.")
        }
    }

    private func toggle(_ title: String, _ detail: String, _ identifier: String, _ path: WritableKeyPath<UsageSettings, Bool>) -> some View {
        NativeSettingsToggle(title, detail: detail, identifier: identifier, isOn: preferences.binding(path))
            .usageSketchRowA()
    }
}

/// The preview's sample account: a 5h lane that climbs in steps and resets every five hours, a week lane, a band for a
/// window with no limit, one spike, one event and a coverage record. A fixed shape, not a reading of any account.
enum UsageSketchSampleA {
    static func account(settings: UsageSettings, now: Date) -> (account: UsageAccountLanes, domain: ClosedRange<Date>) {
        let span = settings.range.seconds
        let start = now.addingTimeInterval(-span)
        let key = UsageAccountKey(provider: "anthropic", accountId: "sketch-sample", accountName: "Sample account")
        let step = max(600, span / 160)
        let period: TimeInterval = 5 * 3600
        let week: TimeInterval = 7 * 86400
        var fiveHour: [UsageLaneSample] = []
        var weekly: [UsageLaneSample] = []
        var time = start
        while time <= now {
            let seconds = time.timeIntervalSince1970
            let index = Int(seconds / period)
            let position = seconds.truncatingRemainder(dividingBy: period) / period
            let weight = [0.35, 0.9, 0.55, 1.15, 0.2][index % 5]
            let value = min(100, (position * 16).rounded(.down) * 5 * weight)
            fiveHour.append(UsageLaneSample(date: time, value: value, severity: UsageTone.severity(forPercent: value)))
            let weekValue = min(100, seconds.truncatingRemainder(dividingBy: week) / week * 70)
            weekly.append(UsageLaneSample(date: time, value: weekValue, severity: UsageTone.severity(forPercent: weekValue)))
            time = time.addingTimeInterval(step)
        }
        let last = fiveHour.last?.value ?? 0
        let nextReset = Date(timeIntervalSince1970: (now.timeIntervalSince1970 / period).rounded(.up) * period)
        let rate = 16.0
        let exhaust = now.addingTimeInterval((100 - last) / rate * 3600)
        let hoursLeft = max(0.1, nextReset.timeIntervalSince(now) / 3600)
        let forecast = UsageLaneForecast(
            start: now, value: last, ratePerHour: rate, lowPerHour: 10, highPerHour: 24,
            safePerHour: (100 - last) / hoursLeft, resetAt: nextReset, exhaustAt: exhaust, beforeReset: exhaust < nextReset)
        var resets: [Date] = []
        var reset = Date(timeIntervalSince1970: (start.timeIntervalSince1970 / period).rounded(.up) * period)
        while reset <= nextReset {
            resets.append(reset)
            reset = reset.addingTimeInterval(period)
        }
        let spikeEnd = now.addingTimeInterval(-span * 0.18)
        let spike = UsageLaneSpike(
            id: "sketch-sample-spike", from: spikeEnd.addingTimeInterval(-600), to: spikeEnd, start: 30, end: 45, delta: 15,
            text: "+15 points in 10 min (sample)", topSession: nil)
        let event = UsageLaneEvent(date: now.addingTimeInterval(-span * 0.55), kind: "rate-limited", text: "Rate limited (sample)")
        var lanes = [
            UsageLane(id: "sample-5h", account: key, key: "session", kind: "session", title: "5h", samples: fiveHour,
                      resets: resets, periodSeconds: period, current: last, currentSeverity: UsageTone.severity(forPercent: last),
                      forecast: forecast, events: [event], spikes: [spike]),
            UsageLane(id: "sample-week", account: key, key: "weekly", kind: "weekly", title: "Week", samples: weekly,
                      periodSeconds: week, current: weekly.last?.value,
                      currentSeverity: UsageTone.severity(forPercent: weekly.last?.value ?? 0)),
        ]
        if settings.absentWindow == .band {
            lanes.append(UsageLane(
                id: "sample-none", account: key, key: "monthly", kind: "monthly", title: "Month",
                samples: [UsageLaneSample(date: start, value: 0), UsageLaneSample(date: now, value: 0)],
                absent: [UsageLaneSpan(from: start, to: now, state: "absent")], absentNow: true))
        }
        let coverage = [
            UsageLaneSpan(from: start, to: start.addingTimeInterval(span * 0.6), state: "ok"),
            UsageLaneSpan(from: start.addingTimeInterval(span * 0.6), to: start.addingTimeInterval(span * 0.68), state: "stale"),
            UsageLaneSpan(from: start.addingTimeInterval(span * 0.68), to: now, state: "ok"),
        ]
        let end = settings.drawsForecast ? max(now.addingTimeInterval(span * 0.12), min(nextReset, now.addingTimeInterval(span * 0.25))) : now
        return (UsageAccountLanes(account: key, lanes: lanes, coverage: coverage, coverageRecorded: true), start...end)
    }
}
