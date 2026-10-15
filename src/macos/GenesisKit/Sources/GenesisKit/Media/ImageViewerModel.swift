import AppKit
import Combine
import SwiftUI

/// The "68 %" in the toolbar. Its own small object, so a pinch re-renders the label and nothing else.
@MainActor
public final class ImageViewerZoomReadout: ObservableObject {
    @Published public internal(set) var percent = 100
    @Published public internal(set) var isFit = true
}

/// One viewer: the images of its source, the one shown (A), the one compared with it (B), the picker, and the
/// actions. The canvas (`ImageViewerCanvasView`) owns zoom and pan; this model only tells it what to show.
@MainActor
public final class ImageViewerModel: ObservableObject {
    public enum CompareMode: String, CaseIterable, Sendable {
        case slider
        case sideBySide

        var canvasMode: ImageViewerCanvasView.Mode { self == .slider ? .slider : .sideBySide }
    }

    public struct Compare: Equatable, Sendable {
        public var bID: String
        public var mode: CompareMode
        public var divider: CGFloat
    }

    /// A slot's picture as the view needs it: its size (for the compare note) or why it failed.
    public enum PictureState: Equatable {
        case loading
        case ready(pixelSize: CGSize)
        case failed(String)
    }

    @Published public private(set) var items: [ImageViewerItem]
    @Published public private(set) var index: Int
    @Published public private(set) var compare: Compare?
    @Published public private(set) var picking = false
    /// The highlighted tile of the picker, an index into `pickerItems`.
    @Published public var pickerFocus = 0
    @Published public private(set) var stateA: PictureState = .loading
    @Published public private(set) var stateB: PictureState = .loading
    @Published public private(set) var copyStatus: MediaPreviewState.CopyStatus = .idle
    /// The window's colour behind the picture (Genesis passes its page colour).
    @Published public var background = ImageViewerView.defaultBackground

    public let readout = ImageViewerZoomReadout()
    public let canvas: ImageViewerCanvasView
    /// Closes the window (with its zoom back); the controller sets it.
    var onDismiss: (() -> Void)?
    /// The picker's columns, as laid out; ↑ and ↓ move by a row.
    var pickerColumns = 3

    private let cache: MediaThumbnailCache
    private let copier = MediaPreviewState()
    private var copySink: AnyCancellable?
    private var loads: [ImageViewerCanvasView.Slot: Task<Void, Never>] = [:]
    /// The bucket each slot last asked for, so a pinch does not ask again for every step.
    private var requested: [ImageViewerCanvasView.Slot: Int] = [:]
    private static let modeKey = "GenesisKit.imageViewer.compareMode"

    public init(items: [ImageViewerItem], selectedID: String, cache: MediaThumbnailCache = .shared,
                canvas: ImageViewerCanvasView? = nil)
    {
        self.items = items
        self.index = items.firstIndex { $0.id == selectedID } ?? 0
        self.cache = cache
        self.canvas = canvas ?? ImageViewerCanvasView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        copySink = copier.$copyStatus.sink { [weak self] in self?.copyStatus = $0 }
        self.canvas.onZoom = { [weak self] zoom, percent in
            guard let self else { return }
            if self.readout.percent != percent { self.readout.percent = percent }
            let fit = abs(zoom.scale - self.canvas.fitScale) <= self.canvas.fitScale * 0.005
            if self.readout.isFit != fit { self.readout.isFit = fit }
        }
        self.canvas.onDivider = { [weak self] value in self?.compare?.divider = value }
        self.canvas.onNeedsPixels = { [weak self] slot, pixels in self?.sharpen(slot, pixels: pixels) }
    }

    public var current: ImageViewerItem? { items.indices.contains(index) ? items[index] : nil }

    public var itemB: ImageViewerItem? {
        guard let id = compare?.bID else { return nil }
        return items.first { $0.id == id }
    }

    public var title: String {
        guard let current else { return "Image" }
        if let itemB { return "\(current.name) and \(itemB.name)" }
        return current.name
    }

    public var canStepBack: Bool { stepTarget(-1) != nil }
    public var canStepForward: Bool { stepTarget(1) != nil }

    /// "B is scaled to A's width (…)" when the two pictures are not the same width.
    public var compareNote: String? {
        guard compare != nil, case .ready(let a) = stateA, case .ready(let b) = stateB else { return nil }
        return CompareLayout.make(a: a, b: b).note(aPixels: a, bPixels: b)
    }

