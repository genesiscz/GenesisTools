import SwiftUI

// Skeletons: what a view shows while it loads from nothing, shaped like the result, instead of a spinner
// in the middle of an empty pane (Martin, 2026-10-02: "instead of the centered loaders when loading
// from 0 … a nice skeleton which should be looking very similar to what is the result").
//
// - `SkeletonBar` is one grey block; everything else is bars laid out like the real view.
// - `.skeletonShimmer()` goes on the whole skeleton once, never per bar: one moving highlight masked by
//   the bars, still under Reduce Motion.
// - Widths come from a fixed pattern (`SkeletonPattern`), so a skeleton looks like text and never
//   changes between two renders.
// - A skeleton is one accessibility element that says what is loading.

/// One grey block standing in for a line of text, an icon or a chip.
public struct SkeletonBar: View {
    let width: CGFloat?
    let height: CGFloat
    let radius: CGFloat

    /// `width` nil fills the row.
    public init(width: CGFloat? = nil, height: CGFloat = 9, radius: CGFloat = 3) {
        self.width = width
        self.height = height
        self.radius = radius
    }

    public var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Color.white.opacity(0.075))
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

/// Text-like widths: a fraction of the room for line `index` of a block seeded by `seed`.
public enum SkeletonPattern {
    private static let fractions: [CGFloat] = [0.92, 0.78, 0.97, 0.64, 0.86, 0.71, 0.95, 0.58, 0.82, 0.9, 0.67, 0.88]

    public static func fraction(_ index: Int, seed: Int = 0) -> CGFloat {
        fractions[(index + seed * 5) % fractions.count]
    }
}

/// A paragraph: `count` lines, the last one shorter.
public struct SkeletonLines: View {
    let count: Int
    let seed: Int
    let lineHeight: CGFloat
    let spacing: CGFloat

    public init(count: Int = 3, seed: Int = 0, lineHeight: CGFloat = 9, spacing: CGFloat = 7) {
        self.count = count
        self.seed = seed
        self.lineHeight = lineHeight
        self.spacing = spacing
    }

    public var body: some View {
        GeometryReader { geo in
            VStack(alignment: .leading, spacing: spacing) {
                ForEach(0..<count, id: \.self) { index in
                    let fraction = index == count - 1 && count > 1 ? 0.45 : SkeletonPattern.fraction(index, seed: seed)
                    SkeletonBar(width: geo.size.width * fraction, height: lineHeight)
                }
            }
        }
        .frame(height: CGFloat(count) * lineHeight + CGFloat(max(0, count - 1)) * spacing)
    }
}

/// List rows: an optional leading dot or avatar, a title and a dimmer second line, like a sidebar list.
public struct SkeletonRows: View {
    let count: Int
    let leading: Leading
    let subtitle: Bool
    let rowHeight: CGFloat

    public enum Leading {
        case none, dot, avatar
    }

    public init(count: Int = 8, leading: Leading = .none, subtitle: Bool = true, rowHeight: CGFloat? = nil) {
        self.count = count
        self.leading = leading
        self.subtitle = subtitle
        self.rowHeight = rowHeight ?? (subtitle ? 44 : 26)
    }

    public var body: some View {
        GeometryReader { geo in
            VStack(alignment: .leading, spacing: 0) {
                ForEach(0..<count, id: \.self) { index in
                    HStack(alignment: .center, spacing: 9) {
                        switch leading {
                        case .none: EmptyView()
                        case .dot: SkeletonBar(width: 8, height: 8, radius: 4)
                        case .avatar: SkeletonBar(width: 18, height: 18, radius: 5)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            SkeletonBar(width: (geo.size.width - 40) * SkeletonPattern.fraction(index), height: 10)
                            if subtitle {
                                SkeletonBar(width: (geo.size.width - 40) * SkeletonPattern.fraction(index + 3) * 0.55, height: 7)
                            }
                        }
                    }
                    .frame(height: rowHeight, alignment: .center)
                    .padding(.horizontal, 12)
                }
            }
        }
        .frame(height: CGFloat(count) * rowHeight)
    }
}

