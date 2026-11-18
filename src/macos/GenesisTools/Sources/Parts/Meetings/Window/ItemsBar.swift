import SwiftUI

// MARK: - What the Items list shows

/// Answered of total for one question group (X18): a question counts as answered once it is decided either way.
struct QuestionGroupProgress: Equatable {
    var answered = 0
    var total = 0

    /// Every question group of the record. The record's items count the questions the row filter hides too (low
    /// priority, decided and hidden); without the record the rows count.
    static func count(rows: [ReviewRow], items: [MeetingItem]?) -> [String: Self] {
        var result: [String: Self] = [:]
        if let items {
            for item in items where item.kind == "question" {
                let group = item.group ?? "rules"
                result[group, default: .init()].total += 1
                if item.status != "suggested" { result[group, default: .init()].answered += 1 }
            }
        } else {
            for row in rows where row.isQuestion {
                let group = row.group ?? "rules"
                result[group, default: .init()].total += 1
                if !row.isOpen { result[group, default: .init()].answered += 1 }
            }
        }
        return result
    }

    /// "Rules 3/12": a group's title with its progress, the words of its segment.
    static func words(_ title: String, _ progress: Self) -> String { "\(title) \(progress.answered)/\(progress.total)" }
}

/// What the spot checks measured: of the answered spot-check questions, how many changed the guessed speaker. One
/// sentence, so the Items bar and the check's popover say it the same way.
struct SpotCheckRate: Equatable {
    let changed: Int
    let answered: Int

    var percent: Int { answered == 0 ? 0 : Int((100 * Double(changed) / Double(answered)).rounded()) }
    /// "3 of 20 answers changed the speaker (15 %)".
    var sentence: String { "\(changed) of \(Plural.count(answered, "answer")) changed the speaker (\(percent) %)" }

    /// The confirmed spot-check questions; one whose answer differs from the speaker the transcript had changed it.
    static func of(_ items: [MeetingItem]) -> SpotCheckRate? {
        var answered = 0, changed = 0
        for item in items where item.group == "spot-check" && item.status == "confirmed" {
            answered += 1
            if case .string(let original)? = item.evidence?["originalSpeaker"], item.answer != original { changed += 1 }
        }
        return answered == 0 ? nil : SpotCheckRate(changed: changed, answered: answered)
    }
}

/// Everything the Items list and its bar show, computed once when the rows, the items or a list setting change
/// (`ItemsTab`'s `onChange`). No filter, search or sort over the rows runs in a view body: before this, every redraw
/// of the list counted, grouped and filtered all 548 rows of a long meeting and searched the items once per row.
struct ItemsProjection: Equatable {
    struct Input: Equatable {
        var rows: [ReviewRow] = []
        var items: [MeetingItem]? = nil
        var order = MeetingsPreferences.Rows.Order.priority
        var decided = MeetingsPreferences.Rows.Decided.inPlace
        var held: Set<String> = []
        var filter = ItemsFilter.all
        var group = "all"
        var applyAbove = 0.5
    }

    /// A row a question's "It settles" line names: the row in words, and its text for the tooltip.
    struct Reference: Equatable {
        let id: String
        let words: String
        let what: String
    }

    /// False until the first projection: the list draws nothing rather than an empty list for that one frame.
    var ready = false
    var open = 0
    var questions = 0
    var kind = ItemsFilter.all
    /// The question group the list shows: "all" when the chosen group holds no question in this meeting.
    var group = "all"
    var shown: [ReviewRow] = []
    var ids: [String] = []
    var groups: [String: QuestionGroupProgress] = [:]
    /// The record of each repeated-word row, and the dictionary question attached to it.
    var wordItems: [String: MeetingItem] = [:]
    var dictionaries: [String: ReviewRow] = [:]
    /// The questions that ask who speaks: they offer "Somebody else…", "Something else…" and "Two voices…".
    var speakerQuestions: Set<String> = []
    /// Per speaker question, the people whose choice score is a voice cosine (`VoiceScore.people`), so no row searches
    /// the record's items in its body.
    var voicePeople: [String: Set<String>] = [:]
    var references: [String: [Reference]] = [:]
    /// A suggestion waits: "Confirm all…" shows.
    var suggestionsWait = false
    /// The suggestions "Confirm all" takes at the apply line: the count the meeting list shows as "N suggestions at
    /// 50 % or more".
    var atLine = 0
    /// The open rows that are suggestions (`ItemsFilter.isSuggestion`): the Suggestions filter's count, the same as
    /// the meeting list's.
    var suggestions = 0
    /// The open rows that are no question and below the apply line: they show under All.
    var belowLine = 0
    var spotCheck: SpotCheckRate?

