// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowView.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import SwiftUI

/// Flow's main surface: dictation history, insights, dictionary, snippets,
/// transforms and a scratchpad.
///
/// Layout follows the Wispr Flow reference (left section rail, history centre,
/// stats rail right) but on the Genesis dark palette — the reference is a light
/// theme and this app is dark-only.
public struct FlowView: View {
    public init(session: FlowSession, initialSection: FlowSection = .dictation) {
        self.session = session
        _section = State(initialValue: initialSection)
    }

    @ObservedObject public var session: FlowSession
    @State private var section: FlowSection = .dictation
    @State private var search = ""

    public enum FlowSection: String, CaseIterable, Identifiable {
        case dictation, insights, dictionary, snippets, transforms, scratchpad, settings
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .dictation: return "Dictation"
            case .insights: return "Insights"
            case .dictionary: return "Dictionary"
            case .snippets: return "Snippets"
            case .transforms: return "Transforms"
            case .scratchpad: return "Scratchpad"
            case .settings: return "Settings"
            }
        }

        public var icon: String {
            switch self {
            case .dictation: return "mic"
            case .insights: return "chart.bar"
            case .dictionary: return "character.book.closed"
            case .snippets: return "scissors"
            case .transforms: return "wand.and.stars"
            case .scratchpad: return "note.text"
            case .settings: return "slider.horizontal.3"
            }
        }
    }

    public var body: some View {
        HStack(spacing: 0) {
            sectionRail
            Divider().overlay(Color.genGlassBorder)
            content
        }
        .background(Color.settingsBackground)
        // NOTE: no `.accessibilityIdentifier` on this container. Setting one
        // here propagates to every descendant and clobbers their own ids —
        // the whole subtree came back as "flow-view" and the section rail
        // became unaddressable. Keep identifiers on leaves to avoid propagation.
        // AccessibilityIdentifierPropagationClobbersChildren.md. The marker
        // lives on a leaf instead.
    }

    // MARK: - Rail

    private var sectionRail: some View {
        VStack(alignment: .leading, spacing: GenSpacing.xxs) {
            HStack(spacing: GenSpacing.sm) {
                // The sidebar's Dictation glyph; "waveform" is the Voice Agent's.
                // Named "Dictation", not "Flow": Flow is also the pomodoro phase.
                Image(systemName: "mic")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.jarvisTeal)
                Text("Dictation")
                    .font(GenTypography.headline(15))
                    .foregroundStyle(Color.genTextPrimary)
                    // Leaf marker: proves the surface rendered without
                    // swallowing the ids of everything below it.
                    .accessibilityIdentifier("flow-view")
            }
            .padding(.horizontal, GenSpacing.md)
            .padding(.top, GenSpacing.lg)
            .padding(.bottom, GenSpacing.md)

            VStack(alignment: .leading, spacing: 2) {
                ForEach(FlowSection.allCases) { item in
                    SidebarNavItem(
                        icon: item.icon,
                        title: item.title,
                        isSelected: section == item,
                        accent: .jarvisTeal
                    ) { section = item }
                    .accessibilityIdentifier("flow-nav-\(item.rawValue)")
                }
            }
            // Same inset as the Settings and DevTools rails; without it the
            // selected row ran edge to edge into the column divider.
            .padding(.horizontal, 8)

            Spacer()

            hotkeyHint
                .padding(.horizontal, GenSpacing.md)
                .padding(.bottom, GenSpacing.lg)
        }
        .frame(width: 188)
        .background(Color.settingsSidebar)
    }

    private var hotkeyHint: some View {
        VStack(alignment: .leading, spacing: GenSpacing.xs) {
            Text("HOLD TO DICTATE")
                .font(GenTypography.caption(9, weight: .bold))
                .foregroundStyle(Color.settingsTextMuted)
            Text(FlowKeyNames.describe(keyCode: session.config.keyCode, modifiers: session.config.modifiers))
                .font(GenTypography.mono(12))
                .foregroundStyle(Color.jarvisTeal)
            switch session.hotkeyStatus {
            case .registered:
                EmptyView()
            case .unavailable:
                Text("Shortcut unavailable. Use the menu bar: Start dictation.")
                    .font(GenTypography.caption(10))
                    .foregroundStyle(Color.genWarning)
                    .fixedSize(horizontal: false, vertical: true)
            case .off:
                Text(FlowSession.offReason(labEnabled: session.labEnabled, enabled: session.config.enabled) ?? "Dictation is off.")
                    .font(GenTypography.caption(10))
                    .foregroundStyle(Color.settingsTextMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !session.accessibilityTrusted {
                Button {
                    session.requestAccessibility()
                } label: {
                    Text("Grant Accessibility")
                        .font(GenTypography.caption(10, weight: .semibold))
                }
                .buttonStyle(.genHoverPlain())
                .foregroundStyle(Color.genWarning)
                .padding(.top, GenSpacing.xxs)
                .instantTooltip("Without Accessibility, Flow copies the text but cannot paste it for you.")
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch section {
        case .dictation: FlowHistoryPane(session: session, search: $search)
        case .insights: FlowInsightsPane(session: session)
        case .dictionary: FlowDictionaryPane(session: session)
        case .snippets: FlowSnippetsPane(session: session)
        case .transforms: FlowTransformsPane(session: session)
        case .scratchpad: FlowScratchpadPane(session: session)
        case .settings: FlowSettingsPane(session: session)
        }
    }
}

// MARK: - Settings

private struct FlowSettingsPane: View {
    @ObservedObject var session: FlowSession

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: GenSpacing.xl) {
                Text("Settings")
                    .font(GenTypography.headline(20))
                    .foregroundStyle(Color.genTextPrimary)

                group("ACCESS") {
                    Text("Microphone and Speech Recognition access is requested only when you press Review, by the app handling dictation.")
                        .font(GenTypography.body(12))
                        .foregroundStyle(Color.settingsTextSecondary)
                    Button(session.isRequestingPermissions ? "Waiting for macOS…" : "Review dictation access") {
                        session.requestDictationPermissions()
                    }
                    .buttonStyle(.bordered)
                    .disabled(session.isRequestingPermissions)
                    .accessibilityIdentifier("flow-review-permissions")
                    HStack(spacing: GenSpacing.md) {
                        Button("Microphone settings") { openPrivacy("Privacy_Microphone") }
                        Button("Speech Recognition settings") { openPrivacy("Privacy_SpeechRecognition") }
                    }
                    .buttonStyle(.genHoverPlain())
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.jarvisTeal)
                }

                group("CAPTURE") {
                    toggle(
                        "Enabled",
                        subtitle: "Register the dictation hotkey.",
                        value: binding(\.enabled)
                    )
                    picker(
                        "Activation",
                        selection: Binding(
                            get: { session.config.activation },
                            set: { session.config.activation = $0 }
                        )
                    )
                    toggle(
                        "Capture before the key",
                        subtitle: "Keeps a \(Int(FlowPreRoll.windowSeconds * 1000)) ms rolling window so the words you say as you press are not lost. Holds the microphone open — macOS shows the orange indicator while it runs. Nothing is recorded or sent.",
                        value: binding(\.preRoll)
                    )
                    toggle(
                        "Show the pill",
                        subtitle: "Floating indicator while dictating.",
                        value: binding(\.showPill)
                    )
                }

                group("OUTPUT") {
                    toggle(
                        "Paste automatically",
                        subtitle: "Needs Accessibility. Without it, Flow copies and tells you.",
                        value: binding(\.injectViaPaste)
                    )
                    toggle(
                        "Put the clipboard back afterwards",
                        subtitle: "Off by default on purpose: restoring re-exposes whatever was there — often a password or a 2FA code — to any app that reads the clipboard on a delay.",
                        value: binding(\.restoreClipboard)
                    )
                }

                group("TEXT") {
                    toggle(
                        "Learn dictionary entries",
                        subtitle: "Suggest replacements for terms Flow keeps hearing.",
                        value: binding(\.dictionaryLearning)
                    )
                    toggle(
                        "Use Apple's server recognition",
                        subtitle: "Off keeps transcription on this machine.",
                        value: binding(\.forceServerRecognition)
                    )
                }

                if !session.accessibilityTrusted {
                    Button("Grant Accessibility") {
                        session.requestAccessibility()
                    }
                    .buttonStyle(.genHoverPlain())
                    .font(GenTypography.caption(12, weight: .semibold))
                    .foregroundStyle(Color.genWarning)
                    .instantTooltip("Without Accessibility, Flow copies the text but cannot paste it for you.")
                }
            }
            .padding(GenSpacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func openPrivacy(_ pane: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
        NSWorkspace.shared.open(url)
    }

    /// Writes go through `FlowSession.config`, whose `didSet` persists once per
    /// change — never per keystroke, and never from a binding on a continuously
    /// changing value.
    private func binding(_ path: WritableKeyPath<FlowConfig, Bool>) -> Binding<Bool> {
        Binding(
            get: { session.config[keyPath: path] },
            set: { session.config[keyPath: path] = $0 }
        )
    }

    @ViewBuilder
    private func group(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: GenSpacing.md) {
            Text(title)
                .font(GenTypography.caption(10, weight: .bold))
                .foregroundStyle(Color.settingsTextMuted)
            content()
        }
    }

    private func toggle(_ title: String, subtitle: String, value: Binding<Bool>) -> some View {
        HStack(alignment: .top, spacing: GenSpacing.md) {
            VStack(alignment: .leading, spacing: GenSpacing.xxs) {
                Text(title)
                    .font(GenTypography.body(13))
                    .foregroundStyle(Color.genTextPrimary)
                Text(subtitle)
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.settingsTextMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: GenSpacing.lg)
            // The title is the switch's accessible name; the visible label is the Text above, so it stays hidden.
            Toggle(title, isOn: value)
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(Color.jarvisTeal)
                .accessibilityHint(subtitle)
        }
        .padding(GenSpacing.md)
        .background(Color.settingsCard)
        .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm))
        .accessibilityIdentifier("flow-setting-\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
    }

    private func picker(_ title: String, selection: Binding<FlowActivation>) -> some View {
        HStack {
            Text(title)
                .font(GenTypography.body(13))
                .foregroundStyle(Color.genTextPrimary)
            Spacer()
            Picker(title, selection: selection) {
                ForEach(FlowActivation.allCases, id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 210)
            .instantTooltip("Push to talk: hold the key. Toggle: tap to start and stop")
        }
        .padding(GenSpacing.md)
        .background(Color.settingsCard)
        .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm))
    }
}

