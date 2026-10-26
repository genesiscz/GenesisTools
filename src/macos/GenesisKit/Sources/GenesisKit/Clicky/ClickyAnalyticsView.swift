import SwiftUI

@MainActor
public struct ClickyAnalyticsView: View {
    @ObservedObject private var store: ClickyAnalyticsStore
    private let status: ClickyRecordingStatus
    private let fixRecording: (() -> Void)?
    @AppStorage private var tab: String
    @AppStorage private var storedRange: String
    @AppStorage private var chartStyle: NativeTimeSeriesChart.Style
    @State private var resolution: ClickyTimeResolution
    @State private var releases = false
    @State private var example: ClickyStatistics?
    @State private var exampleTime: Date?
    @State private var selectedKey: Int?
    @State private var report = ClickyStatsReport()
    @State private var previousName = ""
    @State private var refresh = 0
    @State private var refreshPending = false

    /// - Parameters:
    ///   - status: whether Clicky records right now; anything but `.recording` shows why under the title.
    ///   - fixRecording: the action of the button beside that reason.
    public init(store: ClickyAnalyticsStore, defaults: UserDefaults = .standard,
        status: ClickyRecordingStatus = .recording, fixRecording: (() -> Void)? = nil) {
        self.store = store
        self.status = status
        self.fixRecording = fixRecording
        _tab = AppStorage(wrappedValue: "Activity", "clicky.stats.tab", store: defaults)
        _storedRange = AppStorage(wrappedValue: ClickyRanges.week, "clicky.stats.range", store: defaults)
        _chartStyle = AppStorage(wrappedValue: .area, "clicky.stats.chartStyle", store: defaults)
        let range = ClickyRanges.known(defaults.string(forKey: "clicky.stats.range") ?? ClickyRanges.week,
            allowed: ClickyRanges.presets)
        _resolution = State(initialValue: ClickyRanges.resolution(for: range))
    }

    private var data: ClickyStatistics { example ?? store.snapshot }
    private var now: Date { exampleTime ?? Date() }
    private var range: String { ClickyRanges.known(storedRange, allowed: ClickyRanges.presets) }
    private var earliest: Date? {
        data.historyStartedAt ?? data.days.keys.min().map { Date(timeIntervalSince1970: Double($0)) }
    }
    private var interval: DateInterval { ClickyRanges.interval(range, now: now, earliest: earliest) }
    private var keyRanking: [(key: Int, value: Int)] {
        data.keys.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
    }

    private struct Query: Equatable {
        let range: String
        let resolution: ClickyTimeResolution
        let releases: Bool
        let exampleTime: Date?
        let refresh: Int
    }