    /// The groups the strip offers, in the order of `ItemsTab.questionGroups`: only those with a question.
    var offeredGroups: [(id: String, title: String, progress: QuestionGroupProgress)] {
        ItemsTab.questionGroups.compactMap { group -> (id: String, title: String, progress: QuestionGroupProgress)? in
            guard let progress = groups[group.id], progress.total > 0 else { return nil }
            return (id: group.id, title: group.title, progress: progress)
        }
    }

    /// The group strip shows while two or more groups hold questions and the list shows questions: with one group it
    /// would only repeat the Questions filter.
    var showsGroups: Bool { kind != .suggestions && offeredGroups.count >= 2 }

    @MainActor static func make(_ input: Input) -> ItemsProjection {
        var projection = ItemsProjection()
        projection.ready = true
        let rows = input.rows
        let items = input.items ?? []
        let atLine = Set(MeetingDetailModel.confirmable(items, atOrAbove: input.applyAbove).map(\.id))
        for row in rows where row.isOpen {
            projection.open += 1
            if row.isQuestion {
                projection.questions += 1
            } else if atLine.contains(row.id) {
                projection.suggestions += 1
            } else {
                projection.belowLine += 1
            }
        }
        projection.kind = ItemsFilter.effective(input.filter, questions: projection.questions, suggestions: projection.suggestions)
        projection.groups = QuestionGroupProgress.count(rows: rows, items: input.items)
        let chosen = input.group != "all" && projection.kind != .suggestions && (projection.groups[input.group]?.total ?? 0) > 0
        projection.group = chosen ? input.group : "all"
        let visible = MeetingDetailModel.visibleRows(rows, order: input.order, decided: input.decided, keeping: input.held)
        let grouped = ItemsTab.wordRows(visible.filter { $0.group != "words" } + rows.filter { $0.group == "words" }, items: items)
        let group = projection.group
        projection.shown = projection.kind.rows(grouped, atLine: atLine, applyAbove: input.applyAbove, keeping: input.held).filter { row in
            group == "all" || (row.group ?? (row.isQuestion ? "rules" : nil)) == group
        }
        projection.ids = projection.shown.map(\.id)
        let itemsByID = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let rowsByID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for row in projection.shown {
            let item = itemsByID[row.id]
            if row.group == "words", let item {
                projection.wordItems[row.id] = item
                let dictionary = item.about == "dictionary" ? item.id : item.dictionaryQuestion(in: items)?.id
                if let dictionary, let question = rowsByID[dictionary] { projection.dictionaries[row.id] = question }
            }
            if row.isQuestion, let item, item.about == "speaker" {
                projection.speakerQuestions.insert(row.id)
                let voice = VoiceScore.people(decidedBy: item) { itemsByID[$0] }
                if !voice.isEmpty { projection.voicePeople[row.id] = voice }
            }
            for part in row.parts {
                guard case .settles(_, let ids) = part else { continue }
                projection.references[row.id] = ids.map { id in
                    rowsByID[id].map { Reference(id: id, words: ReviewRowView.reference($0), what: $0.what) }
                        ?? Reference(id: id, words: "Item \(id)", what: "")
                }
            }
        }
        projection.suggestionsWait = items.contains { $0.status == "suggested" && $0.kind != "question" }
        projection.atLine = atLine.count
        projection.spotCheck = SpotCheckRate.of(items)
        return projection
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.ready == rhs.ready && lhs.open == rhs.open && lhs.questions == rhs.questions && lhs.kind == rhs.kind
            && lhs.group == rhs.group && lhs.shown == rhs.shown && lhs.groups == rhs.groups && lhs.wordItems == rhs.wordItems
            && lhs.dictionaries == rhs.dictionaries && lhs.speakerQuestions == rhs.speakerQuestions
            && lhs.voicePeople == rhs.voicePeople && lhs.references == rhs.references && lhs.suggestionsWait == rhs.suggestionsWait && lhs.atLine == rhs.atLine
            && lhs.suggestions == rhs.suggestions && lhs.belowLine == rhs.belowLine && lhs.spotCheck == rhs.spotCheck
    }
}