// MARK: - History

/// The Dictation page title and its search field. Side by side when both fit,
/// else the search drops below the title: in a 720 pt window, with both rails,
/// the title got about 50 pt beside the fixed-width search and wrapped letter
/// by letter ("Dict / atio / n").
public struct FlowHistoryHeader: View {
    @Binding public var search: String

    public var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: GenSpacing.md) {
                title
                Spacer(minLength: GenSpacing.md)
                searchField(fieldWidth: 160)
            }
            VStack(alignment: .leading, spacing: GenSpacing.sm) {
                title
                searchField(fieldWidth: nil)
            }
        }
        .padding(.horizontal, GenSpacing.xl)
        .padding(.top, GenSpacing.xl)
    }

    private var title: some View {
        Text("Dictation")
            .font(GenTypography.headline(20))
            .foregroundStyle(Color.genTextPrimary)
            .lineLimit(1)
            .fixedSize()
    }

    /// `fieldWidth: nil` fills the row (the stacked layout).
    private func searchField(fieldWidth: CGFloat?) -> some View {
        HStack(spacing: GenSpacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(Color.settingsTextMuted)
            TextField("Search", text: $search)
                .textFieldStyle(.plain)
                .font(GenTypography.body(12))
                .frame(width: fieldWidth)
                .frame(maxWidth: fieldWidth == nil ? .infinity : nil)
        }
        .padding(.horizontal, GenSpacing.sm)
        .padding(.vertical, GenSpacing.xs)
        .background(Capsule().fill(Color.settingsCard))
        .overlay(Capsule().stroke(Color.settingsBorder, lineWidth: 1))
        .accessibilityIdentifier("flow-history-search")
    }
}

