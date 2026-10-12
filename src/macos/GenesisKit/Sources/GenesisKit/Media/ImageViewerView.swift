import AppKit
import SwiftUI

/// The viewer window's content: a compact control row in the title bar, the picture canvas, the compare bar under
/// it while comparing, and the "Compare with…" picker as a transient panel over the canvas.
public struct ImageViewerView: View {
    @ObservedObject var model: ImageViewerModel

    public init(model: ImageViewerModel) {
        self.model = model
    }

    /// Genesis Markdown's page colour.
    public static let defaultBackground = Color(red: 0x0c / 255, green: 0x0e / 255, blue: 0x10 / 255)

    public var body: some View {
        VStack(spacing: 0) {
            ImageViewerToolbar(model: model, readout: model.readout)
                .titlebarRow()
            ZStack {
                ImageViewerCanvas(canvas: model.canvas)
                    .accessibilityIdentifier("image-viewer-canvas")
                    .accessibilityLabel(Text(verbatim: model.current?.name ?? "Image"))
                ImageViewerCanvasOverlay(model: model)
                if model.picking {
                    ImageViewerPicker(model: model)
                        .padding(.top, 10)
                        .padding(.trailing, 12)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                        .transition(.opacity.combined(with: .offset(y: -6)))
                }
            }
            .clipped()
            .animation(.easeOut(duration: 0.14), value: model.picking)
            if model.compare != nil {
                ImageViewerCompareBar(model: model)
                    .transition(.opacity)
            }
        }
        .titlebarBackground(model.background)
        .titlebarZone()
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("image-viewer")
    }
}

// MARK: - Title bar row

private struct ImageViewerToolbar: View {
    @ObservedObject var model: ImageViewerModel
    @ObservedObject var readout: ImageViewerZoomReadout

    var body: some View {
        HStack(spacing: 6) {
            // The window's own title is hidden: AppKit measured it before it was laid out, and the row then
            // started on top of it. Drawn here, it truncates in the middle like a file name should.
            Text(verbatim: model.title)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
                .titlebarLabel()
            if model.items.count > 1 {
                Text(verbatim: "\(model.index + 1) of \(model.items.count)")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .titlebarLabel()
            }
            Spacer(minLength: 12)
            if case .copied = model.copyStatus {
                Label("Copied", systemImage: "checkmark")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(KitPalette.added)
                    .titlebarLabel()
                    .transition(.opacity)
            } else if case .refused(let message) = model.copyStatus {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(KitPalette.modified)
                    .lineLimit(1)
                    .frame(maxWidth: 260, alignment: .trailing)
                    .titlebarLabel()
            }
            HStack(spacing: 2) {
                IconButton(systemName: "minus.magnifyingglass", tooltip: "Zoom out (⌘−)") { model.perform(.zoomOut) }
                MenuButton(items: { zoomMenu }) {
                    Text(verbatim: "\(readout.percent) %")
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .frame(minWidth: 44)
                        .padding(.vertical, 3)
                }
                .instantTooltip(readout.isFit ? "Fitted to the window. Click for zoom levels" : "Zoom level. Click for zoom levels")
                .accessibilityLabel(Text(verbatim: "Zoom \(readout.percent) percent"))
                IconButton(systemName: "plus.magnifyingglass", tooltip: "Zoom in (⌘+)") { model.perform(.zoomIn) }
            }
            .disabled(model.stateA.isReady == false)
            divider
            Button {
                model.picking ? model.closePicker() : model.openPicker()
            } label: {
                Label(model.compare == nil ? "Compare with…" : "Change B…", systemImage: "rectangle.split.2x1")
                    .font(.system(size: 11.5, weight: .medium))
            }
            .buttonStyle(.genHover())
            .disabled(model.items.count < 2)
            .accessibilityIdentifier("image-viewer-compare")
            divider
            IconButton(systemName: "doc.on.doc", tooltip: "Copy image (⌘C)") { model.copyCurrent() }
                .disabled(model.copyStatus == .copying)
            IconButton(systemName: "folder", tooltip: model.current?.isTemporary == true
                ? "This picture is embedded in the note and has no file to show"
                : "Show in Finder") { model.revealCurrent() }
                .disabled(model.current?.isTemporary != false)
            IconButton(systemName: "arrow.up.forward.app", tooltip: "Open in Preview") { model.openCurrentInPreview() }
        }
        .padding(.trailing, 10)
        .animation(.easeOut(duration: 0.15), value: model.copyStatus)
    }