    // MARK: - Showing

    /// Replaces the set (a second double-click on the page) and shows `selectedID`.
    public func replace(items: [ImageViewerItem], selectedID: String) {
        reset(items: items, selectedID: selectedID)
        load(.a)
    }

    /// A new set with nothing loaded yet and no compare or picker open; `start()` loads it.
    func reset(items: [ImageViewerItem], selectedID: String) {
        endCompare()
        picking = false
        loads[.a]?.cancel()
        requested = [:]
        self.items = items
        index = items.firstIndex { $0.id == selectedID } ?? 0
        setState(.a, .loading)
        canvas.clearPicture(.a)
    }

    public func show(_ next: Int) {
        guard items.indices.contains(next) else { return }
        index = next
        if let compare, items[next].id == compare.bID {
            endCompare()
        }
        load(.a)
    }

    /// Loads both slots for the canvas's current size; the first open waits on this before the zoom starts.
    public func start() {
        load(.a)
        if compare != nil { load(.b) }
    }

    /// Waits until both slots have a picture or a failure, up to `timeout`; true when they did.
    @discardableResult
    public func waitUntilLoaded(timeout: Duration = .seconds(5)) async -> Bool {
        let pending = [loads[.a], compare == nil ? nil : loads[.b]].compactMap { $0 }
        let all = Task {
            for load in pending { await load.value }
        }
        return await MediaThumbnailCache.firstResult(of: all, within: timeout) != nil
    }

    public func step(_ delta: Int) {
        guard let target = stepTarget(delta) else { return }
        if let compare, let b = target.b, b != items.firstIndex(where: { $0.id == compare.bID }) {
            self.compare?.bID = items[b].id
            index = target.a
            load(.a)
            load(.b)
            return
        }
        show(target.a)
    }

    private func stepTarget(_ delta: Int) -> (a: Int, b: Int?)? {
        if let compare, let b = items.firstIndex(where: { $0.id == compare.bID }) {
            return ImageViewerOrdering.stepPair(items, a: index, b: b, by: delta).map { ($0.a, $0.b) }
        }
        let next = index + (delta > 0 ? 1 : -1)
        return items.indices.contains(next) ? (next, nil) : nil
    }

    // MARK: - Compare

    public var pickerItems: (sameRow: [ImageViewerItem], others: [ImageViewerItem]) {
        guard let current else { return ([], []) }
        return ImageViewerOrdering.compareCandidates(items, current: current)
    }

    public func openPicker() {
        guard current != nil else { return }
        pickerFocus = 0
        picking = true
    }

    public func closePicker() {
        picking = false
    }

    public func compare(with item: ImageViewerItem) {
        picking = false
        let stored = UserDefaults.standard.string(forKey: Self.modeKey).flatMap(CompareMode.init(rawValue:))
        let mode = compare?.mode ?? stored ?? .slider
        compare = Compare(bID: item.id, mode: mode, divider: compare?.divider ?? 0.5)
        canvas.setDivider(compare?.divider ?? 0.5)
        canvas.setMode(mode.canvasMode)
        load(.b)
    }