private struct FlowHistoryPane: View {
    @ObservedObject var session: FlowSession
    @Binding var search: String

    /// Filtering happens here, once per change, and NOT inside the ForEach —
    /// an inline filter re-runs on every invalidation of the enclosing body.
    private var groups: [(day: Date, entries: [FlowEntry])] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtered = needle.isEmpty
            ? session.history
            : session.history.filter { $0.text.lowercased().contains(needle) }
        let calendar = Calendar.current
        let buckets = Dictionary(grouping: filtered) { calendar.startOfDay(for: $0.createdAt) }
        return buckets.keys.sorted(by: >).map { ($0, buckets[$0] ?? []) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if session.history.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: GenSpacing.lg, pinnedViews: [.sectionHeaders]) {
                        ForEach(groups, id: \.day) { group in
                            Section {
                                VStack(spacing: 1) {
                                    ForEach(group.entries) { entry in
                                        FlowEntryRow(entry: entry, session: session)
                                    }
                                }
                                .background(Color.settingsCard)
                                .clipShape(RoundedRectangle(cornerRadius: GenRadius.md))
                            } header: {
                                Text(Self.dayLabel(group.day))
                                    .font(GenTypography.caption(10, weight: .bold))
                                    .foregroundStyle(Color.settingsTextMuted)
                                    .padding(.vertical, GenSpacing.xs)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.settingsBackground)
                            }
                        }
                    }
                    .padding(GenSpacing.xl)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        FlowHistoryHeader(search: $search)
    }

    private var emptyState: some View {
        VStack(spacing: GenSpacing.md) {
            Image(systemName: "waveform")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Color.jarvisTeal.opacity(0.6))
            Text("Nothing dictated yet")
                .font(GenTypography.headline(15))
                .foregroundStyle(Color.genTextSecondary)
            Text("Hold \(FlowKeyNames.describe(keyCode: session.config.keyCode, modifiers: session.config.modifiers)) anywhere and speak. The text lands in whatever app you were typing in.")
                .font(GenTypography.body(12))
                .foregroundStyle(Color.settingsTextMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 340)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMMM d, yyyy"
        return f
    }()

    static func dayLabel(_ day: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "TODAY" }
        if calendar.isDateInYesterday(day) { return "YESTERDAY" }
        return dayFormatter.string(from: day).uppercased()
    }
}

