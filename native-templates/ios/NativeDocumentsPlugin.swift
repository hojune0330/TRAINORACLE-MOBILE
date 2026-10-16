import Foundation
import UIKit
import WebKit
import Capacitor

@objc(NativeDocumentsPlugin)
public class NativeDocumentsPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "NativeDocumentsPlugin"
    public let jsName = "NativeDocuments"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openLocalDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise)
    ]
    private let maxBytes = 32 * 1024 * 1024
    private var pendingCall: CAPPluginCall?
    private var transientDirectory: URL?

    static func safePath(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 2048, !value.hasPrefix("/"), !value.contains("%"), !value.contains("\\") else { return false }
        return value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            $0 != "." && $0 != ".." && $0.range(of: "^[A-Za-z0-9_-][A-Za-z0-9_.-]*$", options: .regularExpression) != nil
        }
    }
    static func safeExternal(_ value: String) -> URL? {
        guard !value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 92 }),
              value.range(of: "%0[ad]", options: [.regularExpression, .caseInsensitive]) == nil,
              let u = URL(string: value), let scheme = u.scheme?.lowercased() else { return nil }
        if scheme == "https", let host = u.host, !host.isEmpty, u.user == nil, u.password == nil { return u }
        if scheme == "mailto", !u.path.isEmpty { return u }
        return nil
    }

    @objc func saveDocument(_ call: CAPPluginCall) {
        guard let name = call.getString("filename"), !name.isEmpty, name.utf16.count <= 255, name != ".", name != "..",
              !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0.value == 47 || $0.value == 92 }),
              let mime = call.getString("mimeType"), ["application/json", "image/png"].contains(mime),
              let encoded = call.getString("dataBase64"), encoded.utf8.count <= ((maxBytes + 2) / 3) * 4,
              let bytes = Data(base64Encoded: encoded), bytes.count <= maxBytes else { call.reject("INVALID_DOCUMENT"); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.bridge?.viewController else { call.reject("UNAVAILABLE"); return }
            guard self.pendingCall == nil, presenter.presentedViewController == nil else { call.reject("BUSY"); return }
            // Export picker requires a transient local source. Cancel never writes to a chosen destination.
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NativeDocuments-" + UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                self.transientDirectory = directory
                var excluded = directory
                var values = URLResourceValues(); values.isExcludedFromBackup = true
                try? excluded.setResourceValues(values)
                let source = directory.appendingPathComponent(name, isDirectory: false)
                try bytes.write(to: source, options: [.atomic, .completeFileProtection])
                self.pendingCall = call
                let picker = UIDocumentPickerViewController(forExporting: [source], asCopy: true)
                picker.delegate = self
                presenter.present(picker, animated: true)
            } catch { self.cleanTransient(); call.reject("PICKER_UNAVAILABLE") }
        }
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingCall?.resolve(["status": "cancelled"]); pendingCall = nil; cleanTransient()
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pendingCall?.resolve(["status": urls.isEmpty ? "cancelled" : "saved"]); pendingCall = nil; cleanTransient()
    }
    private func cleanTransient() {
        if let directory = transientDirectory { try? FileManager.default.removeItem(at: directory) }
        transientDirectory = nil
    }
    deinit { cleanTransient() }

    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = Self.safeExternal(raw) else { call.reject("UNSAFE_URL"); return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("NO_HANDLER") }
            }
        }
    }
    @objc func openLocalDocument(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), Self.safePath(path), path.lowercased().hasSuffix(".html"),
              let root = Bundle.main.resourceURL?.appendingPathComponent("public", isDirectory: true) else { call.reject("UNSAFE_PATH"); return }
        let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let target = root.appendingPathComponent(path).resolvingSymlinksInPath().standardizedFileURL
        guard target.path.hasPrefix(canonicalRoot.path + "/"), FileManager.default.fileExists(atPath: target.path) else { call.reject("DOCUMENT_NOT_FOUND"); return }
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController, presenter.presentedViewController == nil else { call.reject("BUSY"); return }
            let viewer = StaticDocumentViewController(document: target, root: canonicalRoot)
            presenter.present(UINavigationController(rootViewController: viewer), animated: true)
            call.resolve()
        }
    }
}

private final class StaticDocumentViewController: UIViewController, WKNavigationDelegate {
    private let document: URL
    private let root: URL
    private var webView: WKWebView!
    init(document: URL, root: URL) { self.document = document; self.root = root; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "문서"
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "닫기", style: .done, target: self, action: #selector(closeDocument))
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.websiteDataStore = .nonPersistent()
        // Deny remote subresources, not only top-level navigation. Local CSS/images remain readable.
        let rules = "[{\"trigger\":{\"url-filter\":\"^(https?|wss?|ftp)://\"},\"action\":{\"type\":\"block\"}}]"
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "NativeDocumentsNoNetwork", encodedContentRuleList: rules) { [weak self] list, _ in
            guard let self = self, let list = list else { return }
            configuration.userContentController.add(list)
            let web = WKWebView(frame: .zero, configuration: configuration)
            self.webView = web; web.navigationDelegate = self
            web.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(web)
            NSLayoutConstraint.activate([
                web.leadingAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.leadingAnchor),
                web.trailingAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.trailingAnchor),
                web.topAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.topAnchor),
                web.bottomAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.bottomAnchor)
            ])
            web.loadFileURL(self.document, allowingReadAccessTo: self.root)
        }
    }
    @objc private func closeDocument() { dismiss(animated: true) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.navigationType == .linkActivated, let external = NativeDocumentsPlugin.safeExternal(url.absoluteString) {
            decisionHandler(.cancel); UIApplication.shared.open(external, options: [:], completionHandler: nil); return
        }
        let local = url.resolvingSymlinksInPath().standardizedFileURL
        if navigationAction.navigationType == .other, url.isFileURL, local == document { decisionHandler(.allow); return }
        decisionHandler(.cancel)
    }
}
