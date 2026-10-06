import AppKit
import GenesisKit
import SwiftUI

struct RecastSourcePane: View {
    @ObservedObject var model: RecastModel
    var readOnly = false
    @State private var zoom = 1.0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(model.source?.name ?? "Your source").font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer()
                if !readOnly, let anchor = model.file?.anchors.first(where: { $0.id == model.selectedAnchor && $0.sourceId == model.selectedSource }) {
                    IconButton(systemName: "arrow.up.forward.square", tooltip: "Open evidence in a separate window") { model.detachEvidence(anchor) }
                }
                if model.pageCount > 1 {
                    IconButton(systemName: "chevron.left", tooltip: "Previous source page") { model.page -= 1 }.disabled(model.page <= 0)
                    Text("\(model.page + 1) / \(model.pageCount)").font(.system(size: 11)).monospacedDigit()
                    IconButton(systemName: "chevron.right", tooltip: "Next source page") { model.page += 1 }.disabled(model.page + 1 >= model.pageCount)
                }
            }.padding(12).hubSurface(.bar)
            if let source = model.source {
                if let error = source.error {
                    VStack(spacing: 12) {
                        EmptyState(symbol: "doc.badge.ellipsis", text: "Original preserved", detail: error)
                        if !readOnly, source.kind == "unsupported" {
                            Button("Attach original to field") { model.attachSelectedRegion() }
                                .buttonStyle(.genHoverPlain()).disabled(model.busy || model.evidenceScope == nil)
                            Text("This records the unreadable original, without claiming it supports an extracted value.")
                                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if source.kind == "text" {
                    RecastTextSurface(text: model.sourceText, offset: model.sourceTextOffset,
                        anchor: model.file?.anchors.first { $0.id == model.selectedAnchor && $0.sourceId == source.id },
                        selection: $model.textSelection)
                } else if source.kind == "image" || source.kind == "pdf" {
                    GeometryReader { geometry in
                        ScrollView([.horizontal, .vertical]) {
                            if let image = model.sourceImage {
                                RecastImageView(image: image, selection: $model.selectedRegion)
                                    .frame(width: max(200, geometry.size.width * zoom), height: max(200, geometry.size.height * zoom))
                            } else {
                                ProgressView("Loading source…").frame(width: geometry.size.width, height: geometry.size.height)
                            }
                        }
                    }
                    HStack {
                        Image(systemName: "minus.magnifyingglass")
                        Slider(value: $zoom, in: 1...3).accessibilityLabel("Source zoom").frame(maxWidth: 140)
                        Image(systemName: "plus.magnifyingglass")
                        Spacer()
                        Button("Whole page") { model.selectedRegion = nil }.buttonStyle(.genHoverPlain())
                    }.font(.system(size: 11)).padding(9)
                } else if source.kind == "audio" {
                    RecastAudioPane(model: model, audio: model.audio, readOnly: readOnly)
                } else {
                    EmptyState(symbol: "doc", text: "Original preserved", detail: "This source has no supported preview.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if !readOnly, ["image", "pdf", "text"].contains(source.kind), source.error == nil {
                    Divider()
                    Button("Select region…", systemImage: "viewfinder") { model.showRegionEditor = true }
                        .buttonStyle(.genHoverPlain()).font(.system(size: 11)).padding(.top, 8).disabled(model.busy || model.previewBusy)
                    HStack(spacing: 10) {
                        Button("Extract rows", systemImage: "text.viewfinder") { model.extractSelection(intoField: false) }.buttonStyle(.genHoverPlain())
                        Button("Read into field", systemImage: "arrow.right.square") { model.extractSelection(intoField: true) }.buttonStyle(.genHoverPlain())
                            .disabled(model.record == nil || model.field == nil)
                    }.font(.system(size: 12)).padding(10).disabled(model.busy || model.previewBusy)
                    Button("Read regions for comparison") {
                        model.extractSelection(intoField: false, createRows: false, openProposal: false)
                    }.buttonStyle(.genHoverPlain()).font(.system(size: 11)).padding(.bottom, 8).disabled(model.busy || model.previewBusy)
                    Button("Structure with AI…", systemImage: "sparkles") {
                        model.extractSelection(intoField: false, createRows: false)
                    }.buttonStyle(.genHoverPlain()).font(.system(size: 12)).padding(.bottom, 8).disabled(model.busy || model.previewBusy)
                    Text(source.kind == "text" ? "Select text, or extract this page." : "Drag to select an area, or extract the whole page.")
                        .font(.system(size: 10)).foregroundStyle(ReviewPalette.dim).padding(.bottom, 9)
                }
                if !readOnly {
                    if !(model.file?.readings.isEmpty ?? true) {
                        Button("Map saved readings…", systemImage: "sparkles") { model.openProposal() }
                            .buttonStyle(.genHoverPlain()).font(.system(size: 11)).padding(.vertical, 8).disabled(model.busy)
                    }
                    Button("Review replacement…", systemImage: "arrow.triangle.2.circlepath") {
                        model.reconciliationJobId = nil; model.reconciliationPreview = nil; model.showReconciliation = true
                    }.buttonStyle(.genHoverPlain()).font(.system(size: 11)).padding(.bottom, 9).disabled(model.busy || (model.file?.sources.count ?? 0) < 2)
                }
                if !model.sourceAnchors.isEmpty {
                    DisclosureGroup("Source regions (\(model.sourceAnchors.count))") {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(model.sourceAnchors) { anchor in
                                    Button { model.reveal(anchor) } label: {
                                        HStack {
                                            Text(anchor.label).lineLimit(1)
                                            Spacer()
                                            Text(anchor.region.description).foregroundStyle(ReviewPalette.dim).lineLimit(1)
                                        }.font(.system(size: 10)).padding(5)
                                    }.buttonStyle(RowButtonStyle())
                                        .draggable(RecastEvidenceLink(documentId: model.file?.id ?? "", revision: model.file?.revision ?? 0, anchorId: anchor.id))
                                        .help("Drag this source region onto a field to review an evidence link.")
                                }
                            }
                        }.frame(maxHeight: 110)
                    }.font(.system(size: 11)).padding(10)
                }
            } else {
                EmptyState(symbol: "doc.viewfinder", text: "Drop material you want to make usable", detail: "A screenshot, PDF, text file, or short recording. Your original stays beside the objects you create.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                Button("Import a source…") { model.chooseSources() }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                ForEach(RecastExample.allCases) { example in
                    Button(example.label) { model.openExample(example) }.buttonStyle(.genHoverPlain())
                        .disabled(model.busy || !(model.file?.records.isEmpty ?? true))
                }
                Text("Examples open as editable copies. Their readings still need review.")
                    .font(.system(size: 10)).foregroundStyle(ReviewPalette.dim).padding(.bottom, 24)
            }
        }
    }
}

