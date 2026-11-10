import SwiftUI

// Hub UX wave 2, area "usageSettings", option B for the settings pages: flat pages with no fill at all. Drawn only in
// a run started with `--sketch usageSettings=b` (`DesignSketch`); without the flag every page draws its current cards.
//
// - A section is a heading and a hairline; rows are separated by hairlines on the window's own background, the way a
//   Golden Gate form reads with its decorative radii removed (C61).
// - Panes: one tab per hub mode, so the page shows only the settings of the mode you think of (C57).
// - Usage charts: every choice draws its own effect: a small picture beside each switch, and pictures as the options
//   of each choice (C60).
// The Daemon page of this option is in the features part (Parts/Features/Sketches/UsageSettingsSketchDaemonB.swift)
// and uses the section below.

/// A flat section: a heading, an optional sentence, a hairline, then the rows with `UsageSettingsSketchRuleB` between.
public struct UsageSettingsSketchSectionB<Content: View>: View {
    private let title: String
    private let subtitle: String?
    private let content: Content

    public init(_ title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 15, weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(subtitle).font(.system(size: 11.5)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.bottom, 8)
            UsageSettingsSketchRuleB()
            content.environment(\.nativeSettingsSearchCard, title)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The hairline between two flat rows.
public struct UsageSettingsSketchRuleB: View {
    public init() {}

    public var body: some View {
        Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 0.5)
    }
}

extension View {
    /// The vertical rhythm of one flat row.
    public func usageSketchRowB() -> some View {
        padding(.vertical, 11)
    }
}

/// A choice of a few words: the segments on the right, the selected option's sentence as the row's detail.
struct UsageSettingsSketchChoiceB<Value: Hashable>: View {
    let title: String
    let identifier: String
    let options: [NativeSettingsOption<Value>]
    @Binding var selection: Value
    var minSegmentWidth: CGFloat = 72

    var body: some View {
        NativeSettingsRow(title, detail: options.first { $0.value == selection }?.detail) {
            GenSegmentedTabs(
                title, items: options.map { GenSegmentedTabs.Item($0.value, $0.title) }, selection: $selection,
                minSegmentWidth: minSegmentWidth, identifier: identifier)
                .nativeSettingsDisabledLook()
        }
        .usageSketchRowB()
    }
}

// MARK: - Panes

/// The hub modes the Panes page is split by.
enum UsageSketchPaneTabB: String, CaseIterable, Hashable {
    case sessions, changes, prs, inbox, activity, agents, worktrees, window

    var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .changes: return "Changes"
        case .prs: return "PRs"
        case .inbox: return "Inbox"
        case .activity: return "Activity"
        case .agents: return "Agents"
        case .worktrees: return "Worktrees"
        case .window: return "Every mode"
        }
    }

    var subtitle: String {
        switch self {
        case .sessions: return "The session list and the transcript."
        case .changes: return "The diff, the file tree and the commit list of a review, in Sessions, Worktrees and PRs."
        case .prs: return "The PR list and a PR's overview."
        case .inbox: return "The decision and question cards."
        case .activity: return "The rows of the Activity feed."
        case .agents: return "The Agents list and the agent processes pane."
        case .worktrees: return "The worktree cleanup pane."
        case .window: return "The hub window as a whole. Changes apply to a running hub at once."
        }
    }
}

