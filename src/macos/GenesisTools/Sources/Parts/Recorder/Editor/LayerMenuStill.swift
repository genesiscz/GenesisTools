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
    func makeNSView(context: Context) -> MenuCells {
        let menu = NSHostingMenu(rootView: commands)
        menu.update()
        return MenuCells(menu)
    }
    func updateNSView(_ view: MenuCells, context: Context) {}

    final class MenuCells: NSView {
        let menu: NSMenu
        let cells: [NSMenuItemCell]
        init(_ menu: NSMenu) {
            self.menu = menu
            cells = menu.items.filter { !$0.isHidden }.map { item in
                let cell = NSMenuItemCell(textCell: item.title)
                cell.menuItem = item
                cell.isEnabled = item.isEnabled
                cell.font = .menuFont(ofSize: 0)
                return cell
            }
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { return nil }
        override var isFlipped: Bool { true }
        override var intrinsicContentSize: NSSize {
            let width = cells.map { $0.cellSize.width }.max() ?? 0
            return NSSize(width: max(160, width + 30),
                          height: cells.reduce(CGFloat(10)) { $0 + ($1.menuItem?.isSeparatorItem == true ? 8 : 22) })
        }
        override func draw(_ dirtyRect: NSRect) {
            var y: CGFloat = 5
            for cell in cells {
                let separator = cell.menuItem?.isSeparatorItem == true
                let frame = CGRect(x: 8, y: y, width: bounds.width - 16, height: separator ? 8 : 22)
                cell.draw(withFrame: frame, in: self)
                y += frame.height
            }
        }
    }
}
