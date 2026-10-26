import Charts
import SwiftUI

@MainActor
public struct ClickyPerformanceView: View {
    @ObservedObject private var store: ClickyAnalyticsStore
    private let status: ClickyRecordingStatus
    private let fixRecording: (() -> Void)?
    @AppStorage private var storedRange: String
    @AppStorage private var startTimestamp: Double
    @AppStorage private var endTimestamp: Double
    var start: Date {
        get { Date(timeIntervalSince1970: startTimestamp) }
        nonmutating set { startTimestamp = newValue.timeIntervalSince1970 }
    }
    var end: Date {
        get { Date(timeIntervalSince1970: endTimestamp) }
        nonmutating set { endTimestamp = newValue.timeIntervalSince1970 }
    }
    @State private var requestedGrouping: ClickyPerformanceGrouping
    private var grouping: ClickyPerformanceGrouping {
        ClickyRanges.validGrouping(requestedGrouping, for: interval, now: now)
    }
    @State private var weekdays = Set(0..<7)
    @State private var fromHour = 0
    @State private var untilHour = 24
    @AppStorage private var storedMetric: String
    @AppStorage private var comparison: String
    @AppStorage private var chartStyle: NativeTimeSeriesChart.Style
    @AppStorage private var showFun: Bool
    @State private var example: ClickyStatistics?
    @State private var exampleTime: Date?
    @State private var preparedReport = ClickyPerformanceReport()
    @State private var previousReport: ClickyPerformanceReport?
    @State private var loaded = false
    @State private var preparing = false
    @State private var refresh = 0
    @State private var refreshPending = false
    @State private var lastUserQuery: Query?
    @AppStorage private var spokenWPM: Int
    @AppStorage private var setupSeconds: Int
    @AppStorage private var dictatedPercent: Int
    @AppStorage private var reviewPercent: Int

    /// - Parameters:
    ///   - status: whether Clicky records right now; anything but `.recording` shows why under the title.
    ///   - fixRecording: the action of the button beside that reason.
    public init(store: ClickyAnalyticsStore, defaults: UserDefaults, status: ClickyRecordingStatus = .recording,
        fixRecording: (() -> Void)? = nil) {
        self.store = store
        self.status = status
        self.fixRecording = fixRecording
        let range = ClickyRanges.known(defaults.string(forKey: "clicky.performance.range") ?? ClickyRanges.week,
            allowed: Self.ranges)
        _storedRange = AppStorage(wrappedValue: ClickyRanges.week, "clicky.performance.range", store: defaults)
        let reference = Date()
        let defaultStart = Calendar.current.startOfDay(for: reference).timeIntervalSince1970
        _startTimestamp = AppStorage(wrappedValue: defaultStart, "clicky.performance.customStart", store: defaults)
        _endTimestamp = AppStorage(wrappedValue: reference.timeIntervalSince1970, "clicky.performance.customEnd", store: defaults)
        let restored = ClickyRanges.interval(range, now: reference, earliest: nil,
            customStart: Date(timeIntervalSince1970: defaults.object(forKey: "clicky.performance.customStart") as? Double ?? defaultStart),
            customEnd: Date(timeIntervalSince1970: defaults.object(forKey: "clicky.performance.customEnd") as? Double ?? reference.timeIntervalSince1970))
        _requestedGrouping = State(initialValue: ClickyRanges.grouping(for: range, span: restored.duration))
        _storedMetric = AppStorage(wrappedValue: Metric.presses.rawValue, "clicky.performance.metric", store: defaults)
        _comparison = AppStorage(wrappedValue: "Time of day", "clicky.performance.comparison", store: defaults)
        _chartStyle = AppStorage(wrappedValue: .area, "clicky.performance.chartStyle", store: defaults)
        _showFun = AppStorage(wrappedValue: true, "clicky.performance.showFun", store: defaults)
        _spokenWPM = AppStorage(wrappedValue: 140, "clicky.performance.spokenWPM", store: defaults)
        _setupSeconds = AppStorage(wrappedValue: 3, "clicky.performance.setupSeconds", store: defaults)
        _dictatedPercent = AppStorage(wrappedValue: 70, "clicky.performance.dictatedPercent", store: defaults)
        _reviewPercent = AppStorage(wrappedValue: 15, "clicky.performance.reviewPercent", store: defaults)
    }