    /// New key presses rebuild the page at most every 5 seconds, off the main thread.
    private func scheduleRefresh() {
        guard example == nil, !refreshPending else { return }
        refreshPending = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(5))
            refreshPending = false
            refresh &+= 1
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if example == nil, let message = status.message {
                ClickyRecordingBanner(message: message, actionTitle: status.actionTitle, action: fixRecording)
            }
            if data.historyStartedAt == nil && example == nil {
                NativeSettingsCard {
                    EmptyState(symbol: "chart.xyaxis.line",
                        text: status == .recording ? "Detailed history starts with your next recorded key press."
                            : "No detailed history yet.",
                        detail: "Your existing \(data.presses.formatted()) lifetime presses are preserved. There is no historical timeline to reconstruct from those totals.",
                        actionTitle: "Explore Sample Data", action: showExample)
                }
            } else {
                rangeRow
                summary.redacted(reason: report.loaded ? [] : .placeholder)
                Picker("Statistics view", selection: $tab) {
                    ForEach(["Activity", "Keys", "Rhythm"], id: \.self) { Text($0).tag($0) }
                }.pickerStyle(.segmented).labelsHidden().accessibilityIdentifier("clicky.stats.view")
                switch tab {
                case "Keys": keys
                case "Rhythm": rhythm
                default: activity
                }
            }
            HStack {
                Text("\(data.presses.formatted()) lifetime presses, \(data.releases.formatted()) key releases, Clicky turned on \(data.sessions.formatted()) times")
                Spacer()
                if let since = data.historyStartedAt {
                    Text("History since \(since.formatted(date: .abbreviated, time: .shortened))")
                }
            }.font(.caption).foregroundStyle(.secondary)
        }
        // On the whole view, so every tab (Activity is the default) gets the updates.
        .onAppear { store.attach() }
        .onDisappear { store.detach() }
        .onChange(of: store.revision) { _, _ in scheduleRefresh() }
        .task(id: Query(range: range, resolution: resolution, releases: releases, exampleTime: exampleTime, refresh: refresh)) {
            let interval = interval
            let previous = ClickyRanges.previous(interval, range: range)
            let name = ClickyRanges.previousName(interval, range: range)
            let built = await ClickyStatsReport.prepare(statistics: data, interval: interval, previous: previous,
                resolution: resolution, releases: releases, now: now)
            guard let built, !Task.isCancelled else { return }
            report = built
            previousName = name
        }
    }

    private func showExample() {
        let reference = Date()
        exampleTime = reference
        example = ClickyStatistics.example(now: reference)
        AccessibilityNotification.Announcement("Showing sample data. It is never saved.").post()
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Your keyboard, over time").font(.system(size: 21, weight: .semibold, design: .rounded))
                Text(example == nil
                    ? (status == .recording ? "Recorded locally. Updates every few seconds while you type." : "Recorded locally. Recording is paused.")
                    : "Sample data, never saved to your statistics")
                    .font(.caption).foregroundStyle(example == nil ? Color.secondary : .orange)
            }
            Spacer()
            Button(example == nil ? "Explore Sample Data" : "Back to My Data") {
                if example == nil { showExample() } else {
                    example = nil
                    exampleTime = nil
                    AccessibilityNotification.Announcement("Showing your data.").post()
                }
            }.buttonStyle(.bordered).accessibilityIdentifier("clicky.stats.example")
        }
    }

    private var rangeRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Date range").font(.system(size: 13, weight: .medium))
                Spacer()
                Picker("Date range", selection: Binding(get: { range }, set: { storedRange = $0 })) {
                    ForEach(ClickyRanges.presets, id: \.self) { Text($0).tag($0) }
                }.labelsHidden().frame(width: 150, alignment: .trailing)
                    .accessibilityIdentifier("clicky.stats.range")
                    .onChange(of: storedRange) { _, next in
                        resolution = ClickyRanges.resolution(for: ClickyRanges.known(next, allowed: ClickyRanges.presets))
                    }
            }
            if let coverage = ClickyRanges.coverageText(interval, earliest: earliest) {
                Label(coverage, systemImage: "calendar.badge.clock").font(.caption).foregroundStyle(.secondary)
            }
            if report.approximateTotals {
                Text("Totals and comparisons are approximate at partial hours or days where minute detail has expired.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var summary: some View {
        let day = Date.FormatStyle.dateTime.weekday(.abbreviated).month(.abbreviated).day()
        let previousAverage = report.previousTotal.map { Double($0) / Double(max(1, report.totalDays)) }
        return Grid(horizontalSpacing: 12, verticalSpacing: 12) {
            GridRow {
                card("Presses", report.total.formatted(), "keyboard", rangeDetail,
                    ClickyFormat.change(Double(report.total), report.previousTotal.map(Double.init), against: previousName))
                card("Daily average", report.dailyAverage.formatted(.number.precision(.fractionLength(0))), "chart.bar",
                    "Per recorded day", ClickyFormat.change(report.dailyAverage, previousAverage, against: previousName))
                card("Active days", "\(report.activeDays) of \(report.coveredDays)", "calendar", "Days with at least one press", nil)
            }
            GridRow {
                card("Busiest day", report.records.busiestDay.map { $0.formatted(day) } ?? ClickyFormat.missing, "flame",
                    report.records.busiestDay == nil ? "No presses yet" : "\(Int(report.records.busiestDayValue).formatted()) presses", nil)
                card("Busiest hour", report.busiestHour.map { $0.formatted(.dateTime.month(.abbreviated).day().hour()) } ?? ClickyFormat.missing,
                    "clock", report.busiestHour == nil ? "Hourly counts cover 1 year" : "\(report.busiestHourValue.formatted()) presses", nil)
                card("Peak minute", report.peakMinuteValue.formatted(), "bolt",
                    report.peakMinute.map { "At \($0.formatted(.dateTime.month(.abbreviated).day().hour().minute()))" } ?? "Minute detail covers 30 days", nil)
            }
            GridRow {
                card("Current streak", "\(report.records.currentStreak) \(report.records.currentStreak == 1 ? "day" : "days")",
                    "flame.fill", "Days in a row with typing", nil)
                card("Longest streak", "\(report.records.longestStreak) \(report.records.longestStreak == 1 ? "day" : "days")",
                    "trophy", "In this range", nil)
                card("Today", todayPresses.formatted(), "sun.max", "Presses since midnight", nil)
            }
        }
    }

    private var rangeDetail: String {
        switch range {
        case ClickyRanges.today: return "Today so far"
        case ClickyRanges.year: return "In the last year"
        case ClickyRanges.all: return "In all kept data"
        default: return "In the last \(range)"
        }
    }

    private var todayPresses: Int {
        let start = Int(Calendar.current.startOfDay(for: now).timeIntervalSince1970)
        return data.days[start]?.presses ?? 0
    }

    private func card(_ title: String, _ value: String, _ symbol: String, _ detail: String, _ change: String?) -> some View {
        NativeSettingsCard {
            Label(title, systemImage: symbol).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.system(size: 22, weight: .semibold, design: .rounded)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(detail).font(.caption).foregroundStyle(.secondary)
            Text(change ?? " ").font(.caption).foregroundStyle(.secondary).accessibilityHidden(change == nil)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }

    private var activity: some View {
        let resolutions = ClickyRanges.resolutions(for: interval, now: now)
        return NativeSettingsCard {
            HStack {
                Text("Activity timeline").font(.headline)
                Spacer()
                Picker("Count", selection: $releases) {
                    Text("Presses").tag(false)
                    Text("Releases").tag(true)
                }.labelsHidden().frame(width: 105, alignment: .trailing)
                Picker("Time resolution", selection: $resolution) {
                    ForEach(resolutions) { Text($0.rawValue).tag($0) }
                }.labelsHidden().frame(width: 110, alignment: .trailing)
                    .accessibilityIdentifier("clicky.stats.resolution")
            }
            NativeTimeSeriesChart(points: report.timeline, interval: resolution.seconds,
                initialWindow: resolution.initialWindow, end: now, valueLabel: releases ? "Releases" : "Presses",
                rangeStart: interval.start, style: $chartStyle)
                .id("\(resolution.rawValue).\(range).\(example != nil)")
            Text(resolutions == [.day]
                ? "Hourly counts are kept for 1 year, so this range shows daily totals."
                : resolutions.count < ClickyTimeResolution.allCases.count
                    ? "Minute detail is kept for 30 days, so this range shows hours or days. Wide views combine nearby bars."
                    : "\(resolution.rawValue)-by-\(resolution.rawValue.lowercased()) recorded counts. Wide views combine nearby bars.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var keys: some View {
        VStack(spacing: 18) {
            NativeSettingsCard("Physical key heat map", subtitle: "Aggregate presses by key position since detailed statistics began. US labels; no text or sequence retained.") {
                let peak = max(1, data.keys.values.max() ?? 0)
                let total = max(1, data.keys.values.reduce(0, +))
                VStack(spacing: 5) {
                    ForEach(ClickyKeyLayout.rows.indices, id: \.self) { row in
                        HStack(spacing: 4) {
                            ForEach(ClickyKeyLayout.rows[row]) { key in
                                let count = data.keys[key.code, default: 0]
                                Button { selectedKey = key.code } label: {
                                    Text(key.label).font(.system(size: 11, weight: .medium))
                                        .frame(maxWidth: .infinity).frame(height: 31)
                                        .background(.mint.opacity(count == 0 ? 0.05 : 0.12 + 0.65 * pow(Double(count) / Double(peak), 0.5)),
                                            in: RoundedRectangle(cornerRadius: 5))
                                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(selectedKey == key.code ? .mint : .clear, lineWidth: 1))
                                        .contentShape(Rectangle())
                                }.buttonStyle(.genHoverPlain())
                                    .help("\(key.label): \(count.formatted()) presses")
                                    .accessibilityLabel("\(key.label), \(count) presses")
                                    .accessibilityAddTraits(selectedKey == key.code ? .isSelected : [])
                            }
                        }.padding(.horizontal, row == 3 ? 8 : row == 4 ? 15 : 0)
                    }
                }
                if let key = selectedKey {
                    let count = data.keys[key, default: 0]
                    Text("\(ClickyKeyLayout.label(key)): \(count.formatted()) presses, \(ClickyFormat.percent(Double(count) / Double(total))) of all")
                        .font(.caption).foregroundStyle(.mint)
                } else { Text("Select a key to inspect its total.").font(.caption).foregroundStyle(.secondary) }
            }
            NativeSettingsCard("Most-used keys", subtitle: "Counts since detailed statistics began") {
                let top = Array(keyRanking.prefix(12))
                NativeCategoryChart(values: top.map { NativeCategoryValue(label: ClickyKeyLayout.label($0.key), value: Double($0.value)) })
                let others = keyRanking.dropFirst(12).reduce(0) { $0 + $1.value }
                Text("Other keys: \(others.formatted()) presses").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var rhythm: some View {
        let order = ClickyWeekdays.order()
        return VStack(spacing: 18) {
            NativeSettingsCard("When you type", subtitle: "Hour of day by day of week in the selected range, local time. Brighter means more presses.") {
                NativeMatrixHeatmap(rows: order.map { ClickyWeekdays.shortName($0) },
                    columns: (0..<24).map { String(format: "%02d", $0) }, cells: report.heatmap)
                Text("Hover a cell for its count. Hourly counts are kept for 1 year, so a longer range shows its last year here.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            NativeSettingsCard("Day by day") {
                NativeTimeSeriesChart(points: report.dayTimeline, interval: 86400,
                    initialWindow: 7 * 86400, end: now, valueLabel: "Presses", rangeStart: interval.start, style: $chartStyle)
                    .id("days.\(range).\(example != nil)")
            }
            NativeSettingsCard("Average day of the week", subtitle: "Presses per weekday, divided by how often that weekday occurs in the recorded range") {
                NativeCategoryChart(values: order.map { weekday in
                    NativeCategoryValue(label: ClickyWeekdays.name(weekday), value: report.weekdayAverages[weekday].rounded())
                })
            }
        }
    }
}