/// Hub → Panes, option B: one tab per hub mode, flat rows. The settings search sees every tab.
@MainActor
struct UsageSettingsSketchPanesB: View {
    @ObservedObject var preferences: HubPreferences
    @Environment(\.nativeSettingsIndexing) private var indexing
    /// The open tab. View state only: the page opens on Sessions.
    @State private var tab: UsageSketchPaneTabB = .sessions
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
        VStack(alignment: .leading, spacing: 20) {
            if indexing {
                ForEach(UsageSketchPaneTabB.allCases, id: \.self) { section($0) }
            } else {
                GenSegmentedTabs(
                    "Hub mode", items: UsageSketchPaneTabB.allCases.map { GenSegmentedTabs.Item($0, $0.title) },
                    selection: $tab, minSegmentWidth: 56, identifier: "usageSketchB.panes.mode", fillsWidth: true)
                section(tab)
            }
        }
    }

    private func section(_ tab: UsageSketchPaneTabB) -> some View {
        UsageSettingsSketchSectionB(tab.title, subtitle: tab.subtitle) {
            rows(tab)
        }
    }

    @ViewBuilder
    private func rows(_ tab: UsageSketchPaneTabB) -> some View {
        switch tab {
        case .sessions:
            NativeSettingsToggle(
                "Hide what every session in a group shares",
                detail: "A project, account or app chip that every row of a group shows appears on the group's first row only.",
                identifier: "hub.sessions.hideShared", isOn: $sessionsHideShared)
                .usageSketchRowB()
            UsageSettingsSketchRuleB()
            number("Fold tool output after", detail: "Longer output shows these lines and \"… +N lines\". 0 shows it all in Verbose.",
                   unit: "lines", range: TranscriptOutputFold.range, identifier: "sessionTranscript.outputFold", value: $transcriptOutputFold)
        case .changes:
            UsageSettingsSketchChoiceB(
                title: "Diff layout", identifier: "hub.diff.layout",
                options: HubDiffLayout.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                selection: Binding(get: { HubDiffLayout(rawValue: diffLayout) ?? .auto }, set: { diffLayout = $0.rawValue }),
                minSegmentWidth: 90)
            UsageSettingsSketchRuleB()
            number("Fold a files folder above", detail: "A folder with more changed files starts folded, unless it holds half of the change. 0 never folds.",
                   unit: "files", range: HubFileTreeFold.range, identifier: "hub.files.foldAbove", value: $filesFoldAbove)
            UsageSettingsSketchRuleB()
            UsageSettingsSketchChoiceB(
                title: "A click on a commit", identifier: "hub.commitPicker.click",
                options: [
                    NativeSettingsOption(GitCommitClickMode.chooseThenShow, "Choose",
                                         detail: "The first click chooses it and a second click shows it."),
                    NativeSettingsOption(GitCommitClickMode.showAtOnce, "Show",
                                         detail: "A click shows the commit at once. Shift-click chooses a run of commits."),
                ],
                selection: Binding(get: { GitCommitClickMode(rawValue: commitClick) ?? .chooseThenShow }, set: { commitClick = $0.rawValue }))
        case .prs:
            NativeSettingsToggle(
                "Show each PR's whole description",
                detail: "Off: a long description shows as much as fits in 60% of the column, then Show description.",
                identifier: "hub.prs.descriptionWhole", isOn: $prDescriptionWhole)
                .usageSketchRowB()
            UsageSettingsSketchRuleB()
            UsageSettingsSketchChoiceB(
                title: "PR rows show CI", identifier: "hub.prs.rowCI",
                options: HubPRRowCI.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                selection: Binding(get: { HubPRRowCI.stored(prRowCI) }, set: { prRowCI = $0.rawValue }), minSegmentWidth: 90)
            UsageSettingsSketchRuleB()
            UsageSettingsSketchChoiceB(
                title: "Load failed checks for a row's tooltip", identifier: "hub.prs.hoverChecks",
                options: HubPRRowHoverChecks.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                selection: Binding(get: { HubPRRowHoverChecks.stored(prHoverChecks) }, set: { prHoverChecks = $0.rawValue }),
                minSegmentWidth: 90)
        case .inbox:
            NativeSettingsToggle(
                "Show each decision's context in full", detail: "Off: a card shows five lines of its context and Show more.",
                identifier: "hub.inbox.contextOpen", isOn: $inboxContextOpen)
                .usageSketchRowB()
        case .activity:
            NativeSettingsToggle(
                "Show every action on a row", detail: "Off: a hovered row shows open and copy, and one menu holds the rest.",
                identifier: "hub.activity.allActions", isOn: $activityAllActions)
                .usageSketchRowB()
            UsageSettingsSketchRuleB()
            NativeSettingsToggle(
                "Start commit titles with their type and scope", detail: "Off: a commit row starts with what changed.",
                identifier: "hub.activity.commitPrefix", isOn: $activityCommitPrefix)
                .usageSketchRowB()
        case .agents:
            NativeSettingsToggle(
                "Open the newest live agent",
                detail: "Entering Agents with nothing open shows the newest running sub-agent, or the newest live session.",
                identifier: "hub.agents.openNewest", isOn: $agentsOpenNewest)
                .usageSketchRowB()
            UsageSettingsSketchRuleB()
            NativeSettingsToggle(
                "Fold finished sub-agents", detail: "A session's finished sub-agents sit in one row under its running ones.",
                identifier: "hub.agents.foldFinished", isOn: $agentsFoldFinished)
                .usageSketchRowB()
            UsageSettingsSketchRuleB()
            UsageSettingsSketchChoiceB(
                title: "When a refresh moves a row", identifier: "hub.agents.motion",
                options: HubListMotion.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                selection: $preferences.agentsMotion, minSegmentWidth: 80)
            UsageSettingsSketchRuleB()
            NativeSettingsToggle(
                "Measure energy impact of agent processes",
                detail: "Adds macOS energy impact to each process. Every refresh takes one top sample of about 1 s.",
                identifier: "hub.procs.energy", isOn: $preferences.processEnergy)
                .usageSketchRowB()
        case .worktrees:
            number("Removable after idle for", detail: "Only worktrees idle this long count as removable. 0 days means any idle time.",
                   unit: "days", range: HubPreferences.cleanupIdleDaysRange, identifier: "hub.cleanup.idleDays",
                   value: $preferences.cleanupIdleDays)
        case .window:
            UsageSettingsSketchChoiceB(
                title: "Show the resize grip", identifier: "hub.resizeGrips",
                options: HubResizeGrips.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                selection: Binding(get: { HubResizeGrips(rawValue: resizeGrips) ?? .auto }, set: { resizeGrips = $0.rawValue }),
                minSegmentWidth: 80)
            UsageSettingsSketchRuleB()
            NativeSettingsToggle(
                "Show a Glass button beside Settings", detail: "Off: Glass stays in View → Glass (⌘⇧G), the command palette and Appearance.",
                identifier: "hub.chrome.glassButton", isOn: $glassButton)
                .usageSketchRowB()
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
        .usageSketchRowB()
    }
}

