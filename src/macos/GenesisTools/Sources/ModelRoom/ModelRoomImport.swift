import AppKit
import GenesisKit
import SwiftUI

struct ModelRoomImportSheet: View {
    @ObservedObject var model: ModelRoomModel
    let source: ModelRoomTableSource
    @Environment(\.dismiss) private var dismiss
    @State private var timeColumn = ""
    @State private var valueColumn = ""
    @State private var label = "Observed values"
    @State private var unit = "1"
    @State private var interpolation = "hold"
    @State private var decimal = "dot"
    @State private var delimiter = "comma"

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Map your observations").font(.system(size: 22, weight: .semibold))
                    Text("\(source.url.lastPathComponent) · \(source.table.rowCount) rows · preview of the first 12")
                        .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                }
                Spacer()
                if model.importing { ProgressView().controlSize(.small) }
            }
            HStack {
                Picker("Separator", selection: $delimiter) {
                    Text("Comma").tag("comma"); Text("Semicolon").tag("semicolon"); Text("Tab").tag("tab")
                }.frame(width: 210).accessibilityLabel("Column separator")
                Button("Reload preview") { model.previewTable(url: source.url, delimiter: delimiter) }
                    .buttonStyle(.genHoverPlain()).disabled(model.importing)
            }
            ScrollView([.horizontal, .vertical]) {
                Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 8) {
                    GridRow {
                        ForEach(source.table.headers, id: \.self) { Text($0).fontWeight(.semibold) }
                    }
                    ForEach(Array(source.table.preview.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in Text(cell).lineLimit(2).frame(maxWidth: 240, alignment: .leading) }
                        }
                    }
                }.font(.system(size: 11, design: .monospaced)).padding(12)
            }.frame(height: 185).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            HStack(spacing: 20) {
                Picker("Time (\(model.file?.time.unit ?? "day"))", selection: $timeColumn) {
                    ForEach(source.table.headers, id: \.self) { Text($0).tag($0) }
                }
                Picker("Value", selection: $valueColumn) {
                    ForEach(source.table.headers, id: \.self) { Text($0).tag($0) }
                }
            }
            HStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Quantity name").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    TextField("Quantity name", text: $label).textFieldStyle(.roundedBorder).accessibilityLabel("Quantity name")
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text("Unit").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    TextField("Unit, e.g. tickets", text: $unit).textFieldStyle(.roundedBorder).accessibilityLabel("Observation unit")
                }
            }
            HStack(spacing: 20) {
                Picker("Between observations", selection: $interpolation) {
                    Text("Hold previous value").tag("hold"); Text("Linear interpolation").tag("linear")
                }
                Picker("Decimal separator", selection: $decimal) {
                    Text("Dot (1.5)").tag("dot"); Text("Comma (1,5)").tag("comma")
                }
            }
            Text("Times must be numeric, nonnegative and strictly increasing. Values before the first or after the last observation are held at the endpoint. The original file stays unchanged.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)

            if let error = model.error {
                NoticePill(text: error, isError: true) { model.error = nil }
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                Button("Import as measured quantity") {
                    let editor = model.owner?.windowControllers.first?.window?.attachedSheet ?? NSApp.keyWindow
                    editor?.makeFirstResponder(nil)
                    model.importObservations(source: source, timeColumn: timeColumn, valueColumn: valueColumn, label: label, unit: unit, interpolation: interpolation, decimal: decimal)
                }.buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction)
                    .disabled(model.importing || delimiter != source.delimiter || timeColumn.isEmpty || valueColumn.isEmpty || timeColumn == valueColumn || label.isEmpty)
            }
        }
        .padding(24).frame(width: 760)
        .onAppear {
            timeColumn = source.table.headers.first ?? ""
            valueColumn = source.table.headers.dropFirst().first ?? ""
            delimiter = source.delimiter
            label = source.url.deletingPathExtension().lastPathComponent
        }
    }
}
