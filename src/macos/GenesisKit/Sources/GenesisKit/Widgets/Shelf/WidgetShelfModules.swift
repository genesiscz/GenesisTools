import SwiftUI

public extension WidgetShelfStore {
    func captureModule() -> WidgetModuleDescriptor {
        WidgetModuleDescriptor(
            id: "capture", title: "Capture", symbol: "viewfinder", tint: .orange,
            summary: { self.isCapturing ? "Select an area…" : "\(self.captures.count) captures" },
            visibilityChanged: { self.visibilityChanged(module: "capture", presentation: $0) }
        ) { WidgetShelfModuleView(store: self, captureOnly: true, presentation: $0) }
    }

    func shelfModule() -> WidgetModuleDescriptor {
        WidgetModuleDescriptor(
            id: "shelf", title: "File Shelf", symbol: "tray.full", tint: .cyan,
            summary: { "\(self.items.count) items" },
            visibilityChanged: { self.visibilityChanged(module: "shelf", presentation: $0) }
        ) { WidgetShelfModuleView(store: self, captureOnly: false, presentation: $0) }
    }
}

struct WidgetShelfModuleView: View {
    @ObservedObject var store: WidgetShelfStore
    let captureOnly: Bool
    let presentation: WidgetModulePresentation

    @State private var dropTargeted = false
    /// The ids on screen before the last inventory change; nil until the first read, so a first load never animates.
    @State private var knownIDs: Set<String>?
    /// Items that arrived with the last change (a capture, a drop, a paste): flashed once, then faded.
    @State private var arrived: Set<String> = []
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.widgetReduceMotion) private var widgetReduceMotion

    private var title: String { captureOnly ? "Capture" : "File Shelf" }
    private var symbol: String { captureOnly ? "viewfinder" : "tray.full" }
    private var tint: Color { captureOnly ? .orange : .cyan }
    private var displayedItems: [WidgetShelfItem] { captureOnly ? store.captures : store.items }

    var body: some View {
        Group {
            if presentation == .compact {
                HStack(spacing: 7) {
                    Image(systemName: symbol).foregroundStyle(tint)
                    Text(store.isCapturing ? "Select an area…" : "\(displayedItems.count) \(captureOnly ? "captures" : "items")")
                        .font(.system(size: 11, weight: .medium))
                }
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    header
                    controls
                    if presentation == .expanded {
                        status
                        inventory
                    } else {
                        Text(captureOnly ? "Capture now. Choose an inbox later." : "Drop files here. Keep them ready for any inbox.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                .mediaPreviewHost()
                .padding(16)
                .background(dropTargeted ? tint.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 16))
                .dropDestination(for: URL.self) { urls, _ in
                    guard !store.isBusy else { return false }
                    store.importFiles(urls, asImages: captureOnly)
                    return !urls.isEmpty
                } isTargeted: { dropTargeted = $0 }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(captureOnly ? "capture-widget" : "file-shelf-widget")

    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(title).font(.system(size: 15, weight: .semibold))
            Spacer()
            Text("\(displayedItems.count) staged").font(.system(size: 10)).foregroundStyle(.secondary)
        }
    }

    private var controls: some View {
        HStack(spacing: 8) {
            if captureOnly {
                Button(action: store.isCapturing ? store.cancelCapture : store.capture) {
                    Label(store.isCapturing ? "Cancel capture" : "Capture area", systemImage: store.isCapturing ? "xmark" : "viewfinder")
                }
                .disabled(store.isBusy && !store.isCapturing)
                .accessibilityIdentifier("shelf-capture")
            } else {
                Button { store.chooseFiles() } label: { Label("Add files", systemImage: "plus") }
                    .disabled(store.isBusy)
                    .accessibilityIdentifier("shelf-import")
            }
            Button { store.paste(asImages: captureOnly) } label: { Label("Paste", systemImage: "doc.on.clipboard") }
                .disabled(store.isBusy)
                .accessibilityIdentifier("shelf-paste")
            if captureOnly {
                Button { store.chooseFiles(asImages: true) } label: { Image(systemName: "photo.badge.plus") }
                    .instantTooltip("Import images")
                    .accessibilityLabel("Import images")
                    .disabled(store.isBusy)
            }
            Spacer(minLength: 0)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    @ViewBuilder private var status: some View {
        if let error = store.error {
            Text(error).font(.system(size: 11)).foregroundStyle(KitPalette.removed)
                .fixedSize(horizontal: false, vertical: true)
        } else if let notice = store.notice {
            Text(notice).font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(captureOnly ? "Images stay here until you choose a recipient." : "Durable copies. Removing an item keeps the original file.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }

    private var inventory: some View {
        let ids = displayedItems.map(\.id)
        let gallery = displayedItems.map(WidgetShelfRow.preview)
        // Animate a few arrivals into a list already on screen; a first load or a bulk change just appears.
        let inserted = knownIDs.map { Set(ids).subtracting($0).count } ?? 0
        let animates = knownIDs != nil && inserted > 0 && inserted <= 3
        let reduceMotion = systemReduceMotion || widgetReduceMotion
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if displayedItems.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: captureOnly ? "viewfinder" : "tray.and.arrow.down")
                            .font(.system(size: 30, weight: .light)).foregroundStyle(tint.opacity(0.7))
                        Text(captureOnly ? "Your next capture starts here" : "A place for files you will need")
                            .font(.system(size: 13, weight: .medium))
                        Text(captureOnly ? "Select an area or paste an image." : "Drop files, paste copied files, or choose Add files.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 48)
                }
                ForEach(displayedItems) { item in
                    WidgetShelfRow(
                        store: store, item: item, tint: tint, gallery: gallery, arrived: arrived.contains(item.id)
                    )
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .asymmetric(
                                insertion: .move(edge: .top).combined(with: .opacity).combined(with: .scale(scale: 0.97, anchor: .top)),
                                removal: .opacity))
                }
            }
            .animation(animates ? (reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.86)) : nil,
                value: ids)
        }
        .scrollIndicators(.automatic)
        .onAppear { if store.loaded { knownIDs = Set(ids) } }
        .onChange(of: store.loaded) { _, loaded in if loaded { knownIDs = Set(ids) } }
        .onChange(of: ids) { _, next in
            guard let known = knownIDs else { return }
            let fresh = Set(next).subtracting(known)
            knownIDs = Set(next)
            guard !fresh.isEmpty, fresh.count <= 3 else { return }
            arrived = fresh
            SWR.fade(fresh, current: { arrived }, clear: { arrived = [] })
        }
    }

}

private struct WidgetShelfRecipientSelection: Identifiable {
    let item: WidgetShelfItem
    let recipients: [WidgetSession]
    var id: String { item.id }
}

private struct WidgetShelfRow: View {
    @ObservedObject var store: WidgetShelfStore
    let item: WidgetShelfItem
    let tint: Color
    /// Every item of this list, so the preview's ← and → move through them.
    let gallery: [MediaPreviewItem]
    let arrived: Bool
    @State private var recipientSelection: WidgetShelfRecipientSelection?

    static func preview(_ item: WidgetShelfItem) -> MediaPreviewItem {
        MediaPreviewItem(id: item.id, path: item.path, name: item.name, kind: item.kind == .capture ? .image : nil)
    }

    var body: some View {
        HStack(spacing: 10) {
            MediaThumbnailView(item: Self.preview(item), gallery: gallery, cornerRadius: 6, emphasis: .compact)
                .frame(width: 56, height: 42)
                .accessibilityIdentifier("shelf-thumbnail-" + item.id)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
                HStack(spacing: 4) {
                    Text(verbatim: ByteFormat.file(item.bytes))
                    Text(verbatim: "·")
                    Text(Date(timeIntervalSince1970: item.createdAt / 1000), style: .time)
                }
                .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            IconButton(
                systemName: "tray.and.arrow.down",
                tooltip: item.kind == .capture ? "Attach image to an inbox draft" : "Add file reference to an inbox draft"
            ) {
                recipientSelection = WidgetShelfRecipientSelection(item: item, recipients: store.recipients)
            }
                .disabled(store.isBusy)
                .accessibilityLabel("Choose recipient for \(item.name)")
                .popover(item: $recipientSelection) { selection in
                    WidgetShelfRecipientPicker(store: store, selection: selection) { recipient in
                        recipientSelection = nil
                        store.attach(selection.item, to: recipient)
                    }
                }
            MenuButton(style: .genHoverIcon()) {
                [
                    .action("Open", run: { PathOpener.open(item.path) }),
                    .action("Reveal in Finder", run: { PathOpener.reveal(item.path) }),
                    .action("Copy path", run: { PathOpener.copy(item.path, what: "file path") }),
                    .divider,
                    .action("Remove from shelf", enabled: !store.isBusy, run: { store.remove(item) }),
                ]
            } label: {
                Image(systemName: "ellipsis").frame(width: 16, height: 16)
            }
                .instantTooltip("More actions")
                .accessibilityLabel("Actions for \(item.name)")
        }
        .padding(.vertical, 8).padding(.leading, 8).padding(.trailing, 10)
        .background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
        .swrFlash(arrived, cornerRadius: 10, color: tint)
        .draggable(URL(fileURLWithPath: item.path))
        .accessibilityElement(children: .contain)
    }
}

private struct WidgetShelfRecipientPicker: View {
    @ObservedObject var store: WidgetShelfStore
    let selection: WidgetShelfRecipientSelection
    let choose: (WidgetSession) -> Void
    @State private var query = ""
    @State private var matches: [WidgetSession]

    init(store: WidgetShelfStore, selection: WidgetShelfRecipientSelection, choose: @escaping (WidgetSession) -> Void) {
        self.store = store
        self.selection = selection
        self.choose = choose
        _matches = State(initialValue: selection.recipients)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(selection.item.kind == .capture ? "Attach image to inbox" : "Add file reference to inbox")
                .font(.system(size: 13, weight: .semibold))
            Text("This adds to the draft. It does not send.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            TextField("Find a session or project", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("shelf-recipient-search")
            if selection.recipients.isEmpty {
                Text("No agent sessions are available.").font(.system(size: 12))
            } else if matches.isEmpty {
                Text("No matching sessions.").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(matches) { recipient in
                            Button { choose(recipient) } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(recipient.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                                    Text([recipient.target.provider, recipient.project].filter { !$0.isEmpty }.joined(separator: " · "))
                                        .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                            }
                            .buttonStyle(.genHoverPlain()).disabled(store.isBusy)
                            .accessibilityLabel(recipient.title)
                        }
                    }
                }.frame(height: min(280, CGFloat(matches.count) * 58))
            }
        }
        .padding(16).frame(width: 320)
        .onChange(of: query) { _, _ in updateMatches() }
    }

    private func updateMatches() {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        matches = trimmed.isEmpty ? selection.recipients : selection.recipients.filter {
            $0.title.localizedStandardContains(trimmed) || $0.project.localizedStandardContains(trimmed)
                || $0.target.provider.localizedStandardContains(trimmed)
        }
    }
}
