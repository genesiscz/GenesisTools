import SwiftUI

@MainActor
public struct ClickyAnalyticsView: View {
    @ObservedObject private var store: ClickyAnalyticsStore
    @State private var tab = "Activity"
    @State private var resolution: ClickyTimeResolution = .minute
    @State private var releases = false
    @State private var example: ClickyStatistics?
    @State private var exampleTime: Date?
    @State private var selectedKey: Int?

    public init(store: ClickyAnalyticsStore) { self.store = store }
    private var data: ClickyStatistics { example ?? store.snapshot }
    private var now: Date { exampleTime ?? Date() }
    private var today: [ClickyActivityBucket] {
        let start = Int(Calendar.current.startOfDay(for: now).timeIntervalSince1970 / 60)
        return data.minutes.filter { $0.key >= start }.map(\.value)
    }
    private var todayPresses: Int { today.reduce(0) { $0 + $1.presses } }
    private var activeMinutes: Int { today.filter { $0.presses > 0 }.count }
    private var keyRanking: [(key: Int, value: Int)] {
        data.keys.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your keyboard, over time").font(.system(size: 21, weight: .semibold, design: .rounded))
                    Text(example == nil ? "Recorded locally · updates once a second while typing" : "Sample data · never saved to your statistics")
                        .font(.caption).foregroundStyle(example == nil ? Color.secondary : .orange)
                }
                Spacer()
                Button(example == nil ? "Explore sample data" : "Back to my data") {
                    if example == nil {
                        let reference = Date()
                        exampleTime = reference
                        example = ClickyStatistics.example(now: reference)
                    } else {
                        example = nil
                        exampleTime = nil
                    }
                }.buttonStyle(.bordered).accessibilityIdentifier("clicky.stats.example")
            }
            HStack(spacing: 12) {
                summary(example == nil ? "Today" : "Sample day", value: todayPresses.formatted(), symbol: "keyboard")
                summary("Active minutes", value: activeMinutes.formatted(), symbol: "clock")
                summary("Peak / minute", value: (today.map(\.presses).max() ?? 0).formatted(), symbol: "bolt")
            }
            Picker("Statistics view", selection: $tab) {
                ForEach(["Activity", "Keys", "Rhythm"], id: \.self) { Text($0).tag($0) }
            }.pickerStyle(.segmented).labelsHidden().accessibilityIdentifier("clicky.stats.view")
            if data.historyStartedAt == nil {
                NativeSettingsCard {
                    Label("Detailed history starts with your next recorded key press.", systemImage: "chart.xyaxis.line")
                    Text("Your existing \(data.presses.formatted()) lifetime presses are preserved. There is no historical timeline to reconstruct from those totals.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                switch tab {
                case "Keys": keys
                case "Rhythm": rhythm
                default: activity
                }
            }
            HStack {
                Text("\(data.presses.formatted()) lifetime presses · \(data.releases.formatted()) releases · \(data.sessions.formatted()) activations")
                Spacer()
                if let since = data.historyStartedAt {
                    Text("History since \(since.formatted(date: .abbreviated, time: .shortened))")
                }
            }.font(.caption2).foregroundStyle(.secondary)
        }
        // On the whole view, so every tab (Activity is the default) gets the once-a-second updates.
        .onAppear { store.attach() }
        .onDisappear { store.detach() }
    }

    private func summary(_ title: String, value: String, symbol: String) -> some View {
        NativeSettingsCard {
            Label(title, systemImage: symbol).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.system(size: 26, weight: .semibold, design: .rounded)).monospacedDigit()
        }
    }

    private var activity: some View {
        NativeSettingsCard {
            HStack {
                Text("Activity timeline").font(.headline)
                Spacer()
                Picker("Count", selection: $releases) {
                    Text("Presses").tag(false)
                    Text("Releases").tag(true)
                }.labelsHidden().frame(width: 105, alignment: .trailing)
                Picker("Time resolution", selection: $resolution) {
                    ForEach(ClickyTimeResolution.allCases) { Text($0.rawValue).tag($0) }
                }.labelsHidden().frame(width: 110, alignment: .trailing)
                    .accessibilityIdentifier("clicky.stats.resolution")
            }
            NativeTimeSeriesChart(points: data.timeline(resolution, releases: releases),
                interval: resolution.seconds, initialWindow: resolution.initialWindow,
                end: now, valueLabel: releases ? "Releases" : "Presses")
                .id("\(resolution.rawValue).\(example != nil)")
            Text("\(resolution.rawValue)-by-\(resolution.rawValue.lowercased()) recorded counts. Wide views combine nearby bins to keep scrolling responsive.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var keys: some View {
        VStack(spacing: 18) {
            NativeSettingsCard("Physical key heat map", subtitle: "Aggregate presses by key position · US labels · no text or sequence retained") {
                let peak = max(1, data.keys.values.max() ?? 0)
                VStack(spacing: 5) {
                    ForEach(ClickyKeyLayout.rows.indices, id: \.self) { row in
                        HStack(spacing: 4) {
                            ForEach(ClickyKeyLayout.rows[row]) { key in
                                let count = data.keys[key.code, default: 0]
                                Button { selectedKey = key.code } label: {
                                    Text(key.label).font(.system(size: 10, weight: .medium))
                                        .frame(maxWidth: .infinity).frame(height: 31)
                                        .background(.mint.opacity(count == 0 ? 0.05 : 0.12 + 0.65 * pow(Double(count) / Double(peak), 0.5)),
                                            in: RoundedRectangle(cornerRadius: 5))
                                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(selectedKey == key.code ? .mint : .clear, lineWidth: 1))
                                }.buttonStyle(.plain)
                                    .help("\(key.label): \(count.formatted()) presses")
                                    .accessibilityLabel("\(key.label), \(count) presses")
                            }
                        }.padding(.horizontal, row == 3 ? 8 : row == 4 ? 15 : 0)
                    }
                }
                if let key = selectedKey {
                    Text("\(ClickyKeyLayout.label(key)) · \(data.keys[key, default: 0].formatted()) presses")
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
        VStack(spacing: 18) {
            NativeSettingsCard("When you type", subtitle: "Hour of day × day of week · local time · brighter means more recorded presses") {
                NativeMatrixHeatmap(rows: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
                    columns: (0..<24).map { String(format: "%02d", $0) }, cells: data.weekdayHeatmap())
                Text("Hover a cell for its count. Based on the retained year of hourly history.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            NativeSettingsCard("Day by day") {
                NativeTimeSeriesChart(points: data.timeline(.day), interval: 86400,
                    initialWindow: 7 * 86400, end: now, valueLabel: "Presses")
                    .id("days.\(example != nil)")
            }
            NativeSettingsCard("Weekday distribution") {
                let cells = data.weekdayHeatmap()
                let labels = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
                NativeCategoryChart(values: labels.indices.map { row in
                    NativeCategoryValue(label: labels[row], value: cells.filter { $0.row == row }.reduce(0) { $0 + $1.value })
                })
            }
        }
    }
}