    enum Metric: String, CaseIterable {
        case presses = "Presses", words = "Words typed", time = "Typing time", pace = "Pace"
        case corrections = "Correction share", sessions = "Typing sessions"
    }

    private var range: String { ClickyRanges.known(storedRange, allowed: Self.ranges) }
    private var metric: Metric { Metric(rawValue: storedMetric) ?? .presses }
    private var data: ClickyStatistics { example ?? store.snapshot }
    private var now: Date { exampleTime ?? Date() }
    private var interval: DateInterval {
        ClickyRanges.interval(range, now: now, earliest: earliest, customStart: start, customEnd: end)
    }
    private var filter: ClickyPerformanceFilter {
        ClickyPerformanceFilter(start: interval.start, end: interval.end, weekdays: weekdays, fromHour: fromHour,
            untilHour: untilHour)
    }
    private var previousFilter: ClickyPerformanceFilter? {
        guard let previous = ClickyRanges.previous(interval, range: range), earliest < previous.end else { return nil }
        var shifted = filter
        shifted.start = previous.start
        shifted.end = previous.end
        return shifted
    }
    private var previousName: String { ClickyRanges.previousName(interval, range: range) }
    private var filtered: Bool { weekdays.count < 7 || fromHour != 0 || untilHour != 24 }

    private var earliest: Date { ClickyRetention.performanceStart(data, now: now) ?? now }

    nonisolated static let ranges = ClickyRanges.presets + [ClickyRanges.custom]

    /// The timeline grouping a range opens with: about 50 to 400 bars, never one bar per minute over a year.
    nonisolated static func grouping(for range: String) -> ClickyPerformanceGrouping {
        ClickyRanges.grouping(for: range)
    }

    private struct Query: Equatable {
        let range: String
        let start: Date
        let end: Date
        let grouping: ClickyPerformanceGrouping
        let weekdays: Set<Int>
        let fromHour: Int
        let untilHour: Int
        let exampleTime: Date?
        var refresh: Int
    }
    private var query: Query {
        Query(range: range, start: start, end: end, grouping: grouping, weekdays: weekdays, fromHour: fromHour,
            untilHour: untilHour, exampleTime: exampleTime, refresh: refresh)
    }

    /// A range that ends now gets new data while the user types; a closed one never changes.
    private var live: Bool { example == nil && interval.end >= Date().addingTimeInterval(-60) }