// MARK: - Usage charts

/// What a picture beside a chart setting shows.
enum UsageSketchGlyphB: Hashable {
    case step, linear, band, noLane, auto, raw, bins
    case resets, severity, projection, cone, safePace, spikes, events, coverage, scoped, digestCone, hideColumns
}

/// A small drawing of one chart element, accent when the setting draws it, faint when it does not.
struct UsageSketchGlyphViewB: View {
    let glyph: UsageSketchGlyphB
    let on: Bool

    var body: some View {
        Canvas { context, size in draw(context, size) }
            .frame(width: 64, height: 30)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
            .accessibilityHidden(true)
    }

    private var ink: Color { on ? Color.accentColor : Color.primary.opacity(0.25) }
    private var base: Color { Color.primary.opacity(0.45) }

    /// A rising line with three plateaus, the base every picture shares.
    private func baseLine(_ size: CGSize, linear: Bool = false) -> Path {
        let points: [(CGFloat, CGFloat)] = [(0.06, 0.8), (0.3, 0.62), (0.55, 0.45), (0.78, 0.3)]
        var path = Path()
        for (index, point) in points.enumerated() {
            let p = CGPoint(x: point.0 * size.width, y: point.1 * size.height)
            if index == 0 { path.move(to: p); continue }
            if !linear { path.addLine(to: CGPoint(x: p.x, y: points[index - 1].1 * size.height)) }
            path.addLine(to: p)
        }
        return path
    }

