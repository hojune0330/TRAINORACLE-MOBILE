import Foundation
import UIKit
import Capacitor

// Main.storyboard bridge controller class (module: App).
// No startup/foreground changes to existing user-store metadata here.
final class NativeBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeDocumentsPlugin())
    }
}

// Explicit integration only: call synchronously BEFORE ANY WebView/storage writer
// is constructed. The bridge lifecycle is too late to guarantee that ordering.
// Never call from foreground, view appearance, or after records are loaded.
enum NativeStoreBackupPreparation {
    static func prepareBeforeWebViewCreation() {
        let manager = FileManager.default
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL
        let paths = ["Documents", "Library/WebKit", "Library/Application Support", "Library/Caches/WebKit"]
        for path in paths {
            var directory = home.appendingPathComponent(path, isDirectory: true).standardizedFileURL
            // Never follow a symbolic link outside (or elsewhere inside) the sandbox.
            guard directory.resolvingSymlinksInPath().standardizedFileURL == directory else { continue }
            do {
                if !manager.fileExists(atPath: directory.path) {
                    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
                }
                let attributes = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard attributes.isDirectory == true, attributes.isSymbolicLink != true else { continue }
                // Inspect entry names ONLY to establish emptiness; never open stored values.
                let entries = try manager.contentsOfDirectory(atPath: directory.path)
                guard entries.isEmpty else { continue }
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try directory.setResourceValues(values)
            } catch {
                // Best effort only. Never delete, move, repair or log user-store data.
                continue
            }
        }
    }
}