    private var divider: some View {
        Rectangle().fill(Color.white.opacity(0.12)).frame(width: 1, height: 14).padding(.horizontal, 4)
            .titlebarLabel()
    }

    private var zoomMenu: [MenuButtonItem] {
        [
            .action("Fit to window  ⌘0", checked: readout.isFit) { model.perform(.fit) },
            .divider,
            .action("50 %", checked: readout.percent == 50) { zoom(0.5) },
            .action("100 %  ⌘1", checked: readout.percent == 100 && !readout.isFit) { model.perform(.actualSize) },
            .action("200 %", checked: readout.percent == 200) { zoom(2) },
            .action("400 %", checked: readout.percent == 400) { zoom(4) },
        ]
    }

    private func zoom(_ multiple: CGFloat) {
        model.canvas.zoom(to: model.canvas.actualScale * multiple, anchor: nil, animated: true)
    }
}

extension ImageViewerModel.PictureState {
    var isReady: Bool {
        if case .ready = self { return true }
        return false
    }
}

// MARK: - Over the canvas

private struct ImageViewerCanvasOverlay: View {
    @ObservedObject var model: ImageViewerModel

    var body: some View {
        ZStack {
            stateView(model.stateA, slot: .a, name: model.current?.name ?? "")
            if let compare = model.compare {
                labels(compare)
            }
            if model.items.count > 1 && !model.picking {
                HStack {
                    stepButton("chevron.left", tooltip: "Previous image (←)", enabled: model.canStepBack) { model.step(-1) }
                    Spacer()
                    stepButton("chevron.right", tooltip: "Next image (→)", enabled: model.canStepForward) { model.step(1) }
                }
                .padding(.horizontal, 10)
            }
        }
    }

    @ViewBuilder
    private func stateView(_ state: ImageViewerModel.PictureState, slot: ImageViewerCanvasView.Slot, name: String) -> some View {
        switch state {
        case .failed(let reason):
            VStack(spacing: 8) {
                Image(systemName: "photo").font(.system(size: 28, weight: .light)).foregroundStyle(.secondary)
                Text(verbatim: name).font(.system(size: 12, weight: .semibold))
                Text(verbatim: reason).font(.system(size: 11)).foregroundStyle(.secondary)
                Button { model.retry(slot) } label: {
                    Label("Retry", systemImage: "arrow.clockwise").font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.genHover())
            }
            .padding(20)
        case .loading, .ready:
            EmptyView()
        }
    }

    private func labels(_ compare: ImageViewerModel.Compare) -> some View {
        GeometryReader { proxy in
            let a = chip("A", model.current?.name ?? "")
            let b = chip("B", model.itemB?.name ?? "")
            if compare.mode == .slider {
                a.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(10)
                b.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(10)
            } else {
                let pane = (proxy.size.width - ImageViewerCanvasView.paneGap) / 2
                a.frame(width: pane, height: proxy.size.height, alignment: .topLeading).padding(10)
                b.frame(width: pane, height: proxy.size.height, alignment: .topLeading).padding(10)
                    .offset(x: pane + ImageViewerCanvasView.paneGap)
            }
        }
        .allowsHitTesting(false)
    }

    private func chip(_ letter: String, _ name: String) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: letter).font(.system(size: 11, weight: .bold)).foregroundStyle(KitTheme.accent)
            Text(verbatim: name).font(.system(size: 11, weight: .medium)).lineLimit(1).truncationMode(.middle)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(Color.black.opacity(0.62)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
        .frame(maxWidth: 320, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private func stepButton(_ symbol: String, tooltip: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color.black.opacity(0.5)))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.16)))
                .contentShape(Circle())
        }
        .buttonStyle(.genHoverPlain(scale: 1.06))
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0)
        .allowsHitTesting(enabled)
        .accessibilityHidden(!enabled)
        .instantTooltip(tooltip)
        .accessibilityLabel(Text(tooltip))
    }
}

// MARK: - Compare bar

private struct ImageViewerCompareBar: View {
    @ObservedObject var model: ImageViewerModel

