import SwiftUI

/// The polyline of a sparkline as a `Shape`, so it diffs like any shape and costs nothing while the values do not
/// change. `range` fixes the vertical scale (0...peak for counts); nil fits the values' own minimum and maximum.
public struct SparklinePath: Shape {
    public var values: [Double]
    public var range: ClosedRange<Double>?

    public init(values: [Double], range: ClosedRange<Double>? = nil) {
        self.values = values
        self.range = range
    }

    public func path(in rect: CGRect) -> Path {
        var path = Path()
        let points = Self.points(values, range: range, in: rect)
        guard let first = points.first else { return path }
        path.move(to: first)
        for point in points.dropFirst() { path.addLine(to: point) }
        return path
    }

    /// The vertical bounds the values are drawn against.
    static func bounds(_ values: [Double], range: ClosedRange<Double>?) -> (Double, Double) {
        if let range { return (range.lowerBound, range.upperBound) }
        let finite = values.filter(\.isFinite)
        let low = finite.min() ?? 0
        let high = finite.max() ?? 1
        return low == high ? (low - 1, high + 1) : (low, high)
    }

    /// One point per value, spread evenly across `rect`, higher values nearer the top. One value is a flat line.
    static func points(_ values: [Double], range: ClosedRange<Double>?, in rect: CGRect) -> [CGPoint] {
        guard !values.isEmpty else { return [] }
        let (low, high) = bounds(values, range: range)
        let span = high - low
        func y(_ value: Double) -> CGFloat {
            let v = value.isFinite ? value : low
            let t = span > 0 ? (min(max(v, low), high) - low) / span : 0.5
            return rect.maxY - CGFloat(t) * rect.height
        }
        if values.count == 1 {
            return [CGPoint(x: rect.minX, y: y(values[0])), CGPoint(x: rect.maxX, y: y(values[0]))]
        }
        let step = rect.width / CGFloat(values.count - 1)
        return values.enumerated().map { index, value in CGPoint(x: rect.minX + CGFloat(index) * step, y: y(value)) }
    }
}

/// A small trend line over `values`: a rounded stroke, optionally a fill fading down from it, optionally dots at the
/// lowest and the highest point (the highest in the tint, the lowest in grey). Draws nothing for no values.
///
/// Accessibility reads the latest, lowest and highest value through `valueText` (for bytes,
/// `{ ByteFormat.file(Int64($0)) }`); without one, large numbers read compact ("1.2B"), never in exponent form.
/// Identifier: `identifier`, when given.
public struct Sparkline: View {
    private let values: [Double]
    private let tint: Color
    private let lineWidth: CGFloat
    private let fill: Bool
    private let showsExtrema: Bool
    private let range: ClosedRange<Double>?
    private let label: String?
    private let identifier: String?
    private let valueText: ((Double) -> String)?

    public init(
        values: [Double], tint: Color = .mint, lineWidth: CGFloat = 1.5, fill: Bool = false,
        showsExtrema: Bool = false, range: ClosedRange<Double>? = nil, label: String? = nil,
        identifier: String? = nil, valueText: ((Double) -> String)? = nil
    ) {
        self.values = values
        self.tint = tint
        self.lineWidth = lineWidth
        self.fill = fill
        self.showsExtrema = showsExtrema
        self.range = range
        self.label = label
        self.identifier = identifier
        self.valueText = valueText
    }

    public var body: some View {
        GeometryReader { proxy in
            // Keep the stroke and the dots inside the frame.
            let inset = max(lineWidth, showsExtrema ? 3 : 0)
            let rect = CGRect(origin: .zero, size: proxy.size).insetBy(dx: inset, dy: inset)
            ZStack {
                if fill, values.count > 1 {
                    SparklineArea(values: values, range: range, inset: inset)
                        .fill(LinearGradient(
                            colors: [tint.opacity(0.32), tint.opacity(0.0)], startPoint: .top, endPoint: .bottom))
                }
                SparklinePath(values: values, range: range)
                    .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                    .padding(inset)
                if showsExtrema, values.count > 1, let extrema = Self.extrema(values) {
                    let points = SparklinePath.points(values, range: range, in: rect)
                    Circle().fill(Color.white.opacity(0.55)).frame(width: 5, height: 5)
                        .position(points[extrema.min])
                    Circle().fill(tint).frame(width: 5, height: 5)
                        .overlay(Circle().strokeBorder(Color.black.opacity(0.35), lineWidth: 0.5))
                        .position(points[extrema.max])
                }
            }
        }
        .accessibilityElement()
        .accessibilityLabel(label ?? "Trend")
        .accessibilityValue(Self.summary(values, valueText: valueText))
        .chartAccessibilityIdentifier(identifier)
    }

    /// The indices of the first lowest and the last highest value.
    static func extrema(_ values: [Double]) -> (min: Int, max: Int)? {
        let finite = values.indices.filter { values[$0].isFinite }
        guard let first = finite.first else { return nil }
        var low = first
        var high = first
        for index in finite {
            if values[index] < values[low] { low = index }
            if values[index] >= values[high] { high = index }
        }
        return (low, high)
    }

    static func summary(_ values: [Double], valueText: ((Double) -> String)? = nil) -> String {
        let finite = values.filter(\.isFinite)
        guard let last = finite.last, let low = finite.min(), let high = finite.max() else { return "No data" }
        let text = valueText ?? number
        return "Latest \(text(last)), lowest \(text(low)), highest \(text(high))"
    }

    /// A number as speech-friendly text: compact for large values ("1.2B"), at most two decimals otherwise.
    static func number(_ value: Double) -> String {
        abs(value) >= 10_000
            ? value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)))
            : value.formatted(.number.precision(.fractionLength(0...2)))
    }
}

/// The area under a sparkline, down to the bottom of the frame.
struct SparklineArea: Shape {
    let values: [Double]
    let range: ClosedRange<Double>?
    let inset: CGFloat

    func path(in rect: CGRect) -> Path {
        let inner = rect.insetBy(dx: inset, dy: inset)
        let points = SparklinePath.points(values, range: range, in: inner)
        guard let first = points.first, let last = points.last else { return Path() }
        var path = Path()
        path.move(to: CGPoint(x: first.x, y: rect.maxY))
        for point in points { path.addLine(to: point) }
        path.addLine(to: CGPoint(x: last.x, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

extension View {
    /// Sets the identifier only when there is one: an empty identifier would replace one the caller set outside.
    /// `package`: the charts in GenesisKitCharts use it too.
    @ViewBuilder
    package func chartAccessibilityIdentifier(_ identifier: String?) -> some View {
        if let identifier { accessibilityIdentifier(identifier) } else { self }
    }
}
