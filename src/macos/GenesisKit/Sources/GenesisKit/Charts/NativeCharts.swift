import Charts
import SwiftUI

public struct NativeTimePoint: Identifiable, Equatable, Sendable {
    public var date: Date
    public var value: Double
    public var id: Date { date }
    public init(date: Date, value: Double) { self.date = date; self.value = value }
}

public enum NativeChartSampling {
    public static func pannedPosition(origin: Date, translation: Double, width: Double,
        window: TimeInterval, domain: ClosedRange<Date>) -> Date {
        clampedPosition(origin.addingTimeInterval(-translation / max(1, width) * window), window: window, domain: domain)
    }

    /// The leading edge of a `window`-wide view that stays inside `domain`.
    public static func clampedPosition(_ position: Date, window: TimeInterval, domain: ClosedRange<Date>) -> Date {
        max(domain.lowerBound, min(position, domain.upperBound.addingTimeInterval(-window)))
    }

    /// X-axis label format: daily bins show the date; a sub-day bin in a window wider than a day
    /// shows the date too, or ticks on different days would read the same.
    public static func axisLabelFormat(interval: TimeInterval, window: TimeInterval) -> Date.FormatStyle {
        if interval >= 86400 { return .dateTime.day().month(.abbreviated) }
        if window > 86400 { return .dateTime.month(.abbreviated).day().hour().minute() }
        return .dateTime.hour().minute()
    }

    public static func bins(points: [NativeTimePoint], start: Date, end: Date, step: TimeInterval,
        calendar: Calendar = .current) -> [NativeTimePoint] {
        guard let first = points.first, end > start, step > 0 else { return [] }
        if step == 86400 {
            var day = calendar.startOfDay(for: max(first.date, start))
            let values = Dictionary(points.filter { $0.date >= day && $0.date < end }.map {
                (calendar.startOfDay(for: $0.date), $0.value)
            }, uniquingKeysWith: +)
            var result: [NativeTimePoint] = []
            while day < end && result.count < 1201 {
                result.append(NativeTimePoint(date: day, value: values[day, default: 0]))
                guard let next = calendar.date(byAdding: .day, value: 1, to: day), next > day else { break }
                day = next
            }
            return result
        }
        let interval = max(step, ceil(end.timeIntervalSince(start) / (step * 1200)) * step)
        let lower = max(first.date.timeIntervalSince1970, floor(start.timeIntervalSince1970 / interval) * interval)
        let upper = end.timeIntervalSince1970
        guard lower < upper else { return [] }
        let count = min(1201, Int(ceil((upper - lower) / interval)))
        var values = Array(repeating: 0.0, count: count)
        var low = 0
        var high = points.count
        while low < high {
            let middle = (low + high) / 2
            if points[middle].date.timeIntervalSince1970 < lower { low = middle + 1 } else { high = middle }
        }
        for point in points[low...] {
            let time = point.date.timeIntervalSince1970
            if time >= upper { break }
            let index = Int((time - lower) / interval)
            if values.indices.contains(index) { values[index] += point.value }
        }
        return values.enumerated().map { NativeTimePoint(
            date: Date(timeIntervalSince1970: lower + Double($0.offset) * interval), value: $0.element) }
    }
}

public struct NativeTimeSeriesChart: View {
    public enum Style: String, CaseIterable, Identifiable {
        case line = "Line", area = "Area", bars = "Bars"
        public var id: Self { self }
    }
    private let points: [NativeTimePoint]
    private let interval: TimeInterval
    private let initialWindow: TimeInterval
    private let valueLabel: String
    private let end: Date
    @State private var style: Style = .area
    @State private var zoom = 1.0
    @State private var position: Date
    @State private var selected: Date?
    @State private var panOrigin: Date?
    @State private var plotWidth: CGFloat = 1
    @GestureState private var dragging = false

