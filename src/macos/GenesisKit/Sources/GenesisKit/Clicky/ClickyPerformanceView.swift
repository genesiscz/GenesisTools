import Charts
import SwiftUI

@MainActor
public struct ClickyPerformanceView: View {
    @ObservedObject private var store: ClickyAnalyticsStore
    @State private var range = "7 days"
    @State private var start = Calendar.current.startOfDay(for: Date())
    @State private var end = Date()
    @State private var grouping: ClickyPerformanceGrouping = .fifteenMinutes
    @State private var weekdays = Set(0..<7)
    @State private var fromHour = 0
    @State private var untilHour = 24
    @State private var metric = "Presses"
    @State private var comparison = "Time of day"
    @State private var example: ClickyStatistics?
    @State private var exampleTime: Date?
    @AppStorage private var spokenWPM: Int
    @AppStorage private var setupSeconds: Int
    private let weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    public init(store: ClickyAnalyticsStore, defaults: UserDefaults) {
        self.store = store
        _spokenWPM = AppStorage(wrappedValue: 140, "clicky.performance.spokenWPM", store: defaults)
        _setupSeconds = AppStorage(wrappedValue: 3, "clicky.performance.setupSeconds", store: defaults)
    }
    private var data: ClickyStatistics { example ?? store.snapshot }
    private var now: Date { exampleTime ?? Date() }
    private var filter: ClickyPerformanceFilter {
        let calendar = Calendar.current
        let first: Date
        switch range {
        case "Today": first = calendar.startOfDay(for: now)
        case "30 days": first = calendar.date(byAdding: .day, value: -29, to: calendar.startOfDay(for: now)) ?? now
        case "Custom": first = calendar.startOfDay(for: start)
        default: first = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now)) ?? now
        }
        let last = range == "Custom"
            ? calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: end)) ?? now : now
        return ClickyPerformanceFilter(start: first, end: last, weekdays: weekdays, fromHour: fromHour, untilHour: untilHour)
    }

    public var body: some View {
        let report = ClickyPerformanceReport(statistics: data, filter: filter, grouping: grouping)
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Find your typing rhythm").font(.system(size: 21, weight: .semibold, design: .rounded))
                    Text(example == nil ? "Local aggregates · pauses over 5 seconds stop the clock" : "Sample performance · never saved")
                        .font(.caption).foregroundStyle(example == nil ? Color.secondary : .orange)
                }
                Spacer()
                Button(example == nil ? "Explore sample data" : "Back to my data") {
                    if example == nil {
                        let reference = Date()
                        exampleTime = reference
                        example = ClickyStatistics.example(now: reference)
                    } else { example = nil; exampleTime = nil }
                }.buttonStyle(.bordered).accessibilityIdentifier("clicky.performance.example")
            }
            filters
            if range == "Custom" && end < start {
                Label("Choose an end date on or after the start date.", systemImage: "calendar.badge.exclamationmark")
                    .foregroundStyle(.orange)
            }
            if data.performanceStartedAt == nil {
                NativeSettingsCard {
                    Label("Timing starts with your next recorded key press.", systemImage: "stopwatch")
                    Text("Earlier totals do not contain pauses or active seconds. Clicky keeps those totals without inventing performance history.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 12) {
                number("Presses", report.total.presses.formatted(), "keyboard", "All recorded key-down events")
                number("Estimated words", report.total.estimatedWords.formatted(.number.precision(.fractionLength(1))), "text.word.spacing", "5 text-like presses per word")
                number("Active typing", duration(report.total.activeSeconds), "stopwatch", "Long pauses excluded")
            }
            timeline(report)
            dictation(report.total)
            HStack(spacing: 12) {
                number("Estimated pace", report.total.wordsPerMinute.map { String(format: "%.1f WPM", $0) } ?? "—",
                    "speedometer", "Weighted by active time")
                number("Correction share", report.total.correctionShare.formatted(.percent.precision(.fractionLength(1))),
                    "delete.left", "Delete presses / text + delete")
                number("Average burst", report.total.bursts > 0 ? duration(report.total.activeSeconds / Double(report.total.bursts)) : "—",
                    "waveform.path", "Active seconds / started bursts")
            }
            pace(report)
            playful(report.total)
            NativeSettingsCard("How the estimates work") {
                Text("Only intervals between text-like key presses of 5 seconds or less count as active typing. Longer gaps add no time; isolated presses have no measurable duration. Key releases, modifiers and Command/Control shortcuts add no words. Navigation and shortcuts end a typing burst.")
                Text("Words are a keystroke convention, not captured text. Code, pasted text, autocomplete, non-Latin input and editing can change the result. Correction share counts delete keys; it is not an error-rate score. No text, key sequence or application history is retained.")
                Text("Performance retains 30 days of minute aggregates. Filters use your current local calendar; rates divide combined words by combined active seconds, rather than averaging bucket speeds. Date and hour filters have minute precision.")
                if let since = data.performanceStartedAt {
                    Text("Timing history since \(since.formatted(date: .abbreviated, time: .shortened))")
                }
            }.font(.caption).foregroundStyle(.secondary)
        }
    }

    private var filters: some View {
        NativeSettingsCard("Time and filters") {
            NativeSettingsRow("Date range") {
                Picker("Date range", selection: $range) {
                    ForEach(["Today", "7 days", "30 days", "Custom"], id: \.self) { Text($0).tag($0) }
                }.labelsHidden().frame(width: 150, alignment: .trailing)
                    .accessibilityIdentifier("clicky.performance.range")
            }
            if range == "Custom" {
                HStack {
                    DatePicker("From", selection: $start, displayedComponents: .date)
                    DatePicker("Through", selection: $end, displayedComponents: .date)
                }.datePickerStyle(.field)
            }
            NativeSettingsRow("Group timeline by") {
                Picker("Grouping", selection: $grouping) {
                    ForEach(ClickyPerformanceGrouping.allCases) { Text($0.label).tag($0) }
                }.labelsHidden().frame(width: 150, alignment: .trailing)
                    .accessibilityIdentifier("clicky.performance.grouping")
            }
            HStack {
                Text("Weekdays").font(.system(size: 13, weight: .medium))
                Spacer()
                ForEach(0..<7, id: \.self) { day in
                    Button(weekdayNames[day]) {
                        if weekdays.contains(day) { weekdays.remove(day) } else { weekdays.insert(day) }
                    }.buttonStyle(.bordered).tint(weekdays.contains(day) ? .mint : .gray)
                        .accessibilityValue(weekdays.contains(day) ? "Included" : "Excluded")
                        .accessibilityIdentifier("clicky.performance.weekday.\(day)")
                }
            }
            NativeSettingsRow("Hours", detail: "Start included, end excluded. A later start spans midnight.") {
                HStack(spacing: 8) {
                    NativeSettingsNumberPicker("From hour", range: 0..<24, identifier: "clicky.performance.fromHour", value: $fromHour)
                    Text("→").foregroundStyle(.secondary)
                    NativeSettingsNumberPicker("Until hour", range: 1..<25, identifier: "clicky.performance.untilHour", value: $untilHour)
                }
            }
        }
    }

    private func number(_ title: String, _ value: String, _ symbol: String, _ detail: String) -> some View {
        NativeSettingsCard {
            Label(title, systemImage: symbol).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.system(size: 22, weight: .semibold, design: .rounded)).monospacedDigit()
            Text(detail).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func timeline(_ report: ClickyPerformanceReport) -> some View {
        NativeSettingsCard("Performance over time") {
            Picker("Timeline metric", selection: $metric) {
                ForEach(["Presses", "Estimated words", "Active seconds"], id: \.self) { Text($0).tag($0) }
            }.pickerStyle(.segmented).accessibilityIdentifier("clicky.performance.metric")
            NativeTimeSeriesChart(points: report.timeline.map { point in
                let value = metric == "Presses" ? Double(point.totals.presses)
                    : metric == "Estimated words" ? point.totals.estimatedWords : point.totals.activeSeconds
                return NativeTimePoint(date: point.date, value: value)
            }, interval: Double(grouping.rawValue), initialWindow: Double(max(grouping.rawValue * 12, 3600)),
                end: min(now, filter.end), valueLabel: metric)
                .id("\(grouping.rawValue).\(range).\(example != nil)")
            if report.timeline.isEmpty { Text("No recorded activity matches these filters.").font(.caption).foregroundStyle(.secondary) }
        }
    }

    private func dictation(_ totals: ClickyPerformanceBucket) -> some View {
        let estimate = ClickyDictationEstimate(totals: totals, wordsPerMinute: spokenWPM, setupPerBurst: setupSeconds)
        return NativeSettingsCard("Estimated time lost by writing instead of dictating",
            subtitle: "A configurable what-if comparison, not a measurement of actual dictation.") {
            HStack(alignment: .firstTextBaseline) {
                Text(totals.activeSeconds > 0 ? duration(max(0, estimate.differenceSeconds)) : "—")
                    .font(.system(size: 32, weight: .semibold, design: .rounded)).foregroundStyle(.mint)
                Text("potential time saved").foregroundStyle(.secondary)
            }
            if estimate.differenceSeconds < 0 {
                Text("Typing was \(duration(-estimate.differenceSeconds)) faster under these assumptions.")
                    .font(.caption).foregroundStyle(.orange)
            }
            Chart {
                BarMark(x: .value("Seconds", estimate.typingSeconds), y: .value("Method", "Typing"))
                    .foregroundStyle(by: .value("Component", "Active typing"))
                BarMark(x: .value("Seconds", estimate.speakingSeconds), y: .value("Method", "Dictation"))
                    .foregroundStyle(by: .value("Component", "Speaking"))
                BarMark(x: .value("Seconds", estimate.setupSeconds), y: .value("Method", "Dictation"))
                    .foregroundStyle(by: .value("Component", "Setup"))
            }.chartForegroundStyleScale(["Active typing": Color.mint, "Speaking": Color.cyan, "Setup": Color.orange])
                .frame(height: 110).chartXAxisLabel("Seconds")
            NativeSettingsRow("Speech speed", detail: "Estimated retained words ÷ words per minute × 60") {
                HStack { NativeSettingsNumberPicker("Spoken words per minute", range: 60..<241,
                    identifier: "clicky.performance.speech", value: $spokenWPM); Text("WPM").font(.caption) }
            }
            NativeSettingsRow("Setup per burst", detail: "One dictation activation for every typing burst") {
                HStack { NativeSettingsNumberPicker("Setup seconds per burst", range: 0..<16,
                    identifier: "clicky.performance.setup", value: $setupSeconds); Text("sec").font(.caption) }
            }
            Text("\(totals.bursts.formatted()) bursts × \(setupSeconds)s setup + \(duration(estimate.speakingSeconds)) speaking. Retained-word estimate: max(0, text-like presses − delete presses) ÷ 5; deleting a selection or undoing cannot be inferred. It excludes thinking time, transcription delay and review/corrections after dictation; it cannot tell prose from code.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func pace(_ report: ClickyPerformanceReport) -> some View {
        let values = comparison == "Time of day" ? report.hours : report.weekdays
        let labels = comparison == "Time of day" ? (0..<24).map { String(format: "%02d", $0) } : weekdayNames
        return NativeSettingsCard("Typing performance by \(comparison.lowercased())", subtitle: "Estimated words per active minute · filters above apply") {
            Picker("Performance comparison", selection: $comparison) {
                Text("Time of day").tag("Time of day")
                Text("Weekday").tag("Weekday")
            }.pickerStyle(.segmented).accessibilityIdentifier("clicky.performance.comparison")
            Chart(Array(values.enumerated()), id: \.offset) { index, bucket in
                if let pace = bucket.wordsPerMinute {
                    BarMark(x: .value(comparison, labels[index]), y: .value("Estimated WPM", pace))
                        .foregroundStyle(.mint.gradient)
                }
            }.frame(height: 200).chartYAxisLabel("Estimated WPM")
            Text("Empty categories have insufficient timed input, not zero typing speed. Pace needs at least 5 text-like presses and 1 active second.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func playful(_ totals: ClickyPerformanceBucket) -> some View {
        HStack(alignment: .top, spacing: 12) {
            fun("Tiny finger hike", symbol: "figure.walk", value: String(format: "%.1f m", Double(totals.presses) * 0.002),
                progress: Double(totals.presses) * 0.002 / 1000, caption: "Toward 1 km · pretend 2 mm per press")
            fun("Accidental novelist", symbol: "book.closed", value: String(format: "%.1f pages", totals.estimatedWords / 250),
                progress: totals.estimatedWords / 80000, caption: "Toward a novel · 80k words, 250 per page")
            fun("One-key concert", symbol: "music.note", value: duration(Double(totals.presses) / 2),
                progress: Double(totals.presses) / (120 * 60), caption: "Toward a 1-hour set · 120 presses per minute")
        }
    }
    private func fun(_ title: String, symbol: String, value: String, progress: Double, caption: String) -> some View {
        NativeSettingsCard {
            Image(systemName: symbol).font(.title2).foregroundStyle(.purple)
            Text(title).font(.headline)
            Text(value).font(.system(size: 20, weight: .semibold, design: .rounded)).monospacedDigit()
            ProgressView(value: min(1, max(0, progress))).tint(.purple)
            Text(caption).font(.caption2).foregroundStyle(.secondary)
            Text("Just for fun").font(.caption2).foregroundStyle(.purple)
        }
    }
    private func duration(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "—" }
        let value = max(0, Int(seconds.rounded()))
        if value >= 3600 { return "\(value / 3600)h \((value % 3600) / 60)m" }
        if value >= 60 { return "\(value / 60)m \(value % 60)s" }
        return "\(value)s"
    }
}
