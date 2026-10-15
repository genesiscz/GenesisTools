import SwiftUI

/// A segmented choice that looks the same in every window.
///
/// The native segmented `Picker` draws its selected segment in the accent colour only while its window is
/// key, and grey otherwise. The widget's top and side panels are separate non-activating panels, so the
/// same tabs showed blue in one and grey in the other. Here the selected segment always has the accent
/// fill. Each segment is a real button with a hover fill and the pointing-hand cursor.
///
/// One pill marks the selection. When the selection changes, the pill slides to the new segment and takes its width
/// on the `GenMotion` curve; under Reduce Motion it moves at once. The titles are drawn twice, in the ink outside the
/// pill and in white inside it, so a title is white exactly where the pill covers it while the pill moves. Only the
/// pill and the segment widths animate: what the selection switches belongs to the caller and changes at once.
public struct GenSegmentedTabs<ID: Hashable>: View {
    public struct Item {
        public let id: ID
        public let title: String
        public init(_ id: ID, _ title: String) {
            self.id = id
            self.title = title
        }
    }

    private let items: [Item]
    @Binding private var selection: ID
    private let label: String
    private let minSegmentWidth: CGFloat
    /// Light text on the dark panels it was made for, dark text in a light window (the markdown viewer's light theme).
    @Environment(\.colorScheme) private var scheme
    @GenReduceMotion private var reduceMotion
    private var ink: Color { scheme == .dark ? .white : .black }

    public init(_ label: String, items: [Item], selection: Binding<ID>, minSegmentWidth: CGFloat = 72) {
        self.label = label
        self.items = items
        _selection = selection
        self.minSegmentWidth = minSegmentWidth
    }

    public var body: some View {
        // The buttons: hit areas, hover fills and the frames the pill and the titles follow. Their own titles are
        // clear; the visible ones are the two layers above.
        HStack(spacing: 2) {
            ForEach(items, id: \.id) { item in
                segment(item)
            }
        }
        .padding(2)
        // One pill behind the segments, placed on the selected one's frame. A change of selection moves its frame,
        // and the animation below carries it there: it slides and reshapes rather than fading out and in.
        .backgroundPreferenceValue(GenSegmentFrames.self) { frames in
            pill(frames, fill: Color.accentColor)
        }
        .overlayPreferenceValue(GenSegmentFrames.self) { frames in
            ZStack {
                titles(ink.opacity(0.68))
                    .mask {
                        Rectangle()
                            .overlay { pill(frames, fill: .black).blendMode(.destinationOut) }
                            .compositingGroup()
                    }
                titles(.white)
                    .mask { pill(frames, fill: .black) }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .background(ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .animation(GenMotion.animation(expanding: true, reduceMotion: reduceMotion), value: selection)
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    private func segment(_ item: Item) -> some View {
        let selected = item.id == selection
        return Button {
            selection = item.id
        } label: {
            title(item, color: .clear)
                .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(GenSegmentStyle(selected: selected, ink: ink))
        .anchorPreference(key: GenSegmentFrames.self, value: .bounds) { [AnyHashable(item.id): $0] }
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// Every title in one colour, laid out exactly as the buttons are.
    private func titles(_ color: Color) -> some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.id) { item in
                title(item, color: color)
            }
        }
        .padding(2)
    }

    private func title(_ item: Item, color: Color) -> some View {
        Text(item.title)
            .font(.system(size: 12, weight: item.id == selection ? .semibold : .medium))
            .lineLimit(1)
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .frame(minWidth: minSegmentWidth, minHeight: 24)
    }

    /// The pill on the selected segment's frame, in the space of the view it decorates.
    private func pill(_ frames: [AnyHashable: Anchor<CGRect>], fill: Color) -> some View {
        GeometryReader { proxy in
            if let anchor = frames[AnyHashable(selection)] {
                let frame = proxy[anchor]
                RoundedRectangle(cornerRadius: 6)
                    .fill(fill)
                    .frame(width: frame.width, height: frame.height)
                    .offset(x: frame.minX, y: frame.minY)
            }
        }
    }
}

/// Each segment's frame, for the one pill.
private struct GenSegmentFrames: PreferenceKey {
    static var defaultValue: [AnyHashable: Anchor<CGRect>] { [:] }

    static func reduce(value: inout [AnyHashable: Anchor<CGRect>], nextValue: () -> [AnyHashable: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

/// A segment: the hover fill and the pressed fill of the row style on an unselected segment (in the window's ink,
/// so a light window shows it too), none on the selected one, which the pill marks.
private struct GenSegmentStyle: ButtonStyle {
    let selected: Bool
    let ink: Color

    func makeBody(configuration: Configuration) -> some View {
        GenSegmentBody(configuration: configuration, selected: selected, ink: ink)
    }
}

private struct GenSegmentBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let ink: Color
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @GenReduceMotion private var reduceMotion

    var body: some View {
        configuration.label
            .background(RoundedRectangle(cornerRadius: 6).fill(ink.opacity(fill)))
            .pointerCursor(isEnabled)
            .onHover { inside in
                let next = isEnabled && inside
                guard next != hovering else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) { hovering = next }
            }
            // A segment that leaves the screen under a still pointer gets no exit event.
            .onDisappear { hovering = false }
    }

    /// The row style's values (white 5.5 % on hover, 10 % pressed), so the dark panels look as they did.
    private var fill: Double {
        if selected { return 0 }
        if configuration.isPressed { return 0.10 }
        return hovering ? 0.055 : 0
    }
}