// MARK: - The bar over the list

/// The one bar over the Items list, pinned under the tabs: what the list shows (the kind filter, or the words when one
/// kind waits), the question groups with their progress when two or more hold questions (X18), and the tab's three
/// actions (add a question or a term, check the speakers by ear, confirm the suggestions at a line). Before, the
/// actions and the group filter were rows of system steppers and push buttons inside the scrolling list, flush with its
/// left edge, and at 900 x 600 they pushed the first question to the bottom of the window.
struct ItemsBar: View {
    @Bindable var detail: MeetingDetailModel
    let projection: ItemsProjection
    @Binding var group: String
    /// The config's apply line (`assign.applyAbove`).
    let applyAbove: Double
    @Environment(\.kitLook) private var look
    /// The bar's width and the filter slot's width, in whole points; nil until their first layout.
    @State private var width: CGFloat?
    @State private var room: CGFloat?
    @State private var groupRoom: CGFloat?

    /// Below this width the actions show their glyphs, with their words as tooltip and label.
    static let compactWidth: CGFloat = 600

    var body: some View {
        let compact = width.map { $0 < Self.compactWidth } ?? false
        // In a compact bar (the actions are glyphs) the question groups are one menu in the first row, not a row of
        // their own: at 900 x 600 the headers above the first question took 250 of 600 pt (w_gae6rjx9). A wider bar
        // keeps the strip: its labelled actions leave the first row no room for the menu.
        let inlineGroups = projection.showsGroups && compact
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                leading
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width.rounded(.down) } action: { room = $0 }
                    .layoutPriority(1)
                if inlineGroups {
                    groupMenu(groupItems)
                }
                HStack(spacing: compact ? 2 : 4) {
                    FindingComposerButton(detail: detail, compact: compact)
                    ListenCheckButton(detail: detail, rate: projection.spotCheck, compact: compact, show: show)
                    if projection.suggestionsWait { confirmAll(compact: compact) }
                    RunRulesButton(detail: detail, compact: compact)
                }
                .fixedSize()
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            if projection.showsGroups, !inlineGroups {
                groupStrip
                    .padding(.horizontal, 14).padding(.bottom, 6)
            }
            if projection.group == "spot-check", let rate = projection.spotCheck {
                Text(verbatim: "Spot check: \(rate.sentence)")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.bottom, 6)
                    .accessibilityIdentifier("meetings.items.spotCheckRate")
            }
            Divider()
        }
        .background(.background)
        .onGeometryChange(for: CGFloat.self) { $0.size.width.rounded(.down) } action: { width = $0 }
    }

    /// The prepared group in the list, when the reader keeps `meetings.listen.showPrepared` on.
    private func show(_ prepared: String) {
        guard MeetingsPreferences.Listen.showPrepared.value() else { return }
        group = prepared
        detail.itemsFilter = .all
    }

    // MARK: Kind

    @ViewBuilder
    private var leading: some View {
        if ItemsFilter.offered(questions: projection.questions, suggestions: projection.suggestions) {
            // Both kinds wait: the counts are the filter. One strip, picked from the room this slot is given (whole
            // points): a `ViewThatFits` of the three built every candidate on each measurement, and the list's insets
            // measure the bar many times per pass (2026-11-11).
            let counts = kindsWidth(counts: true)
            let shape = ItemsFilter.Bar.pick(room: room, counts: counts, titles: kindsWidth(counts: false))
            HStack(spacing: 10) {
                kinds(counts: shape == .counts, fills: shape == .shared)
                    .instantTooltip(kindsTooltip)
                // Where the rest of All went, while the room allows it beside the counts.
                if shape == .counts, projection.belowLine > 0, let room, room - counts >= 120 {
                    Text(verbatim: "\(projection.belowLine) below \(MeetingsWords.confidence(applyAbove) ?? "")")
                        .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                        .accessibilityIdentifier("meetings.items.belowLine")
                }
            }
        } else {
            ViewThatFits(in: .horizontal) {
                words(compact: false)
                words(compact: true)
            }
            .accessibilityAddTraits(.isHeader)
        }
    }

    /// What the counts mean: suggestions are the items at the apply line, the rest show under All.
    private var kindsTooltip: String { ItemsTab.kindsTooltip(suggestions: projection.suggestions, belowLine: projection.belowLine,
                                                             line: MeetingsWords.confidence(applyAbove) ?? "") }

    private func words(compact: Bool) -> some View {
        Text(verbatim: ItemsTab.barWords(open: projection.open, atLine: projection.atLine,
                                         line: MeetingsWords.confidence(applyAbove) ?? "", compact: compact))
            .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
    }

    /// All, Questions, Suggestions: each with the rows that wait, a question in the ask hue.
    private func kinds(counts: Bool, fills: Bool = false) -> some View {
        GenSegmentedTabs("Rows shown", items: kindItems(counts: counts),
                         selection: Binding(get: { projection.kind }, set: { kind in
                             detail.itemsFilter = kind
                             if kind == .suggestions { group = "all" }
                         }),
                         minSegmentWidth: 0, identifier: "meetings.items.filter", fillsWidth: fills, size: .small)
    }

    private func kindItems(counts: Bool) -> [GenSegmentedTabs<ItemsFilter>.Item] {
        [
            .init(.all, "All", count: counts ? projection.open : nil),
            .init(.questions, "Questions", count: counts ? projection.questions : nil, hue: .ask),
            .init(.suggestions, "Suggestions", count: counts ? projection.suggestions : nil, hue: .care),
        ]
    }

    /// The width the strip of `kinds(counts:)` takes at its own size, computed from its titles, not built.
    private func kindsWidth(counts: Bool) -> CGFloat {
        GenSegmentedTabs.naturalWidth(items: kindItems(counts: counts), selection: projection.kind, minSegmentWidth: 0,
                                      size: .small, look: look)
    }

    // MARK: Groups (X18)

    /// The question groups with answered of total. In a column too narrow for the strip, one menu with the same words.
    @ViewBuilder
    private var groupStrip: some View {
        let items = groupItems
        let natural = GenSegmentedTabs.naturalWidth(items: items, selection: projection.group, minSegmentWidth: 0,
                                                    size: .small, look: look)
        Group {
            if groupRoom.map({ natural <= $0 }) ?? true {
                GenSegmentedTabs("Question group", items: items,
                                 selection: Binding(get: { projection.group }, set: choose),
                                 minSegmentWidth: 0, identifier: "meetings.items.group", size: .small)
            } else {
                groupMenu(items)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width.rounded(.down) } action: { groupRoom = $0 }
    }

    /// The question groups as one menu with the same words: in a narrow column, and in the first row of a small window.
    private func groupMenu(_ items: [GenSegmentedTabs<String>.Item]) -> some View {
        MenuButton(items: {
            items.map { item in .action(item.title, checked: item.id == projection.group) { choose(item.id) } }
        }) {
            HStack(spacing: 4) {
                Text(verbatim: items.first { $0.id == projection.group }?.title ?? "All questions")
                    .font(.system(size: 12, weight: .medium))
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
            }
            .fixedSize()
        }
        .instantTooltip("Which question group the list shows, with answered of total")
        .accessibilityIdentifier("meetings.items.group")
    }

    private var groupItems: [GenSegmentedTabs<String>.Item] {
        [.init("all", "All questions")] + projection.offeredGroups.map { group in
            .init(group.id, QuestionGroupProgress.words(group.title, group.progress), hue: .ask)
        }
    }

    private func choose(_ id: String) {
        group = id
        if id != "all", detail.itemsFilter == .suggestions { detail.itemsFilter = .all }
    }

    // MARK: Confirm all

    private func confirmAll(compact: Bool) -> some View {
        MenuButton(items: { menu() }) {
            // Its own width always: beside the filter it was squeezed to one letter per line.
            ItemsBarLabel(title: "Confirm all…", symbol: "checkmark.circle", compact: compact)
        }
        .disabled(detail.isBusy("confirm.all"))
        .instantTooltip("Confirm every suggestion at or above a confidence, with one Undo")
        .accessibilityLabel("Confirm all")
        .accessibilityIdentifier("meetings.items.confirmAll")
    }

    private func menu() -> [MenuButtonItem] {
        let items = detail.record.value?.items ?? []
        let pct = { (value: Double) in MeetingsWords.confidence(value) ?? "" }
        var lines = [0.9, 0.8]
        if !lines.contains(applyAbove), applyAbove > 0 { lines.append(applyAbove) }
        var menu: [MenuButtonItem] = [.note("Confirm every suggestion at or above")]
        for line in lines.sorted(by: >) {
            let count = MeetingDetailModel.confirmable(items, atOrAbove: line).count
            let mark = line == applyAbove ? " (the apply line)" : ""
            menu.append(.action("\(pct(line))\(mark): \(Plural.count(count, "suggestion"))", enabled: count > 0) {
                detail.confirmAll(atOrAbove: line)
            })
        }
        let every = MeetingDetailModel.confirmable(items, atOrAbove: 0).count
        menu.append(.action("Any confidence: \(Plural.count(every, "suggestion"))", enabled: every > 0) { detail.confirmAll(atOrAbove: 0) })
        menu.append(.divider)
        menu.append(.note("Questions, ranges with no speaker and terms with no spelling stay for you."))
        return menu
    }
}

