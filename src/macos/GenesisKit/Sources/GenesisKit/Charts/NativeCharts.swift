import Charts
import SwiftUI

public struct NativeTimePoint: Identifiable, Equatable, Sendable {
    public var date: Date
    public var value: Double
    /// The denominator behind a rate. Counts ignore it; averages preserve it when bins merge.
    public var weight: Double
    public var id: Date { date }
    public init(date: Date, value: Double, weight: Double = 1) { self.date = date; self.value = value; self.weight = weight }
}

public enum NativeChartSampling {
    static func zoomFraction(_ zoom: Double, minimum: Double, maximum: Double) -> Double {
        guard maximum > minimum else { return 0 }
        return min(1, max(0, log(max(1, zoom / minimum)) / log(maximum / minimum)))
    }

    /// Grouped points may start before the picked interval, such as its first partial week.
    static func fittedStart(_ start: Date, firstPoint: Date?) -> Date {
        min(start, firstPoint ?? start)
    }

    public static func pannedPosition(origin: Date, translation: Double, width: Double,
        window: TimeInterval, domain: ClosedRange<Date>) -> Date {
        clampedPosition(origin.addingTimeInterval(-translation / max(1, width) * window), window: window, domain: domain)
    }

    /// A chart value as a reader sees it: estimated words and seconds are fractional, so one decimal survives
    /// (0.8 words stays 0.8, not 0); a whole count prints without one.
    public static func valueText(_ value: Double, locale: Locale = .current) -> String {
        value.formatted(.number.precision(.fractionLength(0...1)).locale(locale))
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

    /// How a bin combines the points that fall into it: counts add up, rates and shares average.
    public enum Combine: Sendable { case sum, average }

    /// A calendar bin (a day or a week) follows the calendar: weeks start on the user's first weekday and a day
    /// can be 23 or 25 hours long. Every other step is a fixed grid.
    static func calendarComponent(for step: TimeInterval) -> Calendar.Component? {
        step == 86400 ? .day : step == 604800 ? .weekOfYear : nil
    }

    /// The width of one drawn bin: `step`, or a multiple of it when the span would need more than 1,200 bins.
    public static func binInterval(start: Date, end: Date, step: TimeInterval) -> TimeInterval {
        if calendarComponent(for: step) != nil { return step }
        return max(step, ceil(end.timeIntervalSince(start) / (step * 1200)) * step)
    }

    /// The span a bin covers, as a reader names it: "Mon, Oct 19 to Sun, Oct 25", "Mon, Oct 19, 2026",
    /// "Oct 19, 14:00 to 15:00".
    public static func spanText(_ date: Date, step: TimeInterval, calendar: Calendar = .current) -> String {
        let day = Date.FormatStyle.dateTime.weekday(.abbreviated).month(.abbreviated).day()
        if step >= 604800 {
            let days = max(1, Int((step / 86400).rounded()))
            let last = calendar.date(byAdding: .day, value: days - 1, to: date) ?? date
            return "\(date.formatted(day)) to \(last.formatted(day))"
        }
        if step >= 86400 { return date.formatted(day.year()) }
        let end = date.addingTimeInterval(step)
        return "\(date.formatted(.dateTime.month(.abbreviated).day().hour().minute())) to \(end.formatted(.dateTime.hour().minute()))"
    }

    public static func bins(points: [NativeTimePoint], start: Date, end: Date, step: TimeInterval,
        calendar: Calendar = .current, combine: Combine = .sum) -> [NativeTimePoint] {
        guard let first = points.first, end > start, step > 0 else { return [] }
        if let component = calendarComponent(for: step) {
            func key(_ date: Date) -> Date {
                component == .day ? calendar.startOfDay(for: date)
                    : calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? calendar.startOfDay(for: date)
            }
            var cursor = key(max(first.date, start))
            var sums: [Date: Double] = [:]
            var counts: [Date: Double] = [:]
            for point in points where point.date >= cursor && point.date < end {
                let bin = key(point.date)
                let weight = combine == .average ? max(0, point.weight) : 1
                sums[bin, default: 0] += point.value * weight
                counts[bin, default: 0] += weight
            }
            var result: [NativeTimePoint] = []
            var visited = 0
            while cursor < end && visited < 1201 {
                visited += 1
                if let count = counts[cursor], count > 0 {
                    let sum = sums[cursor, default: 0]
                    result.append(NativeTimePoint(date: cursor, value: combine == .sum ? sum : sum / count,
                        weight: combine == .average ? count : 1))
                } else if combine == .sum {
                    result.append(NativeTimePoint(date: cursor, value: 0))
                }
                guard let next = calendar.date(byAdding: component, value: 1, to: cursor), next > cursor else { break }
                cursor = next
            }
            return result
        }
        let interval = binInterval(start: start, end: end, step: step)
        // Both bounds on the same interval grid, so a bin's time and count do not depend on where the view starts.
        let lower = max(floor(first.date.timeIntervalSince1970 / interval), floor(start.timeIntervalSince1970 / interval)) * interval
        let upper = end.timeIntervalSince1970
        guard lower < upper else { return [] }
        let count = min(1201, Int(ceil((upper - lower) / interval)))
        var values = Array(repeating: 0.0, count: count)
        var counts = Array(repeating: 0.0, count: count)
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
            if values.indices.contains(index) {
                let weight = combine == .average ? max(0, point.weight) : 1
                values[index] += point.value * weight
                counts[index] += weight
            }
        }
        return values.indices.compactMap { index in
            let date = Date(timeIntervalSince1970: lower + Double(index) * interval)
            switch combine {
            case .sum: return NativeTimePoint(date: date, value: values[index])
            case .average:
                return counts[index] > 0 ? NativeTimePoint(date: date, value: values[index] / counts[index], weight: counts[index]) : nil
            }
        }
    }
}