private struct RecastImageView: NSViewRepresentable {
    var image: NSImage
    @Binding var selection: NativeSourceRect?
    func makeNSView(context: Context) -> RecastImageSurface { RecastImageSurface() }
    func updateNSView(_ view: RecastImageSurface, context: Context) {
        view.image = image; view.selection = selection
        view.onSelect = { selection = $0 }; view.needsDisplay = true
    }
}

private final class RecastImageSurface: NSView {
    var image: NSImage?
    var selection: NativeSourceRect?
    var onSelect: ((NativeSourceRect) -> Void)?
    private var start: CGPoint?
    override var acceptsFirstResponder: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityLabel("Source image. Drag to select a region. Existing regions are also listed below.")
        setAccessibilityRole(.image)
    }
    required init?(coder: NSCoder) { super.init(coder: coder) }

    private var imageRect: CGRect {
        guard let image, image.size.width > 0, image.size.height > 0 else { return bounds }
        let inset = bounds.insetBy(dx: 16, dy: 16)
        let scale = min(inset.width / image.size.width, inset.height / image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        return CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.055, alpha: 1).setFill(); bounds.fill()
        guard let image else { return }
        let rect = imageRect
        NSColor.white.setFill(); rect.fill()
        image.draw(in: rect)
        if let selection {
            let selected = selection.absolute(in: rect)
            NSColor.systemBlue.withAlphaComponent(0.14).setFill(); selected.fill()
            NSColor.systemBlue.setStroke()
            let border = NSBezierPath(rect: selected); border.lineWidth = 2; border.stroke()
        }
    }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard imageRect.contains(point) else { return }
        window?.makeFirstResponder(self); start = point
    }
    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let bounds = imageRect
        let raw = convert(event.locationInWindow, from: nil)
        let end = CGPoint(x: min(bounds.maxX, max(bounds.minX, raw.x)), y: min(bounds.maxY, max(bounds.minY, raw.y)))
        let rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(start.x - end.x), height: abs(start.y - end.y))
        if rect.width > 2, rect.height > 2 {
            selection = NativeSourceRect(x: (rect.minX - bounds.minX) / bounds.width, y: (rect.minY - bounds.minY) / bounds.height,
                width: rect.width / bounds.width, height: rect.height / bounds.height)
            needsDisplay = true
        }
    }
    override func mouseUp(with event: NSEvent) {
        guard start != nil else { return }
        mouseDragged(with: event); start = nil
        if let selection { onSelect?(selection) }
    }
}

private struct RecastTextSurface: NSViewRepresentable {
    var text: String
    var offset: Int
    var anchor: RecastAnchor?
    @Binding var selection: NSRange

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        guard let view = scroll.documentView as? NSTextView else { return scroll }
        view.isEditable = false; view.isSelectable = true
        view.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        view.textColor = .labelColor; view.backgroundColor = NSColor(calibratedWhite: 0.085, alpha: 1)
        view.textContainerInset = NSSize(width: 18, height: 18)
        view.delegate = context.coordinator
        view.setAccessibilityLabel("Original source text")
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        context.coordinator.updating = true
        defer { context.coordinator.updating = false }
        if view.string != text { view.string = text; context.coordinator.revealed = "" }
        if let anchor, anchor.id != context.coordinator.revealed, anchor.region.kind == "text",
           let start = anchor.region.start, let end = anchor.region.end, start >= offset, end - offset <= (text as NSString).length {
            let range = NSRange(location: start - offset, length: end - start)
            view.setSelectedRange(range); view.scrollRangeToVisible(range)
            context.coordinator.revealed = anchor.id
        } else if anchor == nil, selection.location >= 0, selection.length >= 0,
                  NSMaxRange(selection) <= (text as NSString).length, view.selectedRange() != selection {
            view.setSelectedRange(selection)
            if selection.length > 0 { view.scrollRangeToVisible(selection) }
        }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: RecastTextSurface
        var updating = false
        var revealed = ""
        init(_ parent: RecastTextSurface) { self.parent = parent }
        func textViewDidChangeSelection(_ notification: Notification) {
            guard !updating, let view = notification.object as? NSTextView else { return }
            parent.selection = view.selectedRange()
        }
    }
}
