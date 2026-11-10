import AppKit
import Foundation
import GenesisKit
import GenesisKitCatalog
import SwiftUI

/// `genesis-kit-catalog`: draws every sheet of the component catalog to a PNG and writes a manifest of them.
/// It never shows a window and never takes focus (the process has no Dock icon and cannot activate).
@main
enum CatalogTool {
    struct Manifest: Codable {
        struct Look: Codable {
            let id: String
            let title: String
            let pitch: String
        }

        struct Variant: Codable {
            let title: String
            let props: String?
        }

        struct Section: Codable {
            let title: String
            let variants: [Variant]
        }

        struct Sheet: Codable {
            let look: String
            let title: String
            /// What this look changes for this component, when the look's own pitch does not say it.
            let note: String?
            let file: String
            let pixelWidth: Int
            let pixelHeight: Int
        }

        struct Entry: Codable {
            let id: String
            let group: String
            let name: String
            let summary: String
            let source: String
            let isNew: Bool
            let critique: [String]
            let sections: [Section]
            let sheets: [Sheet]
        }

        let sheetWidth: Int
        let scale: Int
        let looks: [Look]
        let entries: [Entry]
    }

    static let usage = """
    genesis-kit-catalog: draw the GenesisKit component catalog

      --out <dir>       write one PNG per sheet (<entry>.<look>.png) and manifest.json into <dir>
      --only <entry>    draw only this entry (repeat for more); the manifest is then not written
      --list            print the entries and their looks, draw nothing
      --probe <png>     draw the regression probe (today's controls in a fixed layout) to <png>
      --help            this text
    """

    @MainActor
    static func main() {
        var out: String?
        var only: [String] = []
        var list = false
        var probe: String?
        var arguments = Array(CommandLine.arguments.dropFirst())
        while !arguments.isEmpty {
            let flag = arguments.removeFirst()
            switch flag {
            case "--out": out = arguments.isEmpty ? nil : arguments.removeFirst()
            case "--only": if !arguments.isEmpty { only.append(arguments.removeFirst()) }
            case "--list": list = true
            case "--probe": probe = arguments.isEmpty ? nil : arguments.removeFirst()
            case "--help", "-h":
                print(usage)
                return
            default:
                FileHandle.standardError.write(Data("unknown argument: \(flag)\n\n\(usage)\n".utf8))
                exit(2)
            }
        }

        let entries = KitCatalog.entries
        if list {
            for entry in entries {
                print("\(entry.id)\t\(entry.group)\t\(entry.name)\t\(entry.looks.map(\.rawValue).joined(separator: ","))")
            }
            return
        }
        guard out != nil || probe != nil else {
            FileHandle.standardError.write(Data("nothing to do: pass --out, --probe or --list\n\n\(usage)\n".utf8))
            exit(2)
        }

        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.appearance = NSAppearance(named: .darkAqua)

        if let probe {
            guard let data = KitCatalogRenderer.png(of: KitClassicProbe(), width: KitClassicProbe.width) else {
                fail("the probe did not draw")
            }
            write(data, to: URL(fileURLWithPath: probe))
            print("probe \(probe)")
        }
        guard let out else { return }

        let unknown = only.filter { id in !entries.contains { $0.id == id } }
        if !unknown.isEmpty {
            fail("no such entry: \(unknown.joined(separator: ", ")). Known: \(entries.map(\.id).joined(separator: ", "))")
        }
        let directory = URL(fileURLWithPath: out, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            fail("cannot create \(out): \(error.localizedDescription)")
        }

        let scale: CGFloat = 2
        var manifest: [Manifest.Entry] = []
        for entry in entries where only.isEmpty || only.contains(entry.id) {
            var sheets: [Manifest.Sheet] = []
            for look in entry.looks {
                let file = "\(entry.id).\(look.rawValue).png"
                guard let data = KitCatalogRenderer.png(of: CatalogSheet(entry: entry, look: look), width: CatalogSheet.width, scale: scale),
                      let image = NSBitmapImageRep(data: data) else {
                    fail("\(file) did not draw")
                }
                write(data, to: directory.appendingPathComponent(file))
                sheets.append(Manifest.Sheet(
                    look: look.rawValue, title: entry.sheetTitle(look), note: entry.notes[look], file: file,
                    pixelWidth: image.pixelsWide, pixelHeight: image.pixelsHigh))
                print("\(file)\t\(image.pixelsWide)x\(image.pixelsHigh)")
            }
            manifest.append(Manifest.Entry(
                id: entry.id, group: entry.group, name: entry.name, summary: entry.summary, source: entry.source,
                isNew: entry.isNew, critique: entry.critique,
                sections: entry.sections.map { section in
                    Manifest.Section(title: section.title, variants: section.variants.map { .init(title: $0.title, props: $0.props) })
                },
                sheets: sheets))
        }

        guard only.isEmpty else {
            print("manifest.json not written: --only draws a part of the catalog")
            return
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        do {
            let data = try encoder.encode(Manifest(
                sheetWidth: Int(CatalogSheet.width), scale: Int(scale),
                looks: KitLook.allCases.map { .init(id: $0.rawValue, title: $0.catalogTitle, pitch: $0.catalogPitch) },
                entries: manifest))
            write(data, to: directory.appendingPathComponent("manifest.json"))
            print("manifest.json\t\(manifest.count) entries")
        } catch {
            fail("cannot encode the manifest: \(error.localizedDescription)")
        }
    }

    private static func write(_ data: Data, to url: URL) {
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            fail("cannot write \(url.path): \(error.localizedDescription)")
        }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("genesis-kit-catalog: \(message)\n".utf8))
        exit(1)
    }
}