    public func setCompareMode(_ mode: CompareMode) {
        guard compare != nil, compare?.mode != mode else { return }
        compare?.mode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: Self.modeKey)
        canvas.setMode(mode.canvasMode)
    }

    /// A becomes B and B becomes A; the decoded pictures move with them.
    public func swap() {
        guard let compare, let b = items.firstIndex(where: { $0.id == compare.bID }), let current else { return }
        self.compare?.bID = current.id
        index = b
        load(.a)
        load(.b)
    }

    public func endCompare() {
        guard compare != nil else { return }
        compare = nil
        loads[.b]?.cancel()
        requested[.b] = nil
        stateB = .loading
        canvas.clearPicture(.b)
        canvas.setMode(.single)
    }

    public func moveDivider(by delta: CGFloat) {
        guard compare?.mode == .slider else { return }
        canvas.setDivider(canvas.divider + delta, notify: true)
    }

    // MARK: - Actions

    public func copyCurrent() {
        guard let current else { return }
        copier.copyImage(MediaPreviewItem(id: current.id, path: current.path, name: current.name, kind: .image))
    }

    public func revealCurrent() {
        guard let current, !current.isTemporary else { return }
        PathOpener.reveal(current.path)
    }

    public func openCurrentInPreview() {
        guard let current else { return }
        Self.openInPreview(current.path)
    }

    public static func openInPreview(_ path: String) {
        let url = URL(fileURLWithPath: path)
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Preview") else {
            PathOpener.open(path)
            return
        }
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error { GenesisKit.log("image viewer: Preview did not open \(path): \(error)") }
        }
    }

    public func dismiss() {
        onDismiss?()
    }

    /// One key, already mapped (`ImageViewerKeymap`). Close dismisses the window and leaves an open picker or
    /// compare. Back steps one layer: the picker, then the compare, then the window.
    public func perform(_ action: ImageViewerAction) {
        let anchor = canvas.pointerAnchor
        switch action {
        case .close:
            dismiss()
        case .dismiss:
            if picking {
                closePicker()
            } else if compare != nil {
                endCompare()
            } else {
                dismiss()
            }
        case .previous: step(-1)
        case .next: step(1)
        case .zoomIn: canvas.zoomStep(up: true, anchor: anchor)
        case .zoomOut: canvas.zoomStep(up: false, anchor: anchor)
        case .fit: canvas.zoomToFit(animated: true)
        case .actualSize: canvas.zoomToActual(anchor: anchor)
        case .copy: copyCurrent()
        case .divider(let delta): moveDivider(by: delta)
        case .pickerMove(let dx, let dy):
            let count = pickerItems.sameRow.count + pickerItems.others.count
            guard count > 0 else { return }
            pickerFocus = min(count - 1, max(0, pickerFocus + dx + dy * max(1, pickerColumns)))
        case .pickerChoose:
            let all = pickerItems.sameRow + pickerItems.others
            if all.indices.contains(pickerFocus) { compare(with: all[pickerFocus]) }
        }
    }

    // MARK: - Loading (MediaThumbnailCache: off the main thread, keyed by file identity)

    /// The pixels a fitted picture needs on its longest side in this canvas.
    private var fitPixels: CGFloat {
        let size = canvas.bounds.size
        return max(256, max(size.width, size.height) * canvas.backingScale)
    }

    private func load(_ slot: ImageViewerCanvasView.Slot, pixels: CGFloat? = nil, reload: Bool = false) {
        guard let item = slot == .a ? current : itemB else { return }
        let want = pixels ?? fitPixels
        loads[slot]?.cancel()
        requested[slot] = MediaThumbnailCache.bucket(forPixels: want, ceiling: MediaThumbnailCache.largestCeiling)
        let isNewPicture = pixels == nil
        if isNewPicture {
            setState(slot, .loading)
        }
        let cache = cache
        loads[slot] = Task { [weak self] in
            let result = await cache.thumbnail(path: item.path, maxPixels: want, kind: .image, reload: reload,
                                               ceiling: MediaThumbnailCache.largestCeiling)
            guard !Task.isCancelled, let self else { return }
            let shown = slot == .a ? self.current : self.itemB
            guard shown?.id == item.id else { return }
            switch result {
            case .ready(let thumbnail):
                self.canvas.setPicture(slot, id: item.id, image: thumbnail.image, pixelSize: thumbnail.sourceSize)
                self.setState(slot, .ready(pixelSize: thumbnail.sourceSize))
            case .failed(let message):
                // A sharper decode that failed keeps the picture already shown.
                guard isNewPicture else { return }
                self.canvas.clearPicture(slot)
                self.setState(slot, .failed(message))
            }
        }
    }

    private func setState(_ slot: ImageViewerCanvasView.Slot, _ state: PictureState) {
        if slot == .a {
            if stateA != state { stateA = state }
        } else if stateB != state {
            stateB = state
        }
    }

    /// More pixels of the picture on the canvas, once it is the item shown and ready. While the next item loads the
    /// canvas still holds the previous picture, and a sharper load then cancelled the new picture's own load.
    private func sharpen(_ slot: ImageViewerCanvasView.Slot, pixels: CGFloat) {
        let shown = slot == .a ? current : itemB
        let picture = slot == .a ? canvas.pictureA : canvas.pictureB
        guard (slot == .a ? stateA : stateB).isReady, let shown, picture?.id == shown.id else { return }
        let bucket = MediaThumbnailCache.bucket(forPixels: pixels, ceiling: MediaThumbnailCache.largestCeiling)
        guard bucket > (requested[slot] ?? 0) else { return }
        load(slot, pixels: pixels)
    }

    public func retry(_ slot: ImageViewerCanvasView.Slot) {
        load(slot, reload: true)
    }
}