private struct FlowEntryRow: View {
    let entry: FlowEntry
    @ObservedObject var session: FlowSession
    @State private var hovered = false
    /// Show what the recogniser actually heard, before dictionary/snippets.
    ///
    /// Rewriting speech is only tolerable if it stays auditable — the loudest
    /// Wispr Flow complaint is a user watching it silently "fix" their grammar
    /// into something they did not say. The raw transcript is kept forever and
    /// is one click away.
    @State private var showingRaw = false

    private var wasRewritten: Bool { entry.rawText != entry.text }

    /// Built once per row, not per body evaluation — `DateFormatter` creation
    /// in a body is a documented hot-path mistake.
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f
    }()

    var body: some View {
        HStack(alignment: .top, spacing: GenSpacing.md) {
            Text(Self.timeFormatter.string(from: entry.createdAt))
                .font(GenTypography.mono(11))
                .foregroundStyle(Color.settingsTextMuted)
                .frame(width: 62, alignment: .leading)

            VStack(alignment: .leading, spacing: GenSpacing.xxs) {
                Text(showingRaw ? entry.rawText : entry.text)
                    .font(GenTypography.body(13))
                    .foregroundStyle(showingRaw ? Color.genTextSecondary : Color.genTextPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)

                if wasRewritten {
                    Button {
                        showingRaw.toggle()
                    } label: {
                        HStack(spacing: GenSpacing.xxs) {
                            Image(systemName: showingRaw ? "arrow.uturn.forward" : "arrow.uturn.backward")
                                .font(.system(size: 8))
                            Text(showingRaw ? "show edited" : "show what I said")
                                .font(GenTypography.caption(10))
                        }
                    }
                    .buttonStyle(.genHoverPlain())
                    .foregroundStyle(Color.jarvisTeal)
                    .accessibilityIdentifier("flow-entry-toggle-raw")
                }

                if let app = entry.targetAppName {
                    HStack(spacing: GenSpacing.xs) {
                        Image(systemName: entry.injected ? "arrow.turn.down.right" : "doc.on.clipboard")
                            .font(.system(size: 8))
                        Text(entry.injected ? app : "\(app) · copied only")
                            .font(GenTypography.caption(10))
                    }
                    .foregroundStyle(Color.settingsTextMuted)
                }
            }

            Spacer(minLength: GenSpacing.sm)

            // Always laid out, shown on hover. Inserting the buttons on hover
            // narrowed the text column, so the transcript rewrapped and the
            // row jumped under the pointer.
            HStack(spacing: GenSpacing.xs) {
                Button { session.copyEntry(entry) } label: {
                    Image(systemName: "doc.on.doc")
                }
                .instantTooltip("Copy")
                Button { session.deleteEntry(entry.id) } label: {
                    Image(systemName: "trash")
                }
                .instantTooltip("Delete")
            }
            .buttonStyle(.genHoverPlain())
            .font(.system(size: 11))
            .foregroundStyle(Color.settingsTextSecondary)
            .opacity(hovered ? 1 : 0)
            .allowsHitTesting(hovered)
            // The pointer-only buttons stay out of the tree; the row carries the same two actions for VoiceOver
            // and keyboard users, who never hover.
            .accessibilityHidden(true)
        }
        .padding(.horizontal, GenSpacing.md)
        .padding(.vertical, GenSpacing.sm)
        .background(hovered ? Color.settingsCardHover : Color.settingsCard)
        .onHover { hovered = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Copy") { session.copyEntry(entry) }
        .accessibilityAction(named: "Delete") { session.deleteEntry(entry.id) }
    }
}