/// A pannable, zoomable time series. Two ways to open:
/// - `rangeStart: nil`: on the latest `initialWindow`, zoomable from a quarter to 8 times that window.
/// - `rangeStart` set: fitted to the whole `rangeStart...end`; zoom goes from that whole range down to 5 bins, and
///   "Whole range" returns to it.
public struct NativeTimeSeriesChart: View {
    public enum Style: String, CaseIterable, Identifiable, Sendable {
        case line = "Line", area = "Area", bars = "Bars"
        public var id: Self { self }
    }
    private let points: [NativeTimePoint]
    private let interval: TimeInterval
    private let initialWindow: TimeInterval
    private let valueLabel: String
    private let end: Date
    private let rangeStart: Date?
    private let combine: NativeChartSampling.Combine
    private let valueFormat: ((Double) -> String)?
    private let styleBinding: Binding<Style>?
    @State private var ownStyle: Style = .area
    @State private var zoom = 1.0
    @State private var position: Date
    @State private var selected: Date?
    @State private var panOrigin: Date?
    @State private var plotWidth: CGFloat = 1
    @GestureState private var dragging = false

    /// - Parameters:
    ///   - rangeStart: the start of the period the page shows; the chart opens fitted to `rangeStart...end`.
    ///   - combine: how wide views merge bins; `.average` for rates and shares, which must not add up.
    ///   - valueFormat: how a value reads in the hover text and on the Y axis ("1h 5m", "12.5%").
    ///   - style: where the Line, Area or Bars choice is kept; without it the choice lives as long as the view.
    public init(points: [NativeTimePoint], interval: TimeInterval, initialWindow: TimeInterval,
        end: Date = Date(), valueLabel: String = "Events", rangeStart: Date? = nil,
        combine: NativeChartSampling.Combine = .sum, valueFormat: ((Double) -> String)? = nil,
        style: Binding<Style>? = nil) {
        self.points = points
        self.interval = interval
        self.initialWindow = initialWindow
        self.valueLabel = valueLabel
        self.end = end
        self.rangeStart = rangeStart
        self.combine = combine
        self.valueFormat = valueFormat
        styleBinding = style
        let start = rangeStart.map {
            min(NativeChartSampling.fittedStart($0, firstPoint: points.first?.date), end.addingTimeInterval(-interval * 5))
        }
        _position = State(initialValue: start ?? end.addingTimeInterval(-initialWindow))
    }

