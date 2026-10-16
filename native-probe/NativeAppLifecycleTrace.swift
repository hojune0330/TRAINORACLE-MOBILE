#if DEBUG && TRAINORACLE_NATIVE_CI_PROBE
import Foundation
import UIKit
import WebKit

// CI-only observer. No replacement controller, JavaScript, UI contents, URLs,
// arguments/environment values or existing user-store metadata are inspected.
@MainActor
enum NativeAppLifecycleTrace {
    private static var installed = false
    private static var observer: NSObjectProtocol?
    private static var activationObserved = false
    private static var collectorInvoked = false

    static func install() {
        precondition(Thread.isMainThread)
        guard !installed else { return }
        installed = true
        // Prove AppDelegate entry even if no phase signal or window is present.
        snapshot(discoverWindow: false)
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main
        ) { _ in
            Task { @MainActor in
                activationObserved = true
                scheduleSnapshots()
            }
        }
        // Also covers installation after activation. Discovery always runs on a
        // subsequent main-loop turn, never forces a controller's view to load.
        if UIApplication.shared.applicationState == .active {
            activationObserved = true
        }
        scheduleSnapshots()
    }

    private static func scheduleSnapshots() {
        DispatchQueue.main.async { snapshot(discoverWindow: true) }
        // Bounded scene-connection retries; no callback-dependent JS polling.
        for delay in [0.5, 2.0, 5.0, 15.0, 45.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                snapshot(discoverWindow: true)
            }
        }
    }

    private static func snapshot(discoverWindow: Bool) {
        precondition(Thread.isMainThread)
        let app = UIApplication.shared
        let phase = ProcessInfo.processInfo.environment["TRAINORACLE_NATIVE_PROBE"]
        let arguments = ProcessInfo.processInfo.arguments
        let flag = arguments.firstIndex(of: "--trainoracle-native-probe")
        let argumentPhase = flag.flatMap { index in
            arguments.indices.contains(index + 1) ? arguments[index + 1] : nil
        }
        let known = ["1", "write", "read"]
        let windows = discoverWindow ? app.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows } : []
        let window = windows.first { $0.isKeyWindow && $0.windowScene?.activationState == .foregroundActive }
            ?? windows.first { $0.isKeyWindow }
        let root = window?.rootViewController
        let controllers = root.map(controllerHierarchy) ?? []
        let named = controllers.first { $0 is NativeBridgeViewController }
        // Traverse actual instantiated UIView objects only. Never access text,
        // accessibility labels, DOM, storage, URL or any user data.
        let webView = window.flatMap(firstWebView)
        var result: [String: Any] = [
            "appDelegateEntryReached": installed,
            "activationObserved": activationObserved,
            "applicationActive": app.applicationState == .active,
            "environmentPhasePresent": phase != nil,
            "environmentPhaseRecognized": phase.map { known.contains($0) } ?? false,
            "argumentFlagPresent": flag != nil,
            "argumentPhaseRecognized": argumentPhase.map { known.contains($0) } ?? false,
            "keyWindowFound": window != nil,
            "rootControllerFound": root != nil,
            "namedControllerFound": named != nil,
            "webViewFound": webView != nil,
            "collectorInvoked": collectorInvoked,
            "processIdentifier": ProcessInfo.processInfo.processIdentifier
        ]
        if let root { result["rootControllerClass"] = String(reflecting: type(of: root)) }
        if let named { result["namedControllerClass"] = String(reflecting: type(of: named)) }
        if let webView { result["webViewClass"] = String(reflecting: type(of: webView)) }
        write(result)
        if app.applicationState == .active, let webView, !collectorInvoked {
            collectorInvoked = true
            result["collectorInvoked"] = true
            write(result)
            // Parent collector remains authoritative for phase/readiness/gates.
            NativeReleaseProbe.attach(to: webView)
        }
    }

    private static func controllerHierarchy(_ root: UIViewController) -> [UIViewController] {
        var pending = [root]
        var found: [UIViewController] = []
        var visited = Set<ObjectIdentifier>()
        while let controller = pending.popLast(), found.count < 256 {
            guard visited.insert(ObjectIdentifier(controller)).inserted else { continue }
            found.append(controller)
            pending.append(contentsOf: controller.children)
            if let presented = controller.presentedViewController { pending.append(presented) }
        }
        return found
    }

    private static func firstWebView(_ root: UIView) -> WKWebView? {
        var pending = [root]
        var visited = 0
        while let view = pending.popLast(), visited < 20000 {
            visited += 1
            if let webView = view as? WKWebView { return webView }
            pending.append(contentsOf: view.subviews)
        }
        return nil
    }

    private static func write(_ result: [String: Any]) {
        let manager = FileManager.default
        guard let caches = manager.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { return }
        let folder = caches.appendingPathComponent("TrainOracleNativeCI", isDirectory: true)
        // Only this CI-owned directory/file is created or replaced. No backup
        // flags or attributes of existing user records are read or changed.
        do {
            try manager.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: folder.appendingPathComponent("native-app-lifecycle.json"), options: [.atomic])
        } catch {
            // Do not log errors containing sandbox paths or user information.
        }
    }
}
#endif