// MARK: - Insights

private struct FlowInsightsPane: View {
    @ObservedObject var session: FlowSession

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: GenSpacing.xl) {
                Text("Insights")
                    .font(GenTypography.headline(20))
                    .foregroundStyle(Color.genTextPrimary)

                HStack(spacing: GenSpacing.md) {
                    statCard(
                        value: Self.compact(session.stats.totalWords),
                        label: session.stats.totalWords == 1 ? "total word" : "total words")
                    statCard(value: String(Int(session.stats.averageWpm.rounded())), label: "wpm")
                    statCard(value: String(session.stats.dayStreak), label: "day streak")
                }

                statCard(
                    value: Self.duration(session.stats.totalSeconds),
                    label: "spent dictating",
                    wide: true
                )

                if !session.suggestions.isEmpty {
                    Text("DICTIONARY SUGGESTIONS")
                        .font(GenTypography.caption(10, weight: .bold))
                        .foregroundStyle(Color.settingsTextMuted)
                    Text("Words Flow keeps hearing that are not in your dictionary. Accept to fix the spelling everywhere.")
                        .font(GenTypography.body(12))
                        .foregroundStyle(Color.settingsTextSecondary)
                    ForEach(session.suggestions) { suggestion in
                        FlowSuggestionRow(suggestion: suggestion, session: session)
                    }
                }
            }
            .padding(GenSpacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func statCard(value: String, label: String, wide: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: GenSpacing.xxs) {
            Text(value)
                .font(GenTypography.display(30, weight: .semibold))
                .foregroundStyle(Color.genTextPrimary)
            Text(label)
                .font(GenTypography.caption(11))
                .foregroundStyle(Color.settingsTextMuted)
        }
        .padding(GenSpacing.lg)
        .frame(maxWidth: wide ? .infinity : nil, alignment: .leading)
        .background(Color.settingsCard)
        .clipShape(RoundedRectangle(cornerRadius: GenRadius.md))
        .overlay(RoundedRectangle(cornerRadius: GenRadius.md).stroke(Color.settingsBorder, lineWidth: 1))
    }

    static func compact(_ n: Int) -> String {
        n >= 1000 ? String(format: "%.1fK", Double(n) / 1000) : String(n)
    }

    static func duration(_ seconds: Double) -> String {
        let total = Int(seconds)
        let h = total / 3600, m = (total % 3600) / 60
        return h > 0 ? "\(h)h \(m)m" : "\(m)m"
    }
}

private struct FlowSuggestionRow: View {
    let suggestion: FlowSuggestion
    @ObservedObject var session: FlowSession
    @State private var replacement: String = ""

    var body: some View {
        HStack(spacing: GenSpacing.md) {
            Text(suggestion.heard)
                .font(GenTypography.mono(12))
                .foregroundStyle(Color.genTextPrimary)
            Image(systemName: "arrow.right")
                .font(.system(size: 9))
                .foregroundStyle(Color.settingsTextMuted)
            TextField(suggestion.suggested, text: $replacement)
                .textFieldStyle(.plain)
                .font(GenTypography.mono(12))
                .frame(width: 150)
                .padding(.horizontal, GenSpacing.sm)
                .padding(.vertical, GenSpacing.xs)
                .background(Color.settingsBackground)
                .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm))

            Text("heard \(suggestion.occurrences)×")
                .font(GenTypography.caption(10))
                .foregroundStyle(Color.settingsTextMuted)

            Spacer()

            Button("Add") {
                let value = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
                session.acceptSuggestion(suggestion, replacement: value.isEmpty ? suggestion.suggested : value)
            }
            .buttonStyle(.genHoverPlain())
            .font(GenTypography.caption(11, weight: .semibold))
            .foregroundStyle(Color.jarvisTeal)
            .instantTooltip("Add this replacement to the dictionary")