    var body: some View {
        HStack(spacing: 10) {
            name("A", model.current?.name ?? "")
            IconButton(systemName: "arrow.left.arrow.right", tooltip: "Swap A and B") { model.swap() }
            name("B", model.itemB?.name ?? "")
            Spacer(minLength: 8)
            if let note = model.compareNote {
                Label(note, systemImage: "arrow.left.and.right.square")
                    .font(.system(size: 11))
                    .foregroundStyle(KitPalette.modified)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .instantTooltip("The two pictures have different widths, so B is drawn at A's width to line them up.")
            }
            GenSegmentedTabs("Compare layout", items: [.init(ImageViewerModel.CompareMode.slider, "Slider"),
                                                       .init(ImageViewerModel.CompareMode.sideBySide, "Side by side")],
                             selection: Binding(get: { model.compare?.mode ?? .slider },
                                                set: { model.setCompareMode($0) }),
                             minSegmentWidth: 64)
                .fixedSize()
            Button("Done") { model.endCompare() }
                .buttonStyle(.genHover())
                .instantTooltip("Back to one image (Esc)")
        }
        .font(.system(size: 11.5))
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background(Color.white.opacity(0.035))
        .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1) }
        .accessibilityIdentifier("image-viewer-compare-bar")
    }

    private func name(_ letter: String, _ text: String) -> some View {
        HStack(spacing: 5) {
            Text(verbatim: letter).font(.system(size: 11, weight: .bold)).foregroundStyle(KitTheme.accent)
            Text(verbatim: text).lineLimit(1).truncationMode(.middle).foregroundStyle(.primary)
        }
        .frame(maxWidth: 240, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Picker

private struct ImageViewerPicker: View {
    @ObservedObject var model: ImageViewerModel
    static let columns = 3
    static let tile = CGSize(width: 128, height: 86)

    var body: some View {
        let groups = model.pickerItems
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(verbatim: "Compare \(model.current?.name ?? "") with…")
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                IconButton(systemName: "xmark", tooltip: "Close (Esc)") { model.closePicker() }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
            ScrollViewReader { scroller in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if !groups.sameRow.isEmpty {
                            section("Same row", groups.sameRow, offset: 0)
                        }
                        if !groups.others.isEmpty {
                            section(groups.sameRow.isEmpty ? "Images in this note" : "Other images in this note",
                                    groups.others, offset: groups.sameRow.count)
                        }
                        if groups.sameRow.isEmpty && groups.others.isEmpty {
                            Text("This note has no other image.")
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                    }
                    .padding(12)
                    .scrollOverflowContent()
                }
                .scrollOverflowHints()
                .onChange(of: model.pickerFocus) { _, focus in
                    withAnimation(.easeOut(duration: 0.12)) { scroller.scrollTo(focus) }
                }
            }
        }
        .frame(width: CGFloat(Self.columns) * (Self.tile.width + 10) + 14)
        .frame(maxHeight: 520)
        .fixedSize(horizontal: false, vertical: true)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.white.opacity(0.12)))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("image-viewer-picker")
        .accessibilityAddTraits(.isModal)
        .onAppear { model.pickerColumns = Self.columns }
    }

    private func section(_ title: String, _ items: [ImageViewerItem], offset: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(Self.tile.width), spacing: 10), count: Self.columns),
                      alignment: .leading, spacing: 10) {
                ForEach(Array(items.enumerated()), id: \.element.id) { position, item in
                    tile(item, focused: model.pickerFocus == offset + position).id(offset + position)
                }
            }
        }
    }

    private func tile(_ item: ImageViewerItem, focused: Bool) -> some View {
        Button { model.compare(with: item) } label: {
            VStack(spacing: 4) {
                MediaThumbnailView(item: MediaPreviewItem(id: item.id, path: item.path, name: item.name, kind: .image),
                                   cornerRadius: 6, interactive: false)
                    .frame(width: Self.tile.width, height: Self.tile.height)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.white.opacity(0.04)))
                    .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .strokeBorder(KitTheme.accent.opacity(focused ? 0.95 : 0), lineWidth: 2)
                        .padding(-2))
                Text(verbatim: item.name)
                    .font(.system(size: 10.5))
                    .lineLimit(2).truncationMode(.middle)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(focused ? .primary : .secondary)
                    .frame(width: Self.tile.width, height: 28, alignment: .top)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain(brighten: 0.08))
        .instantTooltip("Compare with \(item.name)")
        .accessibilityLabel(Text(verbatim: "Compare with \(item.name)"))
    }
}