    private func draw(_ context: GraphicsContext, _ size: CGSize) {
        let w = size.width
        let h = size.height
        switch glyph {
        case .step, .linear:
            context.stroke(baseLine(size, linear: glyph == .linear), with: .color(ink), lineWidth: 1.5)
        case .band:
            context.stroke(baseLine(size), with: .color(base), lineWidth: 1)
            var hatch = Path()
            for x in stride(from: 4.0, to: w, by: 5) {
                hatch.move(to: CGPoint(x: x, y: h * 0.86))
                hatch.addLine(to: CGPoint(x: x - 4, y: h * 0.98))
            }
            context.stroke(hatch, with: .color(ink), lineWidth: 0.8)
        case .noLane:
            context.stroke(baseLine(size), with: .color(base), lineWidth: 1)
        case .raw, .auto, .bins:
            for index in 0 ..< 14 {
                let x = CGFloat(index) / 14 * w + 3
                let y = h * (0.8 - CGFloat(index) / 14 * 0.5) + (index % 3 == 0 ? -3 : 2)
                if glyph == .raw {
                    context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 2, height: 2)), with: .color(ink))
                } else if glyph == .auto {
                    var whisker = Path()
                    whisker.move(to: CGPoint(x: x, y: y - 4))
                    whisker.addLine(to: CGPoint(x: x, y: y + 4))
                    context.stroke(whisker, with: .color(ink.opacity(0.6)), lineWidth: 1)
                } else if index % 2 == 0 {
                    context.fill(Path(CGRect(x: x, y: y, width: 6, height: 2)), with: .color(ink))
                }
            }
        case .resets:
            context.fill(Path(CGRect(x: w * 0.33, y: 0, width: w * 0.33, height: h)), with: .color(ink.opacity(0.18)))
            for x in [w * 0.33, w * 0.66] {
                var line = Path()
                line.move(to: CGPoint(x: x, y: 0))
                line.addLine(to: CGPoint(x: x, y: h))
                context.stroke(line, with: .color(ink), lineWidth: 1)
            }
            context.stroke(baseLine(size), with: .color(base), lineWidth: 1)
        case .severity:
            let line = baseLine(size)
            context.stroke(line, with: .linearGradient(
                Gradient(colors: on ? [UsageTone.severity("ok"), UsageTone.severity("warning"), UsageTone.severity("critical")] : [base, base]),
                startPoint: .zero, endPoint: CGPoint(x: w, y: 0)), lineWidth: 1.5)
        case .projection, .cone, .safePace:
            context.stroke(baseLine(size), with: .color(base), lineWidth: 1)
            let from = CGPoint(x: w * 0.78, y: h * 0.3)
            if glyph == .cone {
                var cone = Path()
                cone.move(to: from)
                cone.addLine(to: CGPoint(x: w * 0.97, y: h * 0.05))
                cone.addLine(to: CGPoint(x: w * 0.97, y: h * 0.3))
                cone.closeSubpath()
                context.fill(cone, with: .color(ink.opacity(0.4)))
            } else {
                var line = Path()
                line.move(to: glyph == .safePace ? CGPoint(x: w * 0.06, y: h * 0.8) : from)
                line.addLine(to: CGPoint(x: w * 0.97, y: glyph == .safePace ? h * 0.08 : h * 0.12))
                context.stroke(line, with: .color(ink), style: StrokeStyle(lineWidth: glyph == .safePace ? 0.8 : 1.3,
                                                                           dash: glyph == .projection ? [3, 2] : []))
            }
        case .spikes:
            context.stroke(baseLine(size), with: .color(base), lineWidth: 1)
            var diamond = Path()
            let c = CGPoint(x: w * 0.55, y: h * 0.45)
            diamond.move(to: CGPoint(x: c.x, y: c.y - 5))
            diamond.addLine(to: CGPoint(x: c.x + 5, y: c.y))
            diamond.addLine(to: CGPoint(x: c.x, y: c.y + 5))
            diamond.addLine(to: CGPoint(x: c.x - 5, y: c.y))
            diamond.closeSubpath()
            context.fill(diamond, with: .color(ink))
        case .events:
            context.stroke(baseLine(size), with: .color(base), lineWidth: 1)
            for x in [w * 0.2, w * 0.45, w * 0.7] {
                var tick = Path()
                tick.move(to: CGPoint(x: x, y: 2))
                tick.addLine(to: CGPoint(x: x, y: 9))
                context.stroke(tick, with: .color(ink), lineWidth: 1.6)
            }
        case .coverage:
            context.stroke(baseLine(CGSize(width: w, height: h * 0.75)), with: .color(base), lineWidth: 1)
            context.fill(Path(CGRect(x: 3, y: h - 6, width: w * 0.6, height: 3)), with: .color(ink))
            context.fill(Path(CGRect(x: 3 + w * 0.6, y: h - 6, width: w * 0.3, height: 3)), with: .color(on ? UsageTone.outcome("stale") : base))
        case .scoped:
            context.stroke(baseLine(CGSize(width: w, height: h * 0.5)), with: .color(base), lineWidth: 1)
            var second = baseLine(CGSize(width: w, height: h * 0.45))
            second = second.applying(CGAffineTransform(translationX: 0, y: h * 0.52))
            context.stroke(second, with: .color(ink), lineWidth: 1.2)
        case .digestCone:
            var cone = Path()
            cone.move(to: CGPoint(x: w * 0.25, y: h * 0.7))
            cone.addLine(to: CGPoint(x: w * 0.75, y: h * 0.2))
            cone.addLine(to: CGPoint(x: w * 0.75, y: h * 0.6))
            cone.closeSubpath()
            context.fill(cone, with: .color(ink.opacity(0.5)))
        case .hideColumns:
            for (index, x) in [0.1, 0.32, 0.54, 0.76].enumerated() {
                let rect = CGRect(x: w * x, y: h * 0.25, width: w * 0.16, height: h * 0.5)
                context.fill(Path(roundedRect: rect, cornerRadius: 1.5),
                             with: .color(index == 2 ? (on ? Color.primary.opacity(0.08) : base) : base))
            }
        }
    }
}