            Button("Dismiss") { session.dismissSuggestion(suggestion) }
                .buttonStyle(.genHoverPlain())
                .font(GenTypography.caption(11))
                .foregroundStyle(Color.settingsTextMuted)
                .instantTooltip("Stop suggesting this word")
        }
        .padding(GenSpacing.md)
        .background(Color.settingsCard)
        .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm))
    }
}

// MARK: - Dictionary

private struct FlowDictionaryPane: View {
    @ObservedObject var session: FlowSession
    @State private var from = ""
    @State private var to = ""

    var body: some View {
        VStack(alignment: .leading, spacing: GenSpacing.lg) {
            Text("Dictionary")
                .font(GenTypography.headline(20))
                .foregroundStyle(Color.genTextPrimary)
            Text("Replacements applied to every transcript, before the text is pasted.")
                .font(GenTypography.body(12))
                .foregroundStyle(Color.settingsTextSecondary)

            HStack(spacing: GenSpacing.sm) {
                field("heard", text: $from)
                Image(systemName: "arrow.right")
                    .font(.system(size: 10))
                    .foregroundStyle(Color.settingsTextMuted)
                field("written", text: $to)
                Button("Add") {
                    let f = from.trimmingCharacters(in: .whitespacesAndNewlines)
                    let t = to.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !f.isEmpty, !t.isEmpty else { return }
                    session.addRule(from: f, to: t)
                    from = ""; to = ""
                }
                .buttonStyle(.genHoverPlain())
                .font(GenTypography.caption(12, weight: .semibold))
                .foregroundStyle(Color.jarvisTeal)
                .instantTooltip("Add this replacement to the dictionary")
                .accessibilityIdentifier("flow-dictionary-add")
            }

            ScrollView {
                LazyVStack(spacing: 1) {
                    ForEach(session.dictionary) { rule in
                        HStack(spacing: GenSpacing.md) {
                            Text(rule.from)
                                .font(GenTypography.mono(12))
                                .foregroundStyle(Color.genTextSecondary)
                            Image(systemName: "arrow.right")
                                .font(.system(size: 9))
                                .foregroundStyle(Color.settingsTextMuted)
                            Text(rule.to)
                                .font(GenTypography.mono(12))
                                .foregroundStyle(Color.genTextPrimary)
                            if rule.learned {
                                Text("learned")
                                    .font(GenTypography.caption(9, weight: .semibold))
                                    .foregroundStyle(Color.jarvisTeal)
                                    .padding(.horizontal, GenSpacing.xs)
                                    .padding(.vertical, 1)
                                    .background(Capsule().fill(Color.jarvisTeal.opacity(0.14)))
                                    .instantTooltip("Added from a dictionary suggestion")
                            }
                            Spacer()
                            Button { session.removeRule(rule.id) } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.genHoverPlain())
                            .font(.system(size: 11))
                            .foregroundStyle(Color.settingsTextMuted)
                            .instantTooltip("Remove this replacement")
                        }
                        .padding(.horizontal, GenSpacing.md)
                        .padding(.vertical, GenSpacing.sm)
                        .background(Color.settingsCard)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: GenRadius.md))
            }
        }
        .padding(GenSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(GenTypography.mono(12))
            .frame(width: 170)
            .padding(.horizontal, GenSpacing.sm)
            .padding(.vertical, GenSpacing.xs)
            .background(Color.settingsCard)
            .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm))
            .overlay(RoundedRectangle(cornerRadius: GenRadius.sm).stroke(Color.settingsBorder, lineWidth: 1))
    }
}

// MARK: - Snippets

private struct FlowSnippetsPane: View {
    @ObservedObject var session: FlowSession
    @State private var trigger = ""
    @State private var body_ = ""

