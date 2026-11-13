import Foundation

/// A portable board built from the same manifest as the rendered sheets: `index.html`, its style and script (the
/// `Board` resources) and the manifest as `catalog-data.js`, all in the folder that holds the sheets. A page opened
/// from disk may not fetch `manifest.json`, so the manifest is a script file, base64-encoded so that no catalog text
/// is read as script. All catalog text enters the document through textContent.
enum CatalogBoard {
    enum BoardError: LocalizedError {
        case missingResource(String)

        var errorDescription: String? {
            switch self {
            case .missingResource(let name): return "the board resource \(name) is not in this build"
            }
        }
    }

    static let resources = ["catalog-board.css", "catalog-board.js"]

    /// Every file of the board, by its name in the output folder.
    static func files(manifest: Data) throws -> [(name: String, data: Data)] {
        var files: [(name: String, data: Data)] = [
            ("index.html", Data(html.utf8)),
            ("catalog-data.js", Data("window.genesisKitCatalog=\"\(manifest.base64EncodedString())\";\n".utf8)),
        ]
        for name in resources {
            guard let url = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Board") else {
                throw BoardError.missingResource(name)
            }
            files.append((name, try Data(contentsOf: url)))
        }
        return files
    }

    static let html = #"""
    <!doctype html>
    <html lang="en">
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>GenesisKit component catalog</title>
    <link rel="stylesheet" href="catalog-board.css">
    <header><h1>GenesisKit component catalog</h1><p>Real native controls, rendered from the current source. Compare the same states across the classic appearance and the three proposed looks. Open a sheet at full size to inspect its text and spacing.</p></header>
    <nav aria-label="Catalog filters">
    <label>Search <input id="query" type="search" placeholder="Component, purpose or source"></label>
    <label>Group <select id="group"><option value="">All groups</option></select></label>
    <label>Appearance <select id="look"><option value="">Compare all looks</option></select></label>
    <output id="count" aria-live="polite"></output></nav>
    <main id="catalog"></main>
    <script src="catalog-data.js"></script>
    <script src="catalog-board.js"></script></html>
    """#
}