    private var style: Binding<Style> { styleBinding ?? $ownStyle }
    private var fitted: Bool { rangeStart != nil }
    private var minimumWindow: TimeInterval { interval * 5 }
    /// The whole range in fitted mode.
    private var span: TimeInterval {
        guard let rangeStart else { return initialWindow }
        return max(minimumWindow, end.timeIntervalSince(NativeChartSampling.fittedStart(rangeStart, firstPoint: points.first?.date)))
    }
    private var maxZoom: Double { fitted ? max(1, span / minimumWindow) : 8 }
    private var minZoom: Double { fitted ? 1 : 0.25 }
    private var window: TimeInterval {
        fitted ? min(span, max(minimumWindow, span / zoom)) : max(minimumWindow, initialWindow / zoom)
    }
    private var domain: ClosedRange<Date> {
        if fitted { return end.addingTimeInterval(-span)...end }
        let first = points.first?.date ?? end.addingTimeInterval(-initialWindow)
        return min(first, end.addingTimeInterval(-window))...end
    }
    private var visibleStart: Date { max(domain.lowerBound, position.addingTimeInterval(-window / 4)) }
    private var visibleEnd: Date { min(end, position.addingTimeInterval(window * 1.25)) }
    private var visible: [NativeTimePoint] {
        NativeChartSampling.bins(points: points, start: visibleStart, end: visibleEnd, step: interval, combine: combine)
    }
    private var binWidth: TimeInterval {
        NativeChartSampling.binInterval(start: visibleStart, end: visibleEnd, step: interval)
    }
    private var selectedPoint: NativeTimePoint? {
        guard let selected else { return nil }
        return visible.min { abs($0.date.timeIntervalSince(selected)) < abs($1.date.timeIntervalSince(selected)) }
    }
    private func format(_ value: Double) -> String { valueFormat?(value) ?? NativeChartSampling.valueText(value) }
    /// The zoom on a log scale, so one slider spans "whole two years" to "five bins" evenly.
    private var zoomSlider: Binding<Double> {
        Binding(get: { NativeChartSampling.zoomFraction(zoom, minimum: minZoom, maximum: maxZoom) },
            set: { zoom = minZoom * pow(maxZoom / minZoom, $0) })
    }
    private func pan(by fraction: Double) {
        position = NativeChartSampling.clampedPosition(position.addingTimeInterval(window * fraction), window: window, domain: domain)
        selected = nil
    }
    private var shownSpan: String {
        let last = min(end, position.addingTimeInterval(window))
        let days = window >= 86400 * 2
        let first: Date.FormatStyle = days ? .dateTime.year().month(.abbreviated).day()
            : .dateTime.year().month(.abbreviated).day().hour().minute()
        let second: Date.FormatStyle = days ? .dateTime.year().month(.abbreviated).day()
            : .dateTime.month(.abbreviated).day().hour().minute()
        return "\(position.formatted(first)) to \(last.formatted(second))"
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Picker("Chart style", selection: style) {
                    ForEach(Style.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).labelsHidden().frame(width: 210, alignment: .leading)
                Spacer()
                IconButton(systemName: "chevron.left", tooltip: "Earlier (Left Arrow)") { pan(by: -0.5) }
                IconButton(systemName: "chevron.right", tooltip: "Later (Right Arrow)") { pan(by: 0.5) }
                IconButton(systemName: "minus.magnifyingglass", tooltip: "Zoom out chart") { zoom = max(minZoom, zoom / 2) }
                Slider(value: zoomSlider, in: 0...1).frame(width: 90).accessibilityLabel("Chart zoom")
                    .help("Chart zoom").disabled(maxZoom <= minZoom)
                IconButton(systemName: "plus.magnifyingglass", tooltip: "Zoom in chart") { zoom = min(maxZoom, zoom * 2) }
                if fitted {
                    Button("Whole range") {
                        zoom = 1
                        position = domain.lowerBound
                    }.buttonStyle(.genHover()).help("Show the whole selected range")
                        .disabled(zoom <= 1.0001)
                }
                Button("Latest") { position = max(domain.lowerBound, end.addingTimeInterval(-window)) }
                    .buttonStyle(.genHover()).help("Show the most recent part")
            }
            plot.frame(height: 235)
            HStack {
                if let point = selectedPoint {
                    Text("\(NativeChartSampling.spanText(point.date, step: binWidth)): \(format(point.value)) \(valueLabel.lowercased())")
                } else { Text("Drag, scroll or use the arrow keys to explore. Hover to inspect a value.") }
                Spacer()
                Text(shownSpan).monospacedDigit()
            }.font(.caption).foregroundStyle(.secondary)
        }
        // A new period (custom dates, a refreshed report) or zoom keeps the view on data: a position left over from
        // the previous period would query bins outside the new one and draw an empty chart.
        .onChange(of: zoom) { _, _ in position = NativeChartSampling.clampedPosition(position, window: window, domain: domain) }
        .onChange(of: domain) { _, value in position = NativeChartSampling.clampedPosition(position, window: window, domain: value) }
    }

    private var plot: some View {
        let shown = visible
        let peak = shown.map(\.value).max() ?? 0
        return Chart {
            ForEach(shown) { point in
                switch style.wrappedValue {
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
            if shown.count == 1, let point = shown.first {
                PointMark(x: .value("Time", point.date), y: .value(valueLabel, point.value))
                    .foregroundStyle(.mint).symbolSize(36)
            }
            if let point = selectedPoint {
                RuleMark(x: .value("Selected time", point.date)).foregroundStyle(.secondary).lineStyle(StrokeStyle(dash: [3]))
                    .annotation(position: .top, spacing: 0,
                        overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        Text(format(point.value)).font(.caption.weight(.semibold)).monospacedDigit()
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
                    }
            }
        }
        .chartXScale(domain: domain)
        .chartYScale(domain: 0...max(1, peak * 1.12))
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
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisTick()
                if let valueFormat {
                    AxisValueLabel { if let number = value.as(Double.self) { Text(valueFormat(number)) } }
                } else {
                    AxisValueLabel()
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) {
                AxisGridLine()
                AxisTick()
                AxisValueLabel(format: NativeChartSampling.axisLabelFormat(interval: interval, window: window))
            }
        }
        .focusable()
        .onKeyPress(.leftArrow) { pan(by: -0.25); return .handled }
        .onKeyPress(.rightArrow) { pan(by: 0.25); return .handled }
        .accessibilityLabel("\(valueLabel) timeline")
        .accessibilityValue("\(shownSpan). \(shown.count) bars, highest \(format(peak)). Use the arrow keys to move earlier or later.")
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
                        let label = "\(rows[row]), \(columns[column]):00 · \(NativeChartSampling.valueText(value)) presses"
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
                .annotation(position: .trailing) { Text(NativeChartSampling.valueText(point.value)).font(.caption2).foregroundStyle(.secondary) }
        }
        .chartXAxis { AxisMarks(position: .bottom) }
        .frame(height: CGFloat(max(1, values.count)) * 25 + 25)
        .padding(.trailing, 35)
    }
}
