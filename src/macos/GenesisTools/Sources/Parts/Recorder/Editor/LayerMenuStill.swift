import AppKit
import SwiftUI

private enum SnapshotLayerMenuKey: EnvironmentKey { static let defaultValue: String? = nil }

extension EnvironmentValues {
    var snapshotLayerMenu: String? {
        get { self[SnapshotLayerMenuKey.self] }
        set { self[SnapshotLayerMenuKey.self] = newValue }
    }
}

/// A context menu normally belongs to a separate tracking window. For an offscreen picture, draw its
/// actual commands in the editor's window, anchored to the row, without starting menu tracking.
struct LayerMenuStill: PreferenceKey {
    struct Menu {
        let bounds: Anchor<CGRect>
        let commands: AnyView
    }
    typealias Value = Menu?
    static var defaultValue: Value { nil }
    static func reduce(value: inout Value, nextValue: () -> Value) {
        if let next = nextValue() { value = next }
    }
}

extension View {
    @ViewBuilder func snapshotLayerMenu(_ id: String?) -> some View {
        if let id {
            environment(\.snapshotLayerMenu, id)
                .overlayPreferenceValue(LayerMenuStill.self) { menu in
                    if let menu {
                        GeometryReader { proxy in
                            let row = proxy[menu.bounds]
                            Group {
                                if #available(macOS 14.4, *) {
                                    NativeMenuStill(commands: menu.commands)
                                } else {
                                    VStack(alignment: .leading, spacing: 5) { menu.commands }
                                        .buttonStyle(.plain).padding(8)
                                }
                            }
                            .fixedSize()
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                            .shadow(radius: 5, y: 2)
                            .frameProbe("recorder.snapshot.layerMenu")
                            .offset(x: row.minX + 112, y: max(4, min(row.midY, proxy.size.height - 240)))
                        }
                    }
                }
        } else { self }
    }
}

@available(macOS 14.4, *)
private struct NativeMenuStill: NSViewRepresentable {
    let commands: AnyView
    func makeNSView(context: Context) -> MenuItems {
        let menu = NSHostingMenu(rootView: commands)
        menu.update()
        return MenuItems(menu)
    }
    func updateNSView(_ view: MenuItems, context: Context) {}

    /// The menu's items drawn by hand: the title, symbol and enabled state the hosting menu built, in the menu font.
    /// `NSMenuItemCell` drew only the separators outside a real menu window, so the picture showed an empty menu.
    final class MenuItems: NSView {
        private let hostingMenu: NSMenu
        let items: [NSMenuItem]
        private static let rowHeight: CGFloat = 22
        private static let separatorHeight: CGFloat = 9
        private static let textInset: CGFloat = 34
        init(_ menu: NSMenu) {
            hostingMenu = menu
            items = menu.items.filter { !$0.isHidden }
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { return nil }
        override var isFlipped: Bool { true }

        private func title(_ item: NSMenuItem) -> NSAttributedString {
            let color: NSColor = item.isEnabled ? .labelColor : .tertiaryLabelColor
            return NSAttributedString(string: item.title, attributes: [.font: NSFont.menuFont(ofSize: 0), .foregroundColor: color])
        }

        override var intrinsicContentSize: NSSize {
            let width = items.map { title($0).size().width }.max() ?? 0
            let height = items.reduce(CGFloat(10)) { $0 + ($1.isSeparatorItem ? Self.separatorHeight : Self.rowHeight) }
            return NSSize(width: max(160, width + Self.textInset + 20), height: height)
        }

        override func draw(_ dirtyRect: NSRect) {
            var y: CGFloat = 5
            for item in items {
                if item.isSeparatorItem {
                    NSColor.separatorColor.setFill()
                    NSRect(x: 12, y: y + Self.separatorHeight / 2, width: bounds.width - 24, height: 1).fill()
                    y += Self.separatorHeight
                    continue
                }
                if let image = item.image {
                    let side: CGFloat = 15
                    let symbol = image.withSymbolConfiguration(.init(pointSize: 13, weight: .regular)) ?? image
                    let color: NSColor = item.isEnabled ? .labelColor : .tertiaryLabelColor
                    // A template symbol draws black whatever the appearance; fill it with the text colour instead.
                    let tinted = NSImage(size: symbol.size, flipped: false) { area in
                        symbol.draw(in: area)
                        color.set()
                        area.fill(using: .sourceAtop)
                        return true
                    }
                    let rect = NSRect(x: 12, y: y + (Self.rowHeight - side) / 2, width: side, height: side)
                    tinted.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
                }
                let text = title(item)
                text.draw(at: NSPoint(x: Self.textInset, y: y + (Self.rowHeight - text.size().height) / 2))
                y += Self.rowHeight
            }
        }
    }
}
