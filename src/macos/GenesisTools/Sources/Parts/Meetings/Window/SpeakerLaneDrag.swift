import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers

/// A drag belongs to one rendered lane group, so another window or an external text drop cannot assign its data.
struct SpeakerLaneDrag: Codable, Equatable {
    static let type = UTType(exportedAs: "tools.genesis.meetings.speaker-stretch")
    let owner: UUID
    let label: String
    let fromSec: Double
    let toSec: Double

    /// Recheck the source against the current lanes after the drag. A refresh may have removed its span meanwhile.
    func stretch(owner: UUID, target: String, speakers: [MeetingsAPI.MeetingSpeakers.Speaker]) -> DecisionAction.Stretch? {
        guard self.owner == owner, !label.isEmpty, !target.isEmpty, label != target,
              fromSec.isFinite, toSec.isFinite, fromSec >= 0, toSec >= fromSec,
              speakers.contains(where: { $0.label == target }),
              let source = speakers.first(where: { $0.label == label }),
              source.talkSpans.contains(where: { $0.fromSec == fromSec }),
              source.talkSpans.contains(where: { $0.toSec == toSec }) else { return nil }
        return .init(label: label, fromSec: fromSec, toSec: toSec)
    }
}

/// One input view per lane. Capture the source on mouse-down, before AppKit exits hover for a drag.
struct SpeakerLaneInteraction: NSViewRepresentable {
    let blocks: [TalkTimeBlock]
    let owner: UUID
    let label: String
    let name: String
    let canAssign: Bool
    let click: (TalkTimeBlock) -> Void
    let canDrop: (SpeakerLaneDrag) -> Bool
    let drop: (SpeakerLaneDrag) -> Bool
    let targeting: (Bool) -> Void

    func makeNSView(context: Context) -> InputView { InputView() }

    func updateNSView(_ view: InputView, context: Context) {
        view.blocks = blocks
        view.owner = owner
        view.label = label
        view.name = name
        view.canAssign = canAssign
        view.click = click
        view.canDrop = canDrop
        view.drop = drop
        view.targeting = targeting
        view.registerForDraggedTypes([.init(SpeakerLaneDrag.type.identifier)])
    }

    final class InputView: NSView, NSDraggingSource {
        var blocks: [TalkTimeBlock] = []
        var owner = UUID()
        var label = ""
        var name = ""
        var canAssign = false
        var click: (TalkTimeBlock) -> Void = { _ in }
        var canDrop: (SpeakerLaneDrag) -> Bool = { _ in false }
        var drop: (SpeakerLaneDrag) -> Bool = { _ in false }
        var targeting: (Bool) -> Void = { _ in }
        private var pressed: (block: TalkTimeBlock, point: NSPoint)?
        private var dragging = false
        override var isFlipped: Bool { true }
        override var acceptsFirstResponder: Bool { false }

        override func mouseDown(with event: NSEvent) {
            let point = convert(event.locationInWindow, from: nil)
            pressed = TalkTimeLayout.block(at: point.x, in: blocks).map { ($0, point) }
            dragging = false
        }

        override func mouseDragged(with event: NSEvent) {
            guard canAssign, !dragging, let pressed else { return }
            let point = convert(event.locationInWindow, from: nil)
            guard hypot(point.x - pressed.point.x, point.y - pressed.point.y) >= 4 else { return }
            let payload = SpeakerLaneDrag(owner: owner, label: label,
                                          fromSec: pressed.block.fromSec, toSec: pressed.block.toSec)
            guard let data = try? JSONEncoder().encode(payload) else { return }
            let item = NSPasteboardItem()
            item.setData(data, forType: .init(SpeakerLaneDrag.type.identifier))
            let drag = NSDraggingItem(pasteboardWriter: item)
            let title = "\(name) · \(MeetingsFormat.clock(payload.fromSec))–\(MeetingsFormat.clock(payload.toSec))"
            let text = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: 12),
                                                                      .foregroundColor: NSColor.labelColor])
            let size = NSSize(width: text.size().width + 16, height: 28)
            let image = NSImage(size: size, flipped: true) { rect in
                NSColor.windowBackgroundColor.setFill()
                NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
                text.draw(at: NSPoint(x: 8, y: 6))
                return true
            }
            drag.setDraggingFrame(NSRect(origin: pressed.point, size: size), contents: image)
            dragging = true
            beginDraggingSession(with: [drag], event: event, source: self)
        }

        override func mouseUp(with event: NSEvent) {
            defer { pressed = nil; dragging = false }
            let point = convert(event.locationInWindow, from: nil)
            if !dragging, let pressed, hypot(point.x - pressed.point.x, point.y - pressed.point.y) < 4 {
                click(pressed.block)
            }
        }

        func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
            context == .withinApplication ? .move : []
        }

        func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
            pressed = nil
            dragging = false
        }

        private func payload(_ sender: NSDraggingInfo) -> SpeakerLaneDrag? {
            guard let data = sender.draggingPasteboard.data(forType: .init(SpeakerLaneDrag.type.identifier)) else { return nil }
            return try? JSONDecoder().decode(SpeakerLaneDrag.self, from: data)
        }

        override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
            let valid = payload(sender).map(canDrop) ?? false
            targeting(valid)
            return valid ? .move : []
        }

        override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { draggingEntered(sender) }

        override func draggingExited(_ sender: NSDraggingInfo?) { targeting(false) }

        override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
            defer { targeting(false) }
            guard let value = payload(sender), canDrop(value) else { return false }
            return drop(value)
        }

        func ignoreModifierKeys(for session: NSDraggingSession) -> Bool { true }
    }
}