/// The look of the bar's three actions: a glyph and its words, or the glyph alone in a narrow column. Drawn inside a
/// `Button` or a `MenuButton` with the hover plate of `.genHoverPlain()`, so all three answer the pointer the same way.
struct ItemsBarLabel: View {
    let title: String
    let symbol: String
    let compact: Bool

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(.secondary)
            if !compact { Text(verbatim: title).font(.system(size: 12)) }
        }
        .fixedSize()
        .frame(minWidth: 22, minHeight: 22)
        .contentShape(Rectangle())
    }
}

// MARK: - Check by ear (X, Y)

/// "Check by ear…": one popover for the two checks the terminal runs as `listen --spot-check N` and
/// `listen --long-stretch-words N`. Each check has its number in a `KitNumberField` (the saved setting), its Prepare
/// button and its result; a failure stays in the popover with its sentence, Retry and Details. Before, two system
/// steppers and two push buttons sat in the list, and a failure was `localizedDescription` in red.
struct ListenCheckButton: View {
    @Bindable var detail: MeetingDetailModel
    let rate: SpotCheckRate?
    let compact: Bool
    /// Shows the prepared group in the list (`ItemsBar.show`).
    let show: (String) -> Void
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: {
            ItemsBarLabel(title: "Check by ear…", symbol: "ear", compact: compact)
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Add questions that check the guessed speakers by listening: a spot check, or the long stretches")
        .accessibilityLabel("Check by ear")
        .accessibilityIdentifier("meetings.items.checkByEar")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            ListenCheckPopover(detail: detail, rate: rate) { group in
                open = false
                show(group)
            }
        }
    }
}