/// A choice drawn as small pictures, each with its title; the selected one has the accent border.
struct UsageSketchPictureChoiceB<Value: Hashable>: View {
    let title: String
    let detail: String?
    let identifier: String
    let options: [(value: Value, title: String, glyph: UsageSketchGlyphB)]
    @Binding var selection: Value

    var body: some View {
        NativeSettingsRow(title, detail: detail) {
            HStack(spacing: 8) {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    let selected = option.value == selection
                    Button {
                        selection = option.value
                    } label: {
                        VStack(spacing: 4) {
                            UsageSketchGlyphViewB(glyph: option.glyph, on: true)
                                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .strokeBorder(selected ? Color.accentColor : .clear, lineWidth: 2))
                            Text(option.title)
                                .font(.system(size: 10.5, weight: selected ? .semibold : .regular))
                                .foregroundStyle(selected ? .primary : .secondary)
                        }
                    }
                    .buttonStyle(.genHoverPlain())
                    .accessibilityLabel("\(title): \(option.title)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("\(identifier).\(option.title)")
                }
            }
        }
        .usageSketchRowB()
    }
}

/// AI usage → Usage charts, option B: each switch shows what it draws, each choice is a set of pictures.
@MainActor
struct UsageSettingsSketchChartsB: View {
    @ObservedObject var preferences: UsagePreferences

