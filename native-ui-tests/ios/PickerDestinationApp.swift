import SwiftUI
import Foundation

@main
struct PickerDestinationApp: App {
    private let ready: Bool
    init() {
        let manager = FileManager.default
        do {
            let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let folder = documents.appendingPathComponent("NativeJSONSave", isDirectory: true)
            try manager.createDirectory(at: folder, withIntermediateDirectories: true)
            let values = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            // Never reset, import, remove, or overwrite an existing destination.
            let entries = try manager.contentsOfDirectory(atPath: folder.path)
            ready = values.isDirectory == true && values.isSymbolicLink != true && entries.isEmpty
        } catch { ready = false }
    }
    var body: some Scene {
        WindowGroup {
            Text(ready ? "CI destination ready" : "CI destination not fresh")
                .accessibilityIdentifier(ready ? "ci-destination-ready" : "ci-destination-not-fresh")
        }
    }
}