struct ListenCheckPopover: View {
    @Bindable var detail: MeetingDetailModel
    let rate: SpotCheckRate?
    /// A check prepared its questions: the popover closes and the list shows them.
    let prepared: (String) -> Void
    @AppStorage(MeetingsPreferences.Listen.spotCheckCount.key) private var count = MeetingsPreferences.Listen.spotCheckCount.defaultValue
    @AppStorage(MeetingsPreferences.Listen.longStretchWords.key) private var words = MeetingsPreferences.Listen.longStretchWords.defaultValue
    @State private var running: String?
    @State private var failure: (group: String, error: MeetingsCLI.Failure)?
    @State private var none: String?
    @State private var historyOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Check the speakers by ear").font(.headline)
                Text("Each check adds questions you answer by listening. Your answers show how often the guesses were right.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            check(group: "spot-check", title: "Spot check",
                  detail: "Lines picked at random from the guesses at 50 to 69 %.",
                  field: KitNumberField("Lines in a spot check", value: $count, in: MeetingsPreferences.Listen.spotCheckRange,
                                        suffix: .counted("line"), size: .small, identifier: "meetings.items.spotCheckCount")) {
                if let rate {
                    Text(verbatim: "Last result: \(rate.sentence)").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                if let checks = self.detail.record.value?.review?.listen?.spotChecks, !checks.isEmpty {
                    GenDisclosure(isExpanded: $historyOpen, minHeight: 22, identifier: "meetings.items.spotCheckHistory") {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
                                Text(verbatim: "\(MeetingsFormat.dayTime(check.at)): \(check.changed) of \(Plural.count(check.answered, "answer")) changed")
                                    .font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.leading, 18)
                    } label: {
                        Text(verbatim: "Earlier spot checks (\(checks.count))").font(.system(size: 12))
                    }
                }
            }
            Divider()
            check(group: "long-stretch", title: "Long stretches",
                  detail: "Every guessed stretch of this many words or more, below 70 %, split where the voice changes.",
                  field: KitNumberField("Words in a long stretch", value: $words, in: MeetingsPreferences.Listen.longStretchRange,
                                        step: 10, suffix: .counted("word"), size: .small, identifier: "meetings.items.longStretchWords")) {
                EmptyView()
            }
        }
        .padding(16)
        .frame(width: 360)
    }

    private func check<Extra: View>(group: String, title: String, detail text: String, field: KitNumberField,
                                    @ViewBuilder extra: () -> Extra) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                field
                Spacer(minLength: 8)
                if running == group { ProgressView().controlSize(.small) }
                GhostButton(running == group ? "Preparing…" : "Prepare", symbol: "plus.bubble",
                            tooltip: "Add the \(title.lowercased()) questions to this meeting's Items",
                            identifier: "meetings.items.prepare.\(group)") { prepare(group) }
                    .disabled(running != nil)
            }
            if failure?.group == group, let error = failure?.error {
                NoticePill(text: error.sentence, more: error.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { prepare(group) },
                                   error.detailsFix { prepare(group) }],
                           dismiss: { failure = nil })
            }
            if none == group {
                Text(group == "spot-check" ? "Every guessed line at 50 to 69 % is asked or confirmed already."
                                           : "No guessed stretch this long is left to ask.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            extra()
        }
    }

    private func prepare(_ group: String) {
        guard running == nil else { return }
        running = group
        failure = nil
        none = nil
        Task {
            defer { running = nil }
            do {
                let added = try await detail.prepareListenQuality(group, count: count, words: words)
                if added == 0 { none = group; return }
                let noun = group == "spot-check" ? "spot-check question" : "long-stretch question"
                detail.notices.push(StackedNotice(text: "Added \(Plural.count(added, noun))", tone: .success))
                prepared(group)
            } catch {
                failure = (group, asFailure(error))
            }
        }
    }
}

