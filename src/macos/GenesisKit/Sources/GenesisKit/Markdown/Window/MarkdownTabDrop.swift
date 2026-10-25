//
//  MarkdownTabDrop.swift
//  GenesisKit
//
//  Drag and drop in the tab bar. The half of a tab or a group chip under the pointer says where a drop lands
//  (before or after it), and a line on that edge shows it before the drop. A tab held over a chip goes into the
//  group, and the chip lights up instead.
//

import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Where a drop on a tab or a chip lands.
enum MarkdownTabDropSide: Equatable {
    case before, after, into
}

extension MarkdownTabDrag {
    /// What the drag in flight carries. A drop target cannot read the payload before the drop, so the source
    /// records it when the drag starts; the drop itself still reads the real payload.
    @MainActor static var active: MarkdownTabDrag?

    /// The payload of a drag that starts now (`.draggable` evaluates it at the start of the drag).
    @MainActor static func begin(_ drag: MarkdownTabDrag) -> String {
        active = drag
        switch drag {
        case .tab(let id): return tab(id)
        case .group(let id): return group(id)
        }
    }

    /// The side a drop at `x` lands on, in a target `width` wide. `chip`: a tab held over a chip goes into it.
    static func side(x: CGFloat, width: CGFloat, chip: Bool, dragging: MarkdownTabDrag?) -> MarkdownTabDropSide {
        if chip, case .tab = dragging { return .into }
        return x < width / 2 ? .before : .after
    }
}

/// One drop target: a tab or a group chip. It reports the side under the pointer while a drag moves over it.
struct MarkdownTabDropDelegate: DropDelegate {
    let width: CGFloat
    let chip: Bool
    @Binding var side: MarkdownTabDropSide?
    let perform: @MainActor (MarkdownTabDrag, MarkdownTabDropSide) -> Void

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [.utf8PlainText, .plainText])
    }

    func dropEntered(info: DropInfo) {
        update(info)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        update(info)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        side = nil
    }

    func performDrop(info: DropInfo) -> Bool {
        let x = info.location.x
        let landing = side ?? MarkdownTabDrag.side(x: x, width: width, chip: chip, dragging: nil)
        side = nil
        guard let provider = info.itemProviders(for: [.utf8PlainText, .plainText]).first else { return false }
        _ = provider.loadObject(ofClass: String.self) { text, _ in
            guard let text, let drag = MarkdownTabDrag.parse(text) else { return }
            Task { @MainActor [chip, width, perform] in
                // A tab on a chip goes in; the side was guessed from the recorded drag, so read it again here.
                let resolved: MarkdownTabDropSide = chip
                    ? MarkdownTabDrag.side(x: x, width: width, chip: true, dragging: drag)
                    : landing
                MarkdownTabDrag.active = nil
                perform(drag, resolved)
            }
        }
        return true
    }

    private func update(_ info: DropInfo) {
        let next = MarkdownTabDrag.side(
            x: info.location.x, width: width, chip: chip, dragging: MarkdownTabDrag.active)
        if side != next { side = next }
    }
}

extension View {
    /// The insertion line on the edge a drop would land on; nothing for `.into` or no drag.
    func markdownTabDropLine(_ side: MarkdownTabDropSide?) -> some View {
        overlay(alignment: side == .after ? .trailing : .leading) {
            if side == .before || side == .after {
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: 3)
                    .padding(.vertical, 2)
                    .offset(x: side == .after ? 3 : -3)
                    .allowsHitTesting(false)
            }
        }
    }
}
