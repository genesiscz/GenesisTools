import SwiftUI

struct PermissionsView: View {
    @ObservedObject var model: PermissionsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Everything `tools` runs is attributed to this app, so one grant per row serves every terminal and launchd job. Requests made here show the same prompt the CLI would.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Refresh") { model.refresh() }
            }

            Table(model.rows) {
                TableColumn("Permission") { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).fontWeight(.medium)
                        Text(row.usedBy).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .width(min: 260)
                TableColumn("Status") { row in
                    HStack(spacing: 6) {
                        Circle().fill(Color(nsColor: row.state.color)).frame(width: 9, height: 9)
                        Text(row.state.label)
                    }
                }
                .width(min: 150)
                TableColumn("") { row in
                    HStack {
                        actionButton(row)
                        Button("Settings…") { model.openPane(row.pane) }
                    }
                }
                .width(min: 220)
            }

            HStack {
                if let busy = model.busy {
                    ProgressView().controlSize(.small)
                    Text("Waiting for macOS (\(busy))…").font(.caption)
                }
                if let message = model.lastMessage {
                    Text(message).font(.caption).foregroundStyle(.orange)
                }
                Spacer()
                Button("Reveal app in Finder") { model.revealApp() }
                    .help("Full Disk Access and Accessibility have no prompt: drag the app into the list.")
            }
        }
    }

    @ViewBuilder
    private func actionButton(_ row: PermissionRow) -> some View {
        switch row.action {
        case .prompt:
            Button(row.state == .granted ? "Granted" : "Request") { model.request(row) }
                .disabled(row.state == .granted || model.busy != nil)
        case .openPane(let pane):
            Button(row.state == .granted ? "Granted" : "Open list & reveal") {
                model.openPane(pane)
                model.revealApp()
            }
            .disabled(row.state == .granted)
        case .probe:
            Button(row.state == .granted ? "Granted" : "Test (asks)") { model.request(row) }
                .disabled(row.state == .granted || model.busy != nil)
        }
    }
}

struct ServicesView: View {
    @ObservedObject var model: ServicesModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("launchd jobs installed by tools (com.genesis-tools.*). A job written before this app existed keeps its bare command and the terminal-less grants; reinstall it with its own tool (for example `tools dev-dashboard ui up`) to route it through the launcher.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Refresh") { model.refresh() }
            }

            if model.jobs.isEmpty {
                Text("No com.genesis-tools.* jobs in ~/Library/LaunchAgents.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Table(model.jobs) {
                    TableColumn("Label") { job in Text(job.id) }
                        .width(min: 220)
                    TableColumn("Runs under app") { job in
                        HStack(spacing: 6) {
                            Circle().fill(job.underApp ? Color.green : Color.orange).frame(width: 9, height: 9)
                            Text(job.underApp ? "yes" : "no (reinstall)")
                        }
                    }
                    .width(min: 130)
                    TableColumn("Loaded") { job in Text(job.loaded ? "yes" : "no") }
                        .width(min: 60)
                    TableColumn("Program") { job in
                        Text(job.program).font(.caption).lineLimit(1).truncationMode(.middle)
                    }
                    TableColumn("") { job in Button("Reveal plist") { model.reveal(job) } }
                        .width(min: 100)
                }
            }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        Form {
            Section("Launcher") {
                Toggle("Route `tools` through this app (owns the privacy grants)", isOn: $model.launcherEnabled)
                Text(model.launcherEnabled
                     ? "On. Every tool runs as GenesisTools; grants live on this bundle."
                     : "Off. Tools run under the terminal that starts them and use its grants. Marker: \(SettingsModel.disabledMarker)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let error = model.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }

            Section("This bundle") {
                LabeledContent("Version", value: "\(model.version) (build \(model.build))")
                LabeledContent("Bundle id", value: model.bundleId)
                LabeledContent("Path", value: model.bundlePath)
                LabeledContent("Signed by", value: model.teamId.isEmpty ? model.signature : "\(model.signature) [\(model.teamId)]")
                HStack {
                    Button("Reveal in Finder") { model.revealApp() }
                    Button("Open ~/.genesis-tools/app") { model.openAppDir() }
                    Button("Privacy & Security…") { model.openPrivacySettings() }
                }
            }

            Section("Build manifest") {
                Text(model.manifest)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }

            Section("Command line") {
                Text("tools macos permissions            status, exit 1 while something is missing\ntools macos permissions build      rebuild and re-sign this app\ntools macos permissions ui         open this window\ntools macos calendar doctor        calendar-specific diagnosis")
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
    }
}