// MARK: - Run the rules again (w_7ogmeryo)

/// "Run the rules again…": `meeting.suggest` on a meeting that has items already, after a question says what the run
/// does to them. Before, only the empty Items tab could start the rules.
struct RunRulesButton: View {
    @Bindable var detail: MeetingDetailModel
    let compact: Bool
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: {
            ItemsBarLabel(title: "Run the rules again…", symbol: "arrow.clockwise", compact: compact)
        }
        .buttonStyle(.genHoverPlain())
        .disabled(detail.isBusy("suggest"))
        .instantTooltip("Run the rules on the transcript again: new suggestions are added, your decisions stay")
        .accessibilityLabel("Run the rules again")
        .accessibilityIdentifier("meetings.items.runRules")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            RunRulesPopover(cancel: { open = false }) {
                open = false
                detail.suggest()
            }
        }
    }
}

/// What a second run does to the items there are, before it starts: the rule a reader needs to trust it.
struct RunRulesPopover: View {
    let cancel: () -> Void
    let run: () -> Void

    static let lines = [
        "Confirmed and rejected items stay as they are.",
        "A suggestion you rejected is not suggested again.",
        "New suggestions and questions are added.",
        "An open suggestion that a dictionary entry or a voice name now settles is retired.",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Run the rules on the transcript again?").font(.system(size: 13, weight: .semibold))
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Self.lines, id: \.self) { line in
                    Label { Text(line).fixedSize(horizontal: false, vertical: true) } icon: {
                        Image(systemName: "circle.fill").font(.system(size: 4)).foregroundStyle(.secondary)
                    }
                    .font(.system(size: 12))
                }
            }
            Text("A run on a long meeting can take a minute; its progress shows above the list, with Cancel.")
                .font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                Button("Run the rules", action: run).keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("meetings.items.runRules.confirm")
            }
        }
        .padding(16)
        .frame(width: 340)
    }
}
