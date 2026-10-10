import SwiftUI

/// A segmented choice that looks the same in every window.
///
/// The native segmented `Picker` draws its selected segment in the accent colour only while its window is
/// key, and grey otherwise. The widget's top and side panels are separate non-activating panels, so the
/// same tabs showed blue in one and grey in the other. Here the selected segment always has the accent
/// fill. Each segment is a real button with the row hover and the pointing-hand cursor.
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

    public init(_ label: String, items: [Item], selection: Binding<ID>, minSegmentWidth: CGFloat = 72) {
        self.label = label
        self.items = items
        _selection = selection
        self.minSegmentWidth = minSegmentWidth
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.id) { item in
                let selected = item.id == selection
                Button {
                    selection = item.id
                } label: {
                    Text(item.title)
                        .font(.system(size: 12, weight: selected ? .semibold : .medium))
                        .lineLimit(1)
                        .foregroundStyle(selected ? Color.white : Color.white.opacity(0.68))
                        .padding(.horizontal, 10)
                        .frame(minWidth: minSegmentWidth, minHeight: 24)
                        .background(selected ? Color.accentColor : .clear, in: RoundedRectangle(cornerRadius: 6))
                        .contentShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(RowButtonStyle(cornerRadius: 6))
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}