    var body: some View {
        VStack(alignment: .leading, spacing: 26) {
            UsageSettingsSketchSectionB("Limits table", subtitle: "One row per account, one column per window.") {
                toggle(.hideColumns, "Hide empty columns", "Leave out a window column that no account has a reading for.",
                       "usage.hideEmptyColumns", \.hideEmptyColumns)
            }
            UsageSettingsSketchSectionB("Burn lanes", subtitle: "One lane per window of each account, on one time axis.") {
                UsageSettingsSketchChoiceB(
                    title: "Range", identifier: "usage.range",
                    options: UsageRange.allCases.map { NativeSettingsOption($0, $0.title, detail: "The lanes reach back \($0.title) when the Usage mode opens.") },
                    selection: preferences.binding(\.range), minSegmentWidth: 52)
                UsageSettingsSketchRuleB()
                UsageSketchPictureChoiceB(
                    title: "Resolution", detail: "Auto: every reading up to 48 h, min-max bins above, so a short peak stays visible.",
                    identifier: "usage.resolution",
                    options: [(UsageResolution.auto, "Auto", .auto), (.raw, "Raw", .raw), (.oneMinute, "1 min", .bins), (.fiveMinutes, "5 min", .bins)],
                    selection: preferences.binding(\.resolution))
                UsageSettingsSketchRuleB()
                UsageSketchPictureChoiceB(
                    title: "Line shape", detail: "Step holds a value until the next reading, as the store records it.",
                    identifier: "usage.lineShape",
                    options: [(UsageLineShape.step, "Step", .step), (.linear, "Linear", .linear)],
                    selection: preferences.binding(\.lineShape))
                UsageSettingsSketchRuleB()
                UsageSketchPictureChoiceB(
                    title: "Window with no limit", detail: "An account without a 5h limit.",
                    identifier: "usage.absentWindow",
                    options: [(UsageAbsentWindow.band, "Band", .band), (.hide, "No lane", .noLane)],
                    selection: preferences.binding(\.absentWindow))
                UsageSettingsSketchRuleB()
                toggle(.scoped, "Scoped windows", "Fable and other scoped windows get lanes of their own.", "usage.scopedWindows", \.scopedWindows)
                UsageSettingsSketchRuleB()
                toggle(.resets, "Reset bands", "Every other window period shaded, a line at each reset.", "usage.resetBands", \.resetBands)
                UsageSettingsSketchRuleB()
                toggle(.severity, "Severity colour", "Green, orange at 75%, red at 90%. Off uses the provider's colour.", "usage.severityColour", \.severityColour)
            }
            UsageSettingsSketchSectionB("Forecast", subtitle: "From the recent burn, to the window's reset.") {
                toggle(.projection, "Projection", "A dashed line from now to the reset at the current rate.", "usage.projection", \.projection)
                UsageSettingsSketchRuleB()
                toggle(.cone, "Cone", "Shade between the slow and the fast pace.", "usage.cone", \.cone)
                UsageSettingsSketchRuleB()
                toggle(.safePace, "Safe pace", "A thin line at the rate that lands at exactly 100% at the reset.", "usage.safePace", \.safePace)
                UsageSettingsSketchRuleB()
                toggle(.digestCone, "Cone in the Today digest", "A small cone beside each account in the hub's Today digest.", "usage.digestCone", \.digestCone)
            }
            UsageSettingsSketchSectionB("Markers", subtitle: "What the lanes mark on top of the line.") {
                toggle(.spikes, "Spikes", "A diamond on each sharp rise. A click lists the sessions that spent then.", "usage.spikeMarkers", \.spikeMarkers)
                UsageSettingsSketchRuleB()
                toggle(.events, "Events", "A tick for each rate limit, cooldown, poll pause, block and refused probe.", "usage.eventMarkers", \.eventMarkers)
                UsageSettingsSketchRuleB()
                toggle(.coverage, "Poll coverage", "A strip under each account: measured, stale, blocked or not measured.", "usage.coverageStrip", \.coverageStrip)
            }
            UsageSettingsSketchSectionB("Spend", subtitle: "Changes apply to a running hub at once.") {
                UsageSettingsSketchChoiceB(
                    title: "Stack by", identifier: "usage.spendStack",
                    options: UsageSpendStack.allCases.map { NativeSettingsOption($0, $0.title, detail: "The Spend tab's bars are split by \($0.title.lowercased()) when it opens.") },
                    selection: preferences.binding(\.spendStack), minSegmentWidth: 60)
            }
        }
    }

    private func toggle(_ glyph: UsageSketchGlyphB, _ title: String, _ detail: String, _ identifier: String,
                        _ path: WritableKeyPath<UsageSettings, Bool>) -> some View {
        HStack(spacing: 14) {
            UsageSketchGlyphViewB(glyph: glyph, on: preferences.settings[keyPath: path])
            NativeSettingsToggle(title, detail: detail, identifier: identifier, isOn: preferences.binding(path))
        }
        .usageSketchRowB()
    }
}
