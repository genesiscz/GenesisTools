import GenesisKit
import SwiftUI

/// Today's controls in a fixed layout, drawn only through the API they had before the looks existed. A change to
/// the kit that should not alter them is proved by drawing this before and after and comparing the two pictures
/// (`genesis-kit-catalog --probe <png>`).
public struct KitClassicProbe: View {
    public init() {}

    public static let width: CGFloat = 760

    private var tabs: [GenSegmentedTabs<String>.Item] {
        [.init("items", "Items"), .init("speakers", "Speakers"), .init("transcript", "Transcript"), .init("screen", "Screen")]
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                GenSegmentedTabs("Tabs", items: tabs, selection: .constant("items"))
                GenSegmentedTabs("Tabs, second selected", items: tabs, selection: .constant("speakers"), minSegmentWidth: 40)
            }
            HStack(spacing: 12) {
                GenSegmentedTabs("Tabs under the pointer", items: tabs, selection: .constant("items"))
                    .environment(\.kitForcedInteraction, .hover)
                GenSegmentedTabs("Tabs pressed", items: tabs, selection: .constant("items"))
                    .environment(\.kitForcedInteraction, .pressed)
            }
            GenSegmentedTabs("Tabs over a column", items: tabs, selection: .constant("transcript"), fillsWidth: true)
                .frame(width: 300)
            HStack(spacing: 10) {
                GhostButton("Open in last pane", symbol: "rectangle.split.2x1", tooltip: "Probe") {}
                GhostButton("Choose a pane", symbol: "rectangle.3.group", tooltip: "Probe", trailingSymbol: "chevron.down") {}
                    .environment(\.kitForcedInteraction, .hover)
                GhostButton("Show context", symbol: "text.alignleft", tooltip: "Probe") {}
                    .environment(\.kitForcedInteraction, .pressed)
                GhostButton("Disabled", symbol: "nosign", tooltip: "Probe") {}
                    .disabled(true)
            }
            GhostButton("One action per row", symbol: "arrow.up.forward.app", tooltip: "Probe", trailingSymbol: "chevron.right", fullWidth: true) {}
                .frame(width: 260)
            HStack(spacing: 14) {
                IconButton(systemName: "gearshape", tooltip: "Probe") {}
                IconButton(systemName: "gearshape", tooltip: "Probe") {}
                    .environment(\.kitForcedInteraction, .hover)
                IconButton(systemName: "gearshape", tooltip: "Probe") {}
                    .environment(\.kitForcedInteraction, .pressed)
                IconButton(systemName: "trash", tooltip: "Probe", tint: KitPalette.removed, accent: KitPalette.removed) {}
                    .environment(\.kitForcedInteraction, .hover)
                IconButton(systemName: "gearshape", tooltip: "Probe") {}
                    .disabled(true)
                IconButton(systemName: "gearshape", tooltip: "Probe", size: 15) {}
            }
            HStack(spacing: 10) {
                Button("Send now") {}.buttonStyle(.genPrimary())
                Button("Send now") {}.buttonStyle(.genPrimary())
                    .environment(\.kitForcedInteraction, .hover)
                Button("Send now") {}.buttonStyle(.genPrimary())
                    .environment(\.kitForcedInteraction, .pressed)
                Button("Send now") {}.buttonStyle(.genPrimary())
                    .disabled(true)
            }
            HStack(spacing: 10) {
                Button("Hover style") {}.buttonStyle(.genHover())
                Button("Hover style") {}.buttonStyle(.genHover())
                    .environment(\.kitForcedInteraction, .hover)
                Button("Hover style") {}.buttonStyle(.genHover())
                    .environment(\.kitForcedInteraction, .pressed)
                Button("Plain") {}.buttonStyle(.genHoverPlain())
                    .environment(\.kitForcedInteraction, .hover)
                Button { } label: { Text(verbatim: "A row").frame(width: 120, alignment: .leading).padding(6) }
                    .buttonStyle(.genHoverRow())
                    .environment(\.kitForcedInteraction, .hover)
            }
            HStack(spacing: 10) {
                Text(verbatim: "Row button").padding(.horizontal, 8).frame(height: 24).rowButton {}
                Text(verbatim: "Row button").padding(.horizontal, 8).frame(height: 24).rowButton {}
                    .environment(\.kitForcedInteraction, .hover)
                Text(verbatim: "Row button").padding(.horizontal, 8).frame(height: 24).rowButton {}
                    .environment(\.kitForcedInteraction, .pressed)
            }
            HStack(spacing: 10) {
                Badge("merged")
                Badge("OPEN", color: KitPalette.added, look: .tone)
                Badge("stuck", color: KitPalette.removed, look: .filled, symbol: "exclamationmark.triangle.fill")
                Badge("a1b2c3d", monospaced: true)
                CountBadge(3, tooltip: "Probe")
                CountBadge(12, tooltip: "Probe", color: KitPalette.modified)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.white)
        .padding(20)
        .frame(width: Self.width, alignment: .leading)
        .background(Color(nsColor: KitPalette.background))
        .environment(\.colorScheme, .dark)
    }
}