    var body: some View {
        VStack(alignment: .leading, spacing: GenSpacing.lg) {
            Text("Snippets")
                .font(GenTypography.headline(20))
                .foregroundStyle(Color.genTextPrimary)
            Text("Say the trigger, get the whole phrase. Expanded after dictionary replacements.")
                .font(GenTypography.body(12))
                .foregroundStyle(Color.settingsTextSecondary)

            HStack(alignment: .top, spacing: GenSpacing.sm) {
                TextField("trigger", text: $trigger)
                    .textFieldStyle(.plain)
                    .font(GenTypography.mono(12))
                    .frame(width: 150)
                    .padding(GenSpacing.sm)
                    .background(Color.settingsCard)
                    .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm))
                TextEditor(text: $body_)
                    .font(GenTypography.body(12))
                    .scrollContentBackground(.hidden)
                    .frame(height: 62)
                    .padding(GenSpacing.xs)
                    // TextEditor has no placeholder; an empty box beside
                    // "trigger" did not say what goes in it.
                    .overlay(alignment: .topLeading) {
                        if body_.isEmpty {
                            Text("expands to…")
                                .font(GenTypography.body(12))
                                .foregroundStyle(Color.settingsTextMuted)
                                .padding(.horizontal, GenSpacing.xs + 5)
                                .padding(.vertical, GenSpacing.xs)
                                .allowsHitTesting(false)
                        }
                    }
                    .background(Color.settingsCard)
                    .clipShape(RoundedRectangle(cornerRadius: GenRadius.sm))
                Button("Add") {
                    let t = trigger.trimmingCharacters(in: .whitespacesAndNewlines)
                    let b = body_.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty, !b.isEmpty else { return }
                    session.addSnippet(trigger: t, body: b)
                    trigger = ""; body_ = ""
                }
                .buttonStyle(.genHoverPlain())
                .font(GenTypography.caption(12, weight: .semibold))
                .foregroundStyle(Color.jarvisTeal)
                .instantTooltip("Add this snippet")
            }