    public init(points: [NativeTimePoint], interval: TimeInterval, initialWindow: TimeInterval,
        end: Date = Date(), valueLabel: String = "Events") {
        self.points = points
        self.interval = interval
        self.initialWindow = initialWindow
        self.valueLabel = valueLabel
        self.end = end
        _position = State(initialValue: end.addingTimeInterval(-initialWindow))
    }
    private var window: TimeInterval { max(interval * 5, initialWindow / zoom) }
    private var domain: ClosedRange<Date> {
        let first = points.first?.date ?? end.addingTimeInterval(-initialWindow)
        return min(first, end.addingTimeInterval(-window))...end
    }
    private var visible: [NativeTimePoint] {
        NativeChartSampling.bins(points: points, start: position.addingTimeInterval(-window / 4),
            end: min(end, position.addingTimeInterval(window * 1.25)), step: interval)
    }
    private var selectedPoint: NativeTimePoint? {
        guard let selected else { return nil }
        return visible.min { abs($0.date.timeIntervalSince(selected)) < abs($1.date.timeIntervalSince(selected)) }
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("Chart style", selection: $style) {
                    ForEach(Style.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).labelsHidden().frame(width: 210, alignment: .leading)
                Spacer()
                Button { zoom = max(0.25, zoom / 2) } label: { Image(systemName: "minus.magnifyingglass").frame(width: 26, height: 26).contentShape(Rectangle()) }
                    .accessibilityLabel("Zoom out chart")
                Slider(value: $zoom, in: 0.25...8).frame(width: 90).accessibilityLabel("Chart zoom")
                Button { zoom = min(8, zoom * 2) } label: { Image(systemName: "plus.magnifyingglass").frame(width: 26, height: 26).contentShape(Rectangle()) }
                    .accessibilityLabel("Zoom in chart")
                Button("Latest") { position = max(domain.lowerBound, end.addingTimeInterval(-window)) }
            }.buttonStyle(.borderless)
            plot.frame(height: 235)
            HStack {
                if let point = selectedPoint {
                    Text("\(point.date.formatted(date: .abbreviated, time: .shortened)) · \(Int(point.value).formatted()) \(valueLabel.lowercased())")
                } else { Text("Drag or scroll to explore. Hover to inspect a value.") }
                Spacer()
                Text(position.formatted(date: .abbreviated, time: .shortened)).monospacedDigit()
            }.font(.caption).foregroundStyle(.secondary)
        }
        // A new period (custom dates, a refreshed report) or zoom keeps the view on data: a position left over from
        // the previous period would query bins outside the new one and draw an empty chart.
        .onChange(of: zoom) { _, _ in position = NativeChartSampling.clampedPosition(position, window: window, domain: domain) }
        .onChange(of: domain) { _, value in position = NativeChartSampling.clampedPosition(position, window: window, domain: value) }
    }
    private var plot: some View {
        Chart {
            ForEach(visible) { point in
                switch style {
                case .line:
                    LineMark(x: .value("Time", point.date), y: .value(valueLabel, point.value))
                        .foregroundStyle(.mint).interpolationMethod(.linear)
                case .area:
                    AreaMark(x: .value("Time", point.date), y: .value(valueLabel, point.value))
                        .foregroundStyle(LinearGradient(colors: [.mint.opacity(0.6), .mint.opacity(0.04)],
                            startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("Time", point.date), y: .value(valueLabel, point.value)).foregroundStyle(.mint)
                case .bars:
                    BarMark(x: .value("Time", point.date), y: .value(valueLabel, point.value)).foregroundStyle(.mint)
                }
            }
            if visible.count == 1, let point = visible.first {
                PointMark(x: .value("Time", point.date), y: .value(valueLabel, point.value))
                    .foregroundStyle(.mint).symbolSize(36)
            }
            if let point = selectedPoint {
                RuleMark(x: .value("Selected time", point.date)).foregroundStyle(.secondary).lineStyle(StrokeStyle(dash: [3]))
            }
        }
        .chartXScale(domain: domain)
        .chartYScale(domain: 0...max(1, (visible.map(\.value).max() ?? 0) * 1.12))
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: window)
        .chartScrollPosition(x: $position)
        .chartXSelection(value: $selected)
        .chartOverlay { proxy in
            // The pan maps a drag across the plot area, not the whole chart with its Y axis.
            GeometryReader { geometry in
                let width = proxy.plotFrame.map { ceil(geometry[$0].size.width) } ?? ceil(geometry.size.width)
                Color.clear.allowsHitTesting(false)
                    .onChange(of: width, initial: true) { _, value in plotWidth = value }
            }
        }
        .simultaneousGesture(DragGesture(minimumDistance: 4)
            .updating($dragging) { _, state, _ in state = true }
            .onChanged { event in
                if panOrigin == nil { panOrigin = position }
                position = NativeChartSampling.pannedPosition(origin: panOrigin ?? position,
                    translation: event.translation.width, width: plotWidth, window: window, domain: domain)
                selected = nil
            })
        .onChange(of: dragging) { _, active in if !active { panOrigin = nil } }
        .chartYAxis { AxisMarks(position: .leading) }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) {
                AxisGridLine()
                AxisTick()
                AxisValueLabel(format: NativeChartSampling.axisLabelFormat(interval: interval, window: window))
            }
        }
        .accessibilityLabel("\(valueLabel) timeline. Scroll horizontally to pan; use the zoom controls to change the visible range.")
    }
}

