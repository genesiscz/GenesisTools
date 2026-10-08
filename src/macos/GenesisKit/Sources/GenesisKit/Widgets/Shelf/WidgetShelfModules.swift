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
                    .help("Import images")
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
        ScrollView {
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
                    WidgetShelfRow(store: store, item: item, tint: tint)
                }
            }
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
    @State private var recipientSelection: WidgetShelfRecipientSelection?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: item.kind == .capture ? "photo" : "doc")
                .font(.system(size: 21)).foregroundStyle(tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
                Text(ByteCountFormatter.string(fromByteCount: item.bytes, countStyle: .file))
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button {
                recipientSelection = WidgetShelfRecipientSelection(item: item, recipients: store.recipients)
            } label: { Image(systemName: "tray.and.arrow.down") }
                .buttonStyle(.borderless).disabled(store.isBusy)
                .help(item.kind == .capture ? "Attach image to an inbox draft" : "Add file reference to an inbox draft")
                .accessibilityLabel("Choose recipient for \(item.name)")
                .popover(item: $recipientSelection) { selection in
                    WidgetShelfRecipientPicker(store: store, selection: selection) { recipient in
                        recipientSelection = nil
                        store.attach(selection.item, to: recipient)
                    }
                }
            Menu {
                Button("Open") { PathOpener.open(item.path) }
                Button("Reveal in Finder") { PathOpener.reveal(item.path) }
                Button("Copy path") { PathOpener.copy(item.path, what: "file path") }
                Divider()
                Button("Remove from shelf") { store.remove(item) }.disabled(store.isBusy)
            } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize()
                .accessibilityLabel("Actions for \(item.name)")
        }
        .padding(11)
        .background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
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