/// A transcript loading: a prompt bubble on the right, a reply paragraph, a few tool rows, twice.
public struct TranscriptSkeleton: View {
    let turns: Int

    public init(turns: Int = 3) {
        self.turns = turns
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            ForEach(0..<turns, id: \.self) { turn in
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Spacer(minLength: 80)
                        VStack(alignment: .leading, spacing: 6) {
                            SkeletonBar(width: 220 - CGFloat(turn * 30), height: 9)
                            SkeletonBar(width: 140 + CGFloat(turn * 20), height: 9)
                        }
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.035)))
                    }
                    ForEach(0..<(turn == 1 ? 3 : 2), id: \.self) { tool in
                        HStack(spacing: 8) {
                            SkeletonBar(width: 7, height: 7, radius: 3.5)
                            SkeletonBar(width: 48, height: 9)
                            SkeletonBar(width: 120 + CGFloat((tool * 47 + turn * 31) % 160), height: 9)
                            Spacer(minLength: 0)
                        }
                    }
                    SkeletonLines(count: 3 + turn % 2, seed: turn)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .padding(.top, 16)
        .skeletonShimmer()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading transcript")
    }
}

/// A diff loading: per file a header bar, then code lines with a gutter, some marked added or removed.
public struct DiffSkeleton: View {
    let files: Int

    public init(files: Int = 2) {
        self.files = files
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(0..<files, id: \.self) { file in
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        SkeletonBar(width: 12, height: 12, radius: 3)
                        SkeletonBar(width: 210 - CGFloat(file * 40), height: 10)
                        Spacer(minLength: 0)
                        SkeletonBar(width: 54, height: 9)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 32)
                    .background(Color.white.opacity(0.03))
                    GeometryReader { geo in
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(0..<9, id: \.self) { line in
                                let tint: Color? = (line + file) % 5 == 2 ? .green : (line + file) % 7 == 4 ? .red : nil
                                HStack(spacing: 10) {
                                    SkeletonBar(width: 22, height: 8)
                                    SkeletonBar(width: max(40, (geo.size.width - 60) * SkeletonPattern.fraction(line, seed: file) * 0.8), height: 8)
                                }
                                .padding(.vertical, 2)
                                .padding(.horizontal, 10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(tint.map { $0.opacity(0.07) } ?? .clear)
                            }
                        }
                        .padding(.vertical, 8)
                    }
                    .frame(height: 9 * 12 + 8 * 6 + 16)
                }
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.06)))
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .skeletonShimmer()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading the diff")
    }
}

/// A detail pane loading: a title and a meta line, then two paragraphs.
public struct PaneSkeleton: View {
    let label: String

    public init(_ label: String = "Loading") {
        self.label = label
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SkeletonBar(width: 260, height: 14, radius: 4)
            HStack(spacing: 8) {
                SkeletonBar(width: 70, height: 9)
                SkeletonBar(width: 110, height: 9)
                SkeletonBar(width: 50, height: 9)
            }
            SkeletonLines(count: 4, seed: 1)
                .padding(.top, 6)
            SkeletonLines(count: 3, seed: 2)
            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .skeletonShimmer()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// One highlight that sweeps across the skeleton under it, masked by its bars.
struct SkeletonShimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .overlay {
                if !reduceMotion {
                    GeometryReader { geo in
                        LinearGradient(colors: [.clear, Color.white.opacity(0.07), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: max(120, geo.size.width * 0.45))
                            .offset(x: -geo.size.width * 0.5 + phase * geo.size.width * 1.5)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
            }
            // Follows Reduce Motion while shown: turned on, the sweep stops; turned off, it starts again.
            .onChange(of: reduceMotion, initial: true) { _, reduced in
                if reduced {
                    withAnimation(.linear(duration: 0)) { phase = 0 }
                } else {
                    phase = 0
                    withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) {
                        phase = 1
                    }
                }
            }
    }
}

extension View {
    /// A moving highlight over a skeleton (`SkeletonBar` and friends). Put it on the whole skeleton once.
    public func skeletonShimmer() -> some View {
        modifier(SkeletonShimmer())
    }
}