public struct NativeHeatmapCell: Identifiable, Sendable {
    public let row: Int
    public let column: Int
    public let value: Double
    public var id: String { "\(row).\(column)" }
    public init(row: Int, column: Int, value: Double) { self.row = row; self.column = column; self.value = value }
}

public struct NativeMatrixHeatmap: View {
    private let rows: [String]
    private let columns: [String]
    private let cells: [NativeHeatmapCell]
    public init(rows: [String], columns: [String], cells: [NativeHeatmapCell]) {
        self.rows = rows; self.columns = columns; self.cells = cells
    }
    public var body: some View {
        let values = Dictionary(cells.map { ($0.id, $0.value) }, uniquingKeysWith: +)
        let peak = max(1, cells.map(\.value).max() ?? 0)
        Grid(horizontalSpacing: 3, verticalSpacing: 5) {
            GridRow {
                Color.clear.frame(width: 32, height: 12)
                ForEach(columns.indices, id: \.self) { column in
                    Text(column.isMultiple(of: 3) ? columns[column] : "")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                }
            }
            ForEach(rows.indices, id: \.self) { row in
                GridRow {
                    Text(rows[row]).font(.system(size: 10)).foregroundStyle(.secondary).frame(width: 32, alignment: .leading)
                    ForEach(columns.indices, id: \.self) { column in
                        let value = values["\(row).\(column)", default: 0]
                        let label = "\(rows[row]), \(columns[column]):00 · \(Int(value).formatted()) presses"
                        RoundedRectangle(cornerRadius: 3)
                            .fill(.mint.opacity(value == 0 ? 0.06 : 0.15 + 0.85 * pow(value / peak, 0.6)))
                            .frame(maxWidth: .infinity).frame(height: 23)
                            .help(label).accessibilityLabel(label)
                    }
                }
            }
        }
    }
}

public struct NativeCategoryValue: Identifiable {
    public let label: String
    public let value: Double
    public var id: String { label }
    public init(label: String, value: Double) { self.label = label; self.value = value }
}

public struct NativeCategoryChart: View {
    private let values: [NativeCategoryValue]
    public init(values: [NativeCategoryValue]) { self.values = values }
    public var body: some View {
        Chart(values) { point in
            BarMark(x: .value("Presses", point.value), y: .value("Category", point.label), height: .fixed(12))
                .foregroundStyle(.mint.gradient).cornerRadius(4)
                .annotation(position: .trailing) { Text(Int(point.value).formatted()).font(.caption2).foregroundStyle(.secondary) }
        }
        .chartXAxis { AxisMarks(position: .bottom) }
        .frame(height: CGFloat(max(1, values.count)) * 25 + 25)
        .padding(.trailing, 35)
    }
}