            ScrollView {
                LazyVStack(spacing: 1) {
                    ForEach(session.snippets) { snippet in
                        HStack(alignment: .top, spacing: GenSpacing.md) {
                            Text(snippet.trigger)
                                .font(GenTypography.mono(12))
                                .foregroundStyle(Color.jarvisTeal)
                                .frame(width: 140, alignment: .leading)
                            Text(snippet.body)
                                .font(GenTypography.body(12))
                                .foregroundStyle(Color.genTextSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer()
                            Button { session.removeSnippet(snippet.id) } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.genHoverPlain())
                            .font(.system(size: 11))
                            .foregroundStyle(Color.settingsTextMuted)
                            .instantTooltip("Remove this snippet")
                        }
                        .padding(GenSpacing.md)
                        .background(Color.settingsCard)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: GenRadius.md))
            }
        }
        .padding(GenSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Transforms

private struct FlowTransformsPane: View {
    @ObservedObject var session: FlowSession
    @State private var running: UUID?
    @State private var result: String?
    @State private var failure: String?

    /// What a transform runs on: the most recent dictation.
    private var subject: FlowEntry? { session.history.first }

    var body: some View {
        VStack(alignment: .leading, spacing: GenSpacing.lg) {
            Text("Transforms")
                .font(GenTypography.headline(20))
                .foregroundStyle(Color.genTextPrimary)
            Text("Rewrites you can apply to a transcript after dictating. Opt-in per turn — Flow never rewrites silently, so what you said is always what landed.")
                .font(GenTypography.body(12))
                .foregroundStyle(Color.settingsTextSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if let subject {
                Text("Last dictation: \(subject.text.prefix(90))\(subject.text.count > 90 ? "…" : "")")
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.settingsTextMuted)
                    .lineLimit(2)
            } else {
                Text("Dictate something first — transforms run on your most recent transcript.")
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.settingsTextMuted)
            }

            if let failure {
                Text(failure)
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.genError)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let result {
                VStack(alignment: .leading, spacing: GenSpacing.sm) {
                    Text("RESULT")
                        .font(GenTypography.caption(9, weight: .bold))
                        .foregroundStyle(Color.settingsTextMuted)
                    Text(result)
                        .font(GenTypography.body(13))
                        .foregroundStyle(Color.genTextPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: GenSpacing.md) {
                        Button("Copy") {
                            let pb = NSPasteboard.general
                            pb.clearContents()
                            pb.setString(result, forType: .string)
                        }
                        .instantTooltip("Copy the result to the clipboard")
                        Button("Dismiss") { self.result = nil }
                            .instantTooltip("Hide the result; the transcript stays unchanged")
                    }
                    .buttonStyle(.genHoverPlain())
                    .font(GenTypography.caption(11, weight: .semibold))
                    .foregroundStyle(Color.jarvisTeal)
                }
                .padding(GenSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.settingsCard)
                .clipShape(RoundedRectangle(cornerRadius: GenRadius.md))
                .overlay(RoundedRectangle(cornerRadius: GenRadius.md).stroke(Color.jarvisTeal.opacity(0.3), lineWidth: 1))
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: GenSpacing.sm) {
                    ForEach(session.transforms) { transform in
                        VStack(alignment: .leading, spacing: GenSpacing.xs) {
                            HStack {
                                Text(transform.name)
                                    .font(GenTypography.headline(13))
                                    .foregroundStyle(Color.genTextPrimary)
                                if transform.isDefault {
                                    Text("default")
                                        .font(GenTypography.caption(9, weight: .semibold))
                                        .foregroundStyle(Color.jarvisTeal)
                                        .padding(.horizontal, GenSpacing.xs)
                                        .padding(.vertical, 1)
                                        .background(Capsule().fill(Color.jarvisTeal.opacity(0.14)))
                                        .instantTooltip("Built-in transform")
                                }
                                Spacer()
                                if running == transform.id {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Button("Run on last") { apply(transform) }
                                        .buttonStyle(.genHoverPlain())
                                        .font(GenTypography.caption(11, weight: .semibold))
                                        .foregroundStyle(subject == nil ? Color.settingsTextMuted : Color.jarvisTeal)
                                        .disabled(subject == nil || running != nil)
                                        .instantTooltip("Run this transform on the most recent dictation")
                                        .accessibilityIdentifier("flow-transform-run")
                                }
                            }
                            Text(transform.prompt)
                                .font(GenTypography.body(11))
                                .foregroundStyle(Color.settingsTextSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(GenSpacing.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.settingsCard)
                        .clipShape(RoundedRectangle(cornerRadius: GenRadius.md))
                    }
                }
            }
        }
        .padding(GenSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Run a transform on the last transcript. The original is never replaced —
    /// the result is shown beside it and the user decides what to do with it.
    private func apply(_ transform: FlowTransform) {
        guard let subject, running == nil else { return }
        running = transform.id
        failure = nil
        result = nil
        Task { @MainActor in
            defer { running = nil }
            do {
                result = try await FlowTransformRunner.run(transform, on: subject.text)
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

// MARK: - Scratchpad

private struct FlowScratchpadPane: View {
    /// The note lives in this session's store, never `FlowStore.shared`: another runtime replaces that global.
    @ObservedObject var session: FlowSession
    @State private var text = ""
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: GenSpacing.md) {
            Text("Scratchpad")
                .font(GenTypography.headline(20))
                .foregroundStyle(Color.genTextPrimary)
            Text("A place to dictate into when no other app is the target. Saved to ~/.genesis/flow/scratchpad.md.")
                .font(GenTypography.body(12))
                .foregroundStyle(Color.settingsTextSecondary)

            TextEditor(text: $text)
                .font(GenTypography.body(13))
                .scrollContentBackground(.hidden)
                .padding(GenSpacing.md)
                .background(Color.settingsCard)
                .clipShape(RoundedRectangle(cornerRadius: GenRadius.md))
                .accessibilityIdentifier("flow-scratchpad")
        }
        .padding(GenSpacing.xl)
        .task {
            guard !loaded else { return }
            text = session.loadScratchpad()
            loaded = true
        }
        // Persist on disappear, never per keystroke: every save is a disk
        // write, and a TextField-driven write is the documented way to make
        // typing janky in this app.
        .onDisappear { session.saveScratchpad(text) }
    }
}

// MARK: - Key naming

/// Renders a Carbon keycode + modifier mask as something a human reads.
public enum FlowKeyNames {
    public static func describe(keyCode: UInt32, modifiers: UInt32) -> String {
        var parts = ""
        if modifiers & 0x1000 != 0 { parts += "⌃" }   // controlKey
        if modifiers & 0x0800 != 0 { parts += "⌥" }   // optionKey
        if modifiers & 0x0200 != 0 { parts += "⇧" }   // shiftKey
        if modifiers & 0x0100 != 0 { parts += "⌘" }   // cmdKey
        return parts + keyName(keyCode)
    }

    private static let names: [UInt32: String] = [
        0x00: "A", 0x01: "S", 0x02: "D", 0x03: "F", 0x05: "G", 0x04: "H",
        0x26: "J", 0x28: "K", 0x25: "L", 0x0B: "B", 0x0E: "E", 0x22: "I",
        0x1F: "O", 0x23: "P", 0x0C: "Q", 0x0F: "R", 0x11: "T", 0x20: "U",
        0x09: "V", 0x0D: "W", 0x07: "X", 0x10: "Y", 0x06: "Z", 0x08: "C",
        0x2D: "N", 0x2E: "M",
        0x31: "Space", 0x61: "F6", 0x60: "F5", 0x76: "F4", 0x63: "F3",
    ]

    public static func keyName(_ code: UInt32) -> String {
        names[code] ?? "Key \(code)"
    }
}
