import GenesisKit
import SwiftUI

struct RecastRegionSheet: View {
    @ObservedObject var model: RecastModel
    @Environment(\.dismiss) private var dismiss
    @State private var x = 0.0
    @State private var y = 0.0
    @State private var width = 100.0
    @State private var height = 100.0
    @State private var first = 1
    @State private var last = 1
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Select a source region").font(.system(size: 20, weight: .semibold))
            Text(model.source?.name ?? "Choose a source first").font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            if model.source?.kind == "text" {
                Text("Character positions within the currently displayed page.").font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                HStack {
                    numberField("First character", value: $first)
                    numberField("Last character", value: $last)
                }
            } else if ["image", "pdf"].contains(model.source?.kind ?? "") {
                Text("Percentages of the page, measured from its bottom-left corner. You can also drag a rectangle on the source.")
                    .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                HStack {
                    percentageField("Left", value: $x)
                    percentageField("Bottom", value: $y)
                }
                HStack {
                    percentageField("Width", value: $width)
                    percentageField("Height", value: $height)
                }
            } else {
                Text("Choose an image, PDF, or text source to select a region.").font(.system(size: 12))
            }
            if let error { NoticePill(text: error, isError: true) { self.error = nil } }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                Button("Select") { select() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction)
                    .disabled(model.busy || model.previewBusy || !["image", "pdf", "text"].contains(model.source?.kind ?? ""))
            }
        }.padding(22).frame(width: 540).preferredColorScheme(.dark)
        .onAppear {
            if let region = model.selectedRegion {
                x = region.x * 100; y = region.y * 100; width = region.width * 100; height = region.height * 100
            }
            last = max(1, model.sourceText.count)
        }
    }

    private func numberField(_ label: String, value: Binding<Int>) -> some View {
        VStack(alignment: .leading) {
            Text(label).font(.system(size: 11))
            TextField(label, value: value, format: .number.grouping(.never)).textFieldStyle(.roundedBorder).accessibilityLabel(label)
        }
    }

    private func percentageField(_ label: String, value: Binding<Double>) -> some View {
        VStack(alignment: .leading) {
            Text(label + " (%)").font(.system(size: 11))
            TextField(label, value: value, format: .number.grouping(.never)).textFieldStyle(.roundedBorder).accessibilityLabel(label)
        }
    }

    private func select() {
        if model.source?.kind == "text" {
            let text = model.sourceText
            guard first >= 1, last >= first, last <= text.count else {
                error = "Choose character positions inside the displayed text."
                return
            }
            let start = text.index(text.startIndex, offsetBy: first - 1)
            let end = text.index(text.startIndex, offsetBy: last)
            model.selectedAnchor = ""
            model.textSelection = NSRange(start..<end, in: text)
        } else {
            let region = NativeSourceRect(x: x / 100, y: y / 100, width: width / 100, height: height / 100)
            guard region.isValid else {
                error = "The selected rectangle must have a positive size and fit inside the page."
                return
            }
            model.selectedAnchor = ""; model.selectedRegion = region
        }
        dismiss()
    }
}