    /// New key presses rebuild the report at most every 5 seconds, not on every published second.
    private func scheduleRefresh() {
        guard live, !refreshPending else { return }
        refreshPending = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(5))
            refreshPending = false
            refresh &+= 1
        }
    }

    public var body: some View {
        let report = preparedReport
        VStack(alignment: .leading, spacing: 18) {
            header
            if example == nil, let message = status.message {
                ClickyRecordingBanner(message: message, actionTitle: status.actionTitle, action: fixRecording)
            }
            if data.performanceStartedAt == nil && example == nil {
                NativeSettingsCard {
                    EmptyState(symbol: "stopwatch",
                        text: status == .recording ? "Timing starts with your next recorded key press."
                            : "No timing history yet.",
                        detail: "Earlier totals do not contain pauses or typing time, so Clicky keeps them without inventing performance history.",
                        actionTitle: "Explore Sample Data", action: showExample)
                }
            } else {
                filters
                if range == ClickyRanges.custom && end < start {
                    Label("Choose an end date on or after the start date.", systemImage: "calendar.badge.exclamationmark")
                        .foregroundStyle(.orange)
                }
                if loaded && report.total.presses == 0 { emptyResult }
                numbers(report)
                    .redacted(reason: loaded ? [] : .placeholder)
                    .opacity(preparing ? 0.55 : 1)
                timeline(report)
                dictation(report)
                pace(report)
                records(report)
                if showFun { playful(report.total) }
                NativeSettingsCard("How the estimates work") {
                    Text("Only intervals between text-like key presses of 5 seconds or less count as typing time. Longer gaps add no time; isolated presses have no measurable duration. Key releases, modifiers and Command or Control shortcuts add no words. Navigation and shortcuts end a typing burst.")
                    Text("Words are a keystroke convention, not captured text: 5 text-like presses make one word typed. Words kept subtract the delete presses. Code, pasted text, autocomplete, non-Latin input and editing can change the result. Correction share counts delete keys; it is not an error-rate score. No text, key sequence or application history is retained.")
                    Text("A typing session starts at a clock minute with text after a clock minute without text, so the session count is approximate. Filters use your current local calendar; rates divide combined words by combined typing time, rather than averaging bucket speeds. Ranges past 30 days count whole hours.")
                    Text(ClickyRetention.text)
                    if let since = data.performanceStartedAt {
                        Text("Timing history since \(since.formatted(date: .abbreviated, time: .shortened)).")
                    }
                    Toggle("Show the just-for-fun cards", isOn: $showFun).toggleStyle(.checkbox)
                        .accessibilityIdentifier("clicky.performance.showFun")
                }.font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear { store.attach() }
        .onDisappear { store.detach() }
        .onChange(of: store.revision) { _, _ in scheduleRefresh() }
        .onChange(of: start) { _, _ in if range == ClickyRanges.custom { regroupCustom() } }
        .onChange(of: end) { _, _ in if range == ClickyRanges.custom { regroupCustom() } }
        .task(id: query) {
            var userQuery = query
            userQuery.refresh = 0
            // A refresh while typing updates in place; only a change the user made shows progress, and only when it
            // takes longer than 300 ms.
            let quiet = userQuery == lastUserQuery
            lastUserQuery = userQuery
            let spinner = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                if !Task.isCancelled && !quiet { preparing = true }
            }
            defer { spinner.cancel() }
            let statistics = data
            let previousFilter = previousFilter
            async let current = ClickyPerformanceReport.prepare(statistics: statistics, filter: filter, grouping: grouping)
            async let earlier: ClickyPerformanceReport? = previousFilter == nil ? nil
                : ClickyPerformanceReport.prepare(statistics: statistics, filter: previousFilter!, grouping: .day)
            let (result, previous) = await (current, earlier)
            guard !Task.isCancelled else { return }
            if let result {
                preparedReport = result
                previousReport = previous
                loaded = true
            }
            preparing = false
        }
    }

    private func showExample() {
        let reference = Date()
        exampleTime = reference
        example = ClickyStatistics.example(now: reference)
        AccessibilityNotification.Announcement("Showing sample data. It is never saved.").post()
    }

    private func regroupCustom() {
        requestedGrouping = ClickyRanges.grouping(for: ClickyRanges.custom, span: interval.duration)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Find your typing rhythm").font(.system(size: 21, weight: .semibold, design: .rounded))
                Text(example == nil ? "Local aggregates. Pauses over 5 seconds stop the clock." : "Sample performance, never saved")
                    .font(.caption).foregroundStyle(example == nil ? Color.secondary : .orange)
            }
            Spacer()
            if preparing { ProgressView().controlSize(.small).help("Preparing the selected time range") }
            Button(example == nil ? "Explore Sample Data" : "Back to My Data") {
                if example == nil { showExample() } else {
                    example = nil
                    exampleTime = nil
                    AccessibilityNotification.Announcement("Showing your data.").post()
                }
            }.buttonStyle(.bordered).accessibilityIdentifier("clicky.performance.example")
        }
    }

    private var filters: some View {
        NativeSettingsCard("Time and filters") {
            NativeSettingsRow("Date range") {
                Picker("Date range", selection: Binding(get: { range }, set: { storedRange = $0 })) {
                    ForEach(Self.ranges, id: \.self) { Text($0).tag($0) }
                }.labelsHidden().frame(width: 150, alignment: .trailing)
                    .accessibilityIdentifier("clicky.performance.range")
                    .onChange(of: storedRange) { _, next in
                        requestedGrouping = next == ClickyRanges.custom
                            ? ClickyRanges.grouping(for: next, span: interval.duration) : Self.grouping(for: next)
                    }
            }
            if let coverage = ClickyRanges.coverageText(interval, earliest: data.performanceStartedAt == nil ? nil : earliest) {
                Label(coverage, systemImage: "calendar.badge.clock").font(.caption).foregroundStyle(.secondary)
            }
            if range == ClickyRanges.custom {
                HStack {
                    DatePicker("From", selection: Binding(get: { start }, set: { start = $0 }), displayedComponents: .date)
                    DatePicker("Through", selection: Binding(get: { end }, set: { end = $0 }), displayedComponents: .date)
                }.datePickerStyle(.field)
                Text("Custom dates are saved. Grouping and weekday/hour filters reset when this page reopens.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            let groupings = ClickyRanges.groupings(for: interval, now: now)
            NativeSettingsRow("Group timeline by",
                detail: groupings.count < ClickyPerformanceGrouping.allCases.count
                    ? "Minute detail is kept for 30 days, so this range groups by hour or wider." : nil) {
                Picker("Grouping", selection: Binding(get: { grouping }, set: { requestedGrouping = $0 })) {
                    ForEach(groupings) { Text($0.label).tag($0) }
                }.labelsHidden().frame(width: 150, alignment: .trailing)
                    .accessibilityIdentifier("clicky.performance.grouping")
            }
            HStack {
                Text("Weekdays").font(.system(size: 13, weight: .medium))
                Spacer()
                ForEach(ClickyWeekdays.order(), id: \.self) { day in
                    Button(ClickyWeekdays.shortName(day)) {
                        if weekdays.contains(day) { weekdays.remove(day) } else { weekdays.insert(day) }
                    }.buttonStyle(.borderedProminent).tint(weekdays.contains(day) ? .mint : .gray)
                        .accessibilityValue(weekdays.contains(day) ? "Included" : "Excluded")
                        .accessibilityAddTraits(weekdays.contains(day) ? .isSelected : [])
                        .accessibilityIdentifier("clicky.performance.weekday.\(day)")
                }
            }
            NativeSettingsRow("Hours", detail: "Start included, end excluded. A later start spans midnight; the same hour twice means all day.") {
                HStack(spacing: 8) {
                    NativeSettingsNumberPicker("From hour", range: 0..<24, identifier: "clicky.performance.fromHour", value: $fromHour)
                    Text("to").foregroundStyle(.secondary)
                    NativeSettingsNumberPicker("Until hour", range: 1..<25, identifier: "clicky.performance.untilHour", value: $untilHour)
                }
            }
            HStack(spacing: 8) {
                Text("Presets").font(.caption).foregroundStyle(.secondary)
                Button("Weekdays") { weekdays = Set(0..<5) }.buttonStyle(.genHover())
                Button("Weekend") { weekdays = [5, 6] }.buttonStyle(.genHover())
                Button("Work hours") { fromHour = 9; untilHour = 17 }.buttonStyle(.genHover())
                    .help("9:00 to 17:00")
                Spacer()
                Button("Reset Filters", action: resetFilters).buttonStyle(.genHover()).disabled(!filtered)
                    .help(filtered ? "Include every day and every hour" : "No filter is set")
            }
        }
    }

    private func resetFilters() {
        weekdays = Set(0..<7)
        fromHour = 0
        untilHour = 24
    }

    /// One line in words for the filters in force, shown where the results are.
    private var filterSummary: String? {
        guard filtered else { return nil }
        let days = weekdays.count == 7 ? "every day"
            : ClickyWeekdays.order().filter { weekdays.contains($0) }.map { ClickyWeekdays.shortName($0) }.joined(separator: ", ")
        let hours = fromHour == 0 && untilHour == 24 ? "all day" : String(format: "%02d:00 to %02d:00", fromHour, untilHour % 24)
        return "Filters: \(days.isEmpty ? "no day" : days), \(hours)"
    }

    private var emptyResult: some View {
        let reason: String
        if weekdays.isEmpty { reason = "No weekday is selected, so nothing can match." }
        else if ClickyRanges.coveredDays(interval, earliest: earliest) == 0 { reason = "Nothing was recorded in this range." }
        else if filtered { reason = "Your weekday and hour filters exclude every key press recorded in this range." }
        else { reason = "No key press was recorded in this range." }
        return HStack {
            Label(reason, systemImage: "line.3.horizontal.decrease.circle").foregroundStyle(.orange)
            Spacer()
            if filtered { Button("Reset Filters", action: resetFilters).buttonStyle(.bordered) }
        }.font(.system(size: 12))
    }

    private func numbers(_ report: ClickyPerformanceReport) -> some View {
        let total = report.total
        let previous = previousReport?.total
        let name = previousName
        let netPace = total.activeSeconds >= 1 ? total.estimatedRetainedWords * 60 / total.activeSeconds : nil
        let days = max(1, ClickyRanges.coveredDays(interval, earliest: earliest))
        return VStack(alignment: .leading, spacing: 8) {
            if let summary = filterSummary {
                HStack {
                    Label(summary, systemImage: "line.3.horizontal.decrease.circle").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Reset", action: resetFilters).buttonStyle(.genHover()).font(.caption)
                }
            }
            Grid(horizontalSpacing: 12, verticalSpacing: 12) {
                GridRow {
                    number("Presses", total.presses.formatted(), "keyboard", "Every key-down event",
                        ClickyFormat.change(Double(total.presses), previous.map { Double($0.presses) }, against: name))
                    number("Words typed", total.estimatedWords.formatted(.number.precision(.fractionLength(0))),
                        "text.word.spacing", "5 text-like presses per word",
                        ClickyFormat.change(total.estimatedWords, previous?.estimatedWords, against: name))
                    number("Words kept", total.estimatedRetainedWords.formatted(.number.precision(.fractionLength(0))),
                        "text.badge.checkmark", "Words typed minus delete presses",
                        ClickyFormat.change(total.estimatedRetainedWords, previous?.estimatedRetainedWords, against: name))
                }
                GridRow {
                    number("Typing time", ClickyFormat.duration(total.activeSeconds), "stopwatch",
                        "Pauses over 5 seconds excluded",
                        ClickyFormat.change(total.activeSeconds, previous?.activeSeconds, against: name))
                    number("Pace", total.wordsPerMinute.map { String(format: "%.1f WPM", $0) } ?? ClickyFormat.missing,
                        "speedometer", netPace.map { String(format: "%.1f WPM counting words kept", $0) } ?? "Words typed per minute of typing",
                        total.wordsPerMinute.flatMap { ClickyFormat.change($0, previous?.wordsPerMinute, against: name) })
                    number("Correction share", ClickyFormat.percent(total.correctionShare), "delete.left",
                        "Delete presses of text and delete presses",
                        ClickyFormat.pointChange(total.correctionShare, previous?.correctionShare, against: name))
                }
                GridRow {
                    number("Typing sessions", total.sessions.formatted(), "rectangle.stack",
                        "Text after a clock minute without text",
                        ClickyFormat.change(Double(total.sessions), previous.map { Double($0.sessions) }, against: name))
                    number("Average burst", total.bursts > 0 ? ClickyFormat.duration(total.activeSeconds / Double(total.bursts)) : ClickyFormat.missing,
                        "waveform.path", "Typing time per started burst", nil)
                    number("Active days", "\(report.activeDays.formatted()) of \(days.formatted())", "calendar",
                        "Days with typing; \(ClickyFormat.duration(total.activeSeconds / Double(max(1, report.activeDays)))) per active day",
                        nil)
                }
            }
        }
    }

    private func number(_ title: String, _ value: String, _ symbol: String, _ detail: String, _ change: String?) -> some View {
        NativeSettingsCard {
            Label(title, systemImage: symbol).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.system(size: 22, weight: .semibold, design: .rounded)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text(change ?? " ").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                .accessibilityHidden(change == nil)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }

    private func timelineValue(_ totals: ClickyPerformanceBucket) -> Double? {
        switch metric {
        case .presses: return Double(totals.presses)
        case .words: return totals.estimatedWords
        case .time: return totals.activeSeconds
        case .pace: return totals.activeSeconds >= 30 ? totals.wordsPerMinute : nil
        case .corrections: return totals.characters + totals.corrections >= 20 ? totals.correctionShare * 100 : nil
        case .sessions: return Double(totals.sessions)
        }
    }

    private var timelineFormat: ((Double) -> String)? {
        switch metric {
        case .time: return { ClickyFormat.duration($0) }
        case .pace: return { String(format: "%.0f WPM", $0) }
        case .corrections: return { String(format: "%.1f%%", $0) }
        default: return nil
        }
    }

    private func timeline(_ report: ClickyPerformanceReport) -> some View {
        NativeSettingsCard("Performance over time", subtitle: "\(range == ClickyRanges.custom ? "Custom range" : range) by \(grouping.label.lowercased())") {
            Picker("Timeline metric", selection: Binding(get: { metric.rawValue }, set: { storedMetric = $0 })) {
                ForEach(Metric.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
            }.pickerStyle(.segmented).labelsHidden().accessibilityIdentifier("clicky.performance.metric")
            NativeTimeSeriesChart(points: report.timeline.compactMap { point in
                timelineValue(point.totals).map { NativeTimePoint(date: point.date, value: $0,
                    weight: metric == .pace ? point.totals.activeSeconds
                        : metric == .corrections ? Double(point.totals.characters + point.totals.corrections) : 1) }
            }, interval: Double(grouping.rawValue), initialWindow: Double(max(grouping.rawValue * 12, 3600)),
                end: min(now, interval.end), valueLabel: metric.rawValue, rangeStart: interval.start,
                combine: metric == .pace || metric == .corrections ? .average : .sum, valueFormat: timelineFormat,
                style: $chartStyle)
                .id("\(grouping.rawValue).\(range).\(interval.start.timeIntervalSince1970).\(example != nil)")
            if metric == .pace || metric == .corrections {
                Text(metric == .pace ? "Bars with less than 30 seconds of typing are left out."
                    : "Bars with fewer than 20 text and delete presses are left out.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func dictation(_ report: ClickyPerformanceReport) -> some View {
        let totals = report.total
        let estimate = ClickyDictationEstimate(totals: totals, wordsPerMinute: spokenWPM, setupPerSession: setupSeconds,
            dictatedShare: Double(dictatedPercent) / 100, reviewShare: Double(reviewPercent) / 100)
        let difference = estimate.differenceSeconds
        let activeDays = max(1, report.activeDays)
        let coveredDays = max(1, ClickyRanges.coveredDays(interval, earliest: earliest))
        let parts = [
            DictationPart(method: "Typing", part: "Typing", seconds: estimate.typingSeconds),
            DictationPart(method: "Dictation", part: "Speaking", seconds: estimate.speakingSeconds),
            DictationPart(method: "Dictation", part: "Setup", seconds: estimate.setupSeconds),
            DictationPart(method: "Dictation", part: "Review", seconds: estimate.reviewSeconds),
        ]
        return NativeSettingsCard("Estimated time saved by dictating",
            subtitle: "A what-if comparison under the settings below, not a measurement of real dictation.") {
            if totals.activeSeconds <= 0 {
                Text("No typing time in this range to compare.").foregroundStyle(.secondary)
            } else if difference >= 0 {
                HStack(alignment: .firstTextBaseline) {
                    Text(ClickyFormat.duration(difference))
                        .font(.system(size: 32, weight: .semibold, design: .rounded)).foregroundStyle(.mint).monospacedDigit()
                    Text("saved in this range").foregroundStyle(.secondary)
                }
                Text("About \(ClickyFormat.duration(difference / Double(activeDays))) per active day, \(ClickyFormat.duration(difference / Double(coveredDays) * 7)) per week.")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                Text("Typing is \(ClickyFormat.duration(-difference)) faster under these settings")
                    .font(.system(size: 22, weight: .semibold, design: .rounded)).foregroundStyle(.orange)
                Text("About \(ClickyFormat.duration(-difference / Double(activeDays))) per active day.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Chart(parts, id: \.part) { part in
                BarMark(x: .value("Time", part.seconds), y: .value("Method", part.method))
                    .foregroundStyle(by: .value("Part", part.part))
                    .annotation(position: .overlay) {
                        if part.seconds >= max(estimate.typingSeconds, estimate.dictationSeconds) * 0.12 && part.seconds > 0 {
                            Text(ClickyFormat.duration(part.seconds)).font(.caption.weight(.semibold)).foregroundStyle(.black.opacity(0.8))
                        }
                    }
            }
            .chartForegroundStyleScale(["Typing": Color.mint, "Speaking": Color.cyan, "Setup": Color.orange, "Review": Color.purple])
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { value in
                    AxisGridLine()
                    AxisValueLabel { if let seconds = value.as(Double.self) { Text(ClickyFormat.duration(seconds)) } }
                }
            }
            .frame(height: 120)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Typing \(ClickyFormat.duration(estimate.typingSeconds)); dictation \(ClickyFormat.duration(estimate.dictationSeconds)): speaking \(ClickyFormat.duration(estimate.speakingSeconds)), setup \(ClickyFormat.duration(estimate.setupSeconds)), review \(ClickyFormat.duration(estimate.reviewSeconds))")
            Text("\(estimate.retainedWords.formatted(.number.precision(.fractionLength(0)))) of \(totals.estimatedRetainedWords.formatted(.number.precision(.fractionLength(0)))) words kept would be dictated, in \(Int((Double(totals.sessions) * Double(dictatedPercent) / 100).rounded()).formatted()) of \(totals.sessions.formatted()) typing sessions.")
                .font(.caption).foregroundStyle(.secondary)
            NativeSettingsSlider("Share of your typing you would dictate",
                detail: "Code, commands and passwords stay typed. Clicky cannot tell them apart, so you set the share.",
                identifier: "clicky.performance.dictatedShare", value: percentBinding($dictatedPercent),
                in: 0...100, step: 5, ticks: [0, 50, 100], width: 160, format: { "\(Int($0))%" })
            NativeSettingsSlider("Review after dictation",
                detail: "Reading and fixing the transcript, as a share of the speaking time.",
                identifier: "clicky.performance.reviewShare", value: percentBinding($reviewPercent),
                in: 0...100, step: 5, ticks: [0, 50, 100], width: 160, format: { "\(Int($0))%" })
            NativeSettingsRow("Speech speed", detail: "Words kept divided by this speed give the speaking time.") {
                HStack { NativeSettingsNumberPicker("Spoken words per minute", range: 60..<241,
                    identifier: "clicky.performance.speech", value: $spokenWPM); Text("WPM").font(.caption) }
            }
            NativeSettingsRow("Setup per session", detail: "One dictation start per typing session. A session starts at text after a clock minute without text.") {
                HStack { NativeSettingsNumberPicker("Setup seconds per session", range: 0..<16,
                    identifier: "clicky.performance.setup", value: $setupSeconds); Text("sec").font(.caption) }
            }
            Text("Words kept are text-like presses minus delete presses, divided by 5; deleting a selection or undoing cannot be inferred. The estimate leaves out thinking time and transcription delay.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private struct DictationPart {
        let method: String
        let part: String
        let seconds: Double
    }

    private func percentBinding(_ value: Binding<Int>) -> Binding<Double> {
        Binding(get: { Double(value.wrappedValue) }, set: { value.wrappedValue = Int($0.rounded()) })
    }

    private func pace(_ report: ClickyPerformanceReport) -> some View {
        let byHour = comparison != "Weekday"
        let order = ClickyWeekdays.order()
        let entries: [(label: String, bucket: ClickyPerformanceBucket)] = byHour
            ? report.hours.enumerated().map { (String(format: "%02d", $0.offset), $0.element) }
            : order.map { (ClickyWeekdays.shortName($0), report.weekdays[$0]) }
        let overall = report.total.wordsPerMinute
        return NativeSettingsCard("Typing pace by \(byHour ? "time of day" : "weekday")", subtitle: "Words typed per minute of typing. Filters above apply.") {
            Picker("Pace comparison", selection: $comparison) {
                Text("Time of day").tag("Time of day")
                Text("Weekday").tag("Weekday")
            }.pickerStyle(.segmented).labelsHidden().accessibilityIdentifier("clicky.performance.comparison")
            Chart {
                ForEach(entries, id: \.label) { entry in
                    if entry.bucket.activeSeconds >= 60, let pace = entry.bucket.wordsPerMinute {
                        BarMark(x: .value(byHour ? "Hour" : "Weekday", entry.label), y: .value("WPM", pace))
                            .foregroundStyle(.mint.gradient)
                            .opacity(entry.bucket.activeSeconds >= 300 ? 1 : 0.4)
                            .accessibilityValue("\(String(format: "%.0f", pace)) words per minute over \(ClickyFormat.duration(entry.bucket.activeSeconds))")
                    }
                }
                if let overall {
                    RuleMark(y: .value("Overall", overall)).foregroundStyle(.secondary)
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        .annotation(position: .top, alignment: .trailing) {
                            Text(String(format: "Overall %.0f WPM", overall)).font(.caption).foregroundStyle(.secondary)
                        }
                }
            }.frame(height: 200).chartYAxisLabel("WPM")
            Text("A bar needs at least 1 minute of typing; faded bars have less than 5 minutes. An empty slot means too little typing, not a slow speed.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func records(_ report: ClickyPerformanceReport) -> some View {
        let records = ClickyRecords(days: report.days.mapValues { Double($0.presses) }, today: now)
        let bestPace = report.days.filter { $0.value.activeSeconds >= 600 }
            .compactMap { day in day.value.wordsPerMinute.map { (day.key, $0) } }.max { $0.1 < $1.1 }
        let day = Date.FormatStyle.dateTime.weekday(.abbreviated).month(.abbreviated).day()
        return NativeSettingsCard("Records in this range") {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                GridRow {
                    Text("Busiest day").foregroundStyle(.secondary)
                    Text(records.busiestDay.map { "\($0.formatted(day)): \(Int(records.busiestDayValue).formatted()) presses" } ?? ClickyFormat.missing)
                }
                GridRow {
                    Text("Fastest day").foregroundStyle(.secondary)
                    Text(bestPace.map { "\($0.0.formatted(day)): \(String(format: "%.1f", $0.1)) WPM" } ?? "Needs a day with 10 minutes of typing")
                }
                GridRow {
                    Text("Longest streak").foregroundStyle(.secondary)
                    Text("\(records.longestStreak) \(records.longestStreak == 1 ? "day" : "days") in a row with typing")
                }
                GridRow {
                    Text("Current streak").foregroundStyle(.secondary)
                    Text("\(records.currentStreak) \(records.currentStreak == 1 ? "day" : "days")")
                }
            }.font(.system(size: 12)).monospacedDigit()
        }
    }

    private func playful(_ totals: ClickyPerformanceBucket) -> some View {
        HStack(alignment: .top, spacing: 12) {
            fun("Tiny finger hike", symbol: "figure.walk", value: String(format: "%.1f m", Double(totals.presses) * 0.002),
                progress: Double(totals.presses) * 0.002 / 1000, caption: "Toward 1 km, pretending 2 mm per press")
            fun("Accidental novelist", symbol: "book.closed", value: String(format: "%.1f pages", totals.estimatedWords / 250),
                progress: totals.estimatedWords / 80000, caption: "Toward a novel: 80k words, 250 per page")
            fun("One-key concert", symbol: "music.note", value: ClickyFormat.duration(Double(totals.presses) / 2),
                progress: Double(totals.presses) / (120 * 60), caption: "Toward a 1-hour set at 120 presses per minute")
        }
    }
    private func fun(_ title: String, symbol: String, value: String, progress: Double, caption: String) -> some View {
        NativeSettingsCard {
            Image(systemName: symbol).font(.title2).foregroundStyle(.purple).accessibilityHidden(true)
            Text(title).font(.headline)
            Text(value).font(.system(size: 20, weight: .semibold, design: .rounded)).monospacedDigit()
            ProgressView(value: min(1, max(0, progress))).tint(.purple)
            Text(caption).font(.caption).foregroundStyle(.secondary)
            Text("Just for fun").font(.caption).foregroundStyle(.purple)
        }.accessibilityElement(children: .combine)
    }
}

/// "Not recording: …" with the button that fixes it.
struct ClickyRecordingBanner: View {
    let message: String
    let actionTitle: String
    let action: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Label(message, systemImage: "pause.circle.fill").font(.system(size: 12)).foregroundStyle(.orange)
            Spacer(minLength: 0)
            if let action, !actionTitle.isEmpty { Button(actionTitle, action: action).buttonStyle(.bordered) }
        }
        .padding(12).nativeGlassSurface()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("clicky.recordingStatus")
    }
}
