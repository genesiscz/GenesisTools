import SwiftUI

@MainActor
struct ClickySoundLibraryView: View {
    @ObservedObject var model: ClickyModel
    @ObservedObject var library: ClickySoundLibrary
    @State private var search = ""
    @State private var showingLicence = false

    private var filtered: [ClickyLibraryRow] {
        guard !search.isEmpty else { return library.rows }
        return library.rows.filter {
            [$0.entry.name, $0.entry.author, $0.entry.licence, $0.libraryName]
                .contains { $0.localizedCaseInsensitiveContains(search) }
        }
    }

    var body: some View {
        NativeSettingsCard("Sound libraries") {
            HStack {
                Text("Recordings and generated switches, with their original licences.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Add folder…", action: library.addFolder)
                    .accessibilityIdentifier("clicky.library.add")
                    .disabled(library.choosingFolder)
            }
            if let error = library.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 11)).foregroundStyle(.orange)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if !library.records.isEmpty {
                HStack {
                    TextField("Search sounds, authors or licences", text: $search)
                        .textFieldStyle(.roundedBorder).accessibilityIdentifier("clicky.library.search")
                    if library.refreshing { ProgressView().controlSize(.small) }
                    Button("Refresh") { Task { await library.refresh() } }
                        .disabled(library.refreshing)
                }
                ScrollView {
                    LazyVStack(spacing: 3) {
                        ForEach(filtered) { row in
                            libraryRow(row)
                        }
                    }
                }.frame(height: min(320, CGFloat(max(1, filtered.count)) * 60))
                if filtered.isEmpty {
                    Text(search.isEmpty ? "No available sounds. Reconnect the library folder and refresh." : "No sounds match this search.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                DisclosureGroup("Manage folders") {
                    ForEach(library.records) { record in
                        HStack {
                            Label(record.displayName, systemImage: "folder")
                            Spacer()
                            Button("Remove") { model.removeSoundLibrary(record.id) }
                                .help("Remove the library from Clicky. Files are kept.")
                        }.font(.system(size: 11)).padding(.vertical, 4)
                    }
                }.font(.system(size: 12))
            } else {
                Label("Choose an audio folder with a registry.json file. Nothing is downloaded automatically.", systemImage: "folder.badge.plus")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).padding(.vertical, 8)
            }
            if let active = library.active {
                Divider()
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(active.entry.name).font(.system(size: 12, weight: .semibold))
                        Text("\(active.entry.author) · \(active.entry.licence)")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Licence & source") { showingLicence = true }
                    Button("Preview") { model.previewStroke() }
                        .accessibilityLabel("Preview \(active.entry.name)")
                }
            }
        }
        .sheet(isPresented: $showingLicence) {
            if let active = library.active {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text(active.entry.name).font(.title2.bold())
                        Spacer()
                        Button("Done") { showingLicence = false }.keyboardShortcut(.cancelAction)
                    }
                    Text("\(active.entry.author) · \(active.entry.licence)").foregroundStyle(.secondary)
                    if let url = active.source.sourceURL { Link("Original source", destination: url) }
                    if active.attributionRequired {
                        Text(active.attribution.isEmpty ? "Attribution required. See the full licence below." : active.attribution)
                            .font(.callout)
                    }
                    HStack(spacing: 14) {
                        permission("Personal use", allowed: active.permissions.personal)
                        permission("Modification", allowed: active.permissions.modification)
                        permission("Redistribution", allowed: active.permissions.redistribution)
                        permission("Commercial redistribution", allowed: active.permissions.commercialRedistribution)
                    }
                    ScrollView {
                        Text(active.licenceText).font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }.padding(24).frame(width: 680, height: 480)
            }
        }
    }

    private func libraryRow(_ row: ClickyLibraryRow) -> some View {
        HStack(spacing: 12) {
            Image(systemName: row.entry.kind == "generated" ? "waveform.path" : "waveform")
                .font(.system(size: 17)).foregroundStyle(.pink)
                .frame(width: 30, height: 30)
                .background(.pink.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                Text(row.entry.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Text(row.entry.availabilityError ?? "\(row.entry.author) · \(row.entry.licence)")
                    .font(.system(size: 10)).foregroundStyle(row.entry.availabilityError == nil ? Color.secondary : Color.orange)
                    .lineLimit(2)
            }
            Spacer()
            if library.loading == row.reference {
                ProgressView().controlSize(.small).accessibilityLabel("Preparing \(row.entry.name)")
            } else if library.active?.reference == row.reference {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.pink)
                    .accessibilityLabel("Selected \(row.entry.name)")
            } else {
                Button("Use") { library.select(row.reference) }
                    .disabled(row.entry.availabilityError != nil)
                    .accessibilityLabel("Use \(row.entry.name)")
            }
        }.padding(.horizontal, 6).padding(.vertical, 8)
    }

    private func permission(_ title: String, allowed: Bool) -> some View {
        Label(title, systemImage: allowed ? "checkmark.circle" : "minus.circle")
            .font(.system(size: 10)).foregroundStyle(allowed ? Color.secondary : Color.orange)
    }
}
