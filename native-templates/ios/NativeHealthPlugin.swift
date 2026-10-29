// UNREVIEWED candidate: Capacitor 8.5.3 / iOS 16+. Explicit opt-in only.
import Foundation
import UIKit
import WebKit
import HealthKit
import Capacitor

@objc(NativeHealthPlugin)
public final class NativeHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeHealthPlugin"
    public let jsName = "NativeHealth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginContext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "invalidateContext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "invalidateSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readRunningWorkouts", returnType: CAPPluginReturnPromise)
    ]
    private let store = HKHealthStore()
    private var gate: NativeHealthMessageGate?
    // Source-only fail-closed gate: real router/auth consumer is NOT integrated. JS cannot enable this.
    private let consumerIntegrationReviewed = false
    private struct Binding {
        let document: Int; let context: Int; let session: Int; let lifecycle: Int
        let token: String; let requestId: String
    }
    private var tickets: [String: (Date, Int, Int, Int, Int)] = [:]
    private var generation = 0 // documentEpoch, including same-URL reloads
    private var contextEpoch = 0
    private var sessionEpoch = 0
    private var lifecycleEpoch = 0
    private var contextToken: String?
    private var usedRequestIds = Set<String>()
    private var active: (Binding, CAPPluginCall)?
    private var busy = false
    private var phase = "idle"
    private var activeQuery: HKSampleQuery?
    private weak var consentAlert: UIAlertController?
    private var deferredAuthorization: (() -> Void)?
    private var observers: [NSObjectProtocol] = []
    private var loadingObservation: NSKeyValueObservation?

    public override func load() {
        // No HealthKit call or permission prompt at startup. Keep Capacitor's delegate.
        guard let cap = bridge as? CapacitorBridge, let web = bridge?.webView else { return }
        let handler = NativeHealthMessageGate(plugin: self, downstream: cap.webViewDelegationHandler)
        gate = handler
        web.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        web.configuration.userContentController.add(handler, name: "bridge")
        // Also invalidate for reloads even if another plugin handles navigation first.
        loadingObservation = web.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            guard change.newValue == true, let self = self else { return }
            self.generation += 1
            self.invalidate(session: false)
        }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            // System Health permission UI may temporarily make the app inactive. Queries may not continue.
            if self.phase != "permission" { self.lifecycleEpoch += 1; self.invalidate(session: false) }
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.lifecycleEpoch += 1
            self.invalidate(session: false) // Actual background cancels permission requests too.
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            let completion = self?.deferredAuthorization
            self?.deferredAuthorization = nil
            completion?() // Revalidate, never start another HealthKit request.
        })
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    fileprivate func trusted(_ url: URL?) -> Bool {
        guard let u = url else { return false }
        return u.scheme == "capacitor" && u.host == "localhost" && u.port == nil && u.user == nil && u.password == nil
            && !u.path.hasPrefix("/_capacitor_http_interceptor_")
    }
    private func foreground() -> Bool {
        UIApplication.shared.applicationState == .active && bridge?.viewController?.view.window?.windowScene?.activationState == .foregroundActive
    }
    private func drop(_ call: CAPPluginCall) {
        // Stale calls must not resolve OR reject into the current/new document.
        call.keepAlive = false
        bridge?.releaseCall(call)
    }
    fileprivate func invalidate(session: Bool) {
        contextEpoch += 1
        if session { sessionEpoch += 1 }
        contextToken = nil
        tickets.removeAll()
        usedRequestIds.removeAll()
        if let query = activeQuery { store.stop(query) }
        activeQuery = nil
        deferredAuthorization = nil
        consentAlert?.dismiss(animated: false)
        consentAlert = nil
        if let pending = active { drop(pending.1) }
        active = nil
        busy = false
        phase = "idle"
    }
    fileprivate func issueTicket(_ callback: String) {
        tickets = tickets.filter { $0.value.0 > Date() }
        if tickets.count >= 32 { tickets.removeAll() }
        tickets[callback] = (Date().addingTimeInterval(5), generation, contextEpoch, sessionEpoch, lifecycleEpoch)
    }
    private func consume(_ call: CAPPluginCall) -> Bool {
        guard let ticket = tickets.removeValue(forKey: call.callbackId), ticket.0 > Date(), ticket.1 == generation,
              ticket.2 == contextEpoch, ticket.3 == sessionEpoch, ticket.4 == lifecycleEpoch,
              trusted(bridge?.webView?.url), bridge?.webView?.isLoading == false, gate != nil, foreground() else {
            drop(call); return false
        }
        return true
    }
    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        generation += 1
        invalidate(session: false)
        if !trusted(navigationAction.request.url) { return NSNumber(value: true) }
        return nil
    }
    private func sameContext(_ b: Binding) -> Bool {
        let value = b.document
        return generation == value && b.context == contextEpoch && b.session == sessionEpoch && b.lifecycle == lifecycleEpoch
            && b.token == contextToken && active?.0.requestId == b.requestId
            && trusted(bridge?.webView?.url) && bridge?.webView?.isLoading == false
    }
    private func current(_ b: Binding) -> Bool { sameContext(b) && foreground() }
    private func finish(_ b: Binding, _ call: CAPPluginCall, result: [String: Any]? = nil, error: String? = nil) {
        guard current(b) else { drop(call); return }
        active = nil; activeQuery = nil; busy = false; phase = "idle"; consentAlert = nil
        // Main queue: no async hop between binding/foreground check and delivery.
        if let error = error { call.reject(error) } else { call.resolve(result ?? [:]) }
    }
    private func bind(_ call: CAPPluginCall) -> Binding? {
        guard consume(call) else { return nil }
        guard consumerIntegrationReviewed else { call.reject("CONTEXT_CONSUMER_NOT_INTEGRATED"); return nil }
        guard let token = contextToken, token == call.getString("contextToken"),
              call.getInt("documentEpoch") == generation, call.getInt("contextEpoch") == contextEpoch, call.getInt("sessionEpoch") == sessionEpoch,
              let request = call.getString("requestId"), !request.isEmpty, request.count <= 128,
              !usedRequestIds.contains(request), usedRequestIds.count < 1024 else { drop(call); return nil }
        guard !busy else { call.reject("BUSY"); return nil }
        let b = Binding(document: generation, context: contextEpoch, session: sessionEpoch, lifecycle: lifecycleEpoch, token: token, requestId: request)
        usedRequestIds.insert(request)
        active = (b, call)
        busy = true
        return b
    }
    @objc func beginContext(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.consume(call) else { return }
            guard self.consumerIntegrationReviewed else { call.reject("CONTEXT_CONSUMER_NOT_INTEGRATED"); return }
            self.invalidate(session: false)
            let token = UUID().uuidString
            self.contextToken = token
            call.resolve(["documentEpoch": self.generation, "contextEpoch": self.contextEpoch, "sessionEpoch": self.sessionEpoch, "contextToken": token])
        }
    }
    @objc func invalidateContext(_ call: CAPPluginCall) { acknowledgeInvalidation(call) }
    @objc func invalidateSession(_ call: CAPPluginCall) { acknowledgeInvalidation(call) }
    private func acknowledgeInvalidation(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.consume(call) else { return }
            call.resolve(["invalidated": true])
        }
    }
    @objc func availability(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.consume(call) else { return }
            call.resolve(["available": HKHealthStore.isHealthDataAvailable(), "enabled": self.consumerIntegrationReviewed, "blockedReason": "CONTEXT_CONSUMER_NOT_INTEGRATED", "readAuthorization": "unknown", "reviewStatus": "UNREVIEWED"])
        }
    }
    private func begin(_ call: CAPPluginCall, binding: Binding? = nil, title: String, message: String, accepted: @escaping (Binding) -> Void) {
        guard let version = binding ?? bind(call) else { return }
        guard current(version) else { drop(call); return }
        guard HKHealthStore.isHealthDataAvailable() else { finish(version, call, error: "HEALTH_UNAVAILABLE"); return }
        guard let presenter = bridge?.viewController, presenter.presentedViewController == nil else { finish(version, call, error: "BUSY_OR_INACTIVE"); return }
        phase = "consent"
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        consentAlert = alert
        alert.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in self.finish(version, call, error: "USER_CANCELLED") })
        alert.addAction(UIAlertAction(title: "계속", style: .default) { _ in
            guard self.current(version) else { self.drop(call); return }
            self.consentAlert = nil
            accepted(version)
        })
        presenter.present(alert, animated: true)
    }
    @objc func requestAuthorization(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.begin(call, title: "Apple 건강 읽기 권한", message: "달리기 운동 날짜·시간·거리만 읽습니다. 쓰기, GPS 경로, 메모는 요청하지 않습니다.") { version in
                guard self.current(version) else { self.drop(call); return }
                self.phase = "permission"
                self.store.requestAuthorization(toShare: Set<HKSampleType>(), read: Set<HKObjectType>([HKObjectType.workoutType()])) { completed, error in
                    DispatchQueue.main.async {
                        guard self.sameContext(version) else { self.drop(call); return }
                        let completion = { [weak self] in
                            guard let self = self else { return }
                            // Success means request completed, not that read permission was granted.
                            self.finish(version, call, result: ["requestCompleted": true, "readAuthorization": "unknown", "reviewStatus": "UNREVIEWED", "requestId": version.requestId, "documentEpoch": version.document, "contextEpoch": version.context, "sessionEpoch": version.session], error: error == nil && completed ? nil : "AUTHORIZATION_REQUEST_FAILED")
                        }
                        if self.foreground() { completion() }
                        else { self.deferredAuthorization = completion }
                    }
                }
            }
        }
    }
    @objc func readRunningWorkouts(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Bind validation errors too, so an old session never receives even an error.
            guard let binding = self.bind(call) else { return }
            let now = Date()
            func parse(_ raw: String?) -> Date? {
                guard let raw = raw else { return nil }
                let format = ISO8601DateFormatter()
                format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return format.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
            }
            let start = parse(call.getString("start")) ?? now.addingTimeInterval(-30 * 86400)
            let end = parse(call.getString("end")) ?? now
            let limit = call.getDouble("limit") ?? 50
            guard (call.options["start"] == nil || parse(call.getString("start")) != nil),
                  (call.options["end"] == nil || parse(call.getString("end")) != nil),
                  (call.options["limit"] == nil || call.getDouble("limit") != nil),
                  limit.isFinite, limit.rounded() == limit, limit >= 1, limit <= 100,
                  start >= now.addingTimeInterval(-90 * 86400), start < end, end <= now,
                  end.timeIntervalSince(start) <= 90 * 86400 else {
                self.finish(binding, call, error: "INVALID_QUERY")
                return
            }
            self.begin(call, binding: binding, title: "최근 달리기 가져오기", message: "선택 기간의 최대 \(Int(limit))개 달리기를 미검토 후보로 읽습니다. 기존 기록은 변경하지 않으며 저장·계정 전송은 별도 확인이 필요합니다.") { version in
                guard self.current(version) else { self.drop(call); return }
                self.phase = "query"
                let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
                    HKQuery.predicateForWorkouts(with: .running),
                    HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate, .strictEndDate])
                ])
                let query = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate, limit: Int(limit), sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]) { _, samples, error in
                    DispatchQueue.main.async {
                        guard self.current(version) else { self.drop(call); return }
                        guard error == nil else { self.finish(version, call, error: "HEALTH_QUERY_FAILED"); return }
                        let formatter = ISO8601DateFormatter()
                        let rows: [[String: Any]] = (samples as? [HKWorkout] ?? []).map { workout in
                            var row: [String: Any] = ["uuid": workout.uuid.uuidString, "start": formatter.string(from: workout.startDate), "end": formatter.string(from: workout.endDate), "durationSeconds": workout.duration]
                            if let distance = workout.totalDistance?.doubleValue(for: .meter()), distance.isFinite, distance >= 0 { row["distanceMeters"] = distance }
                            else { row["distanceMeters"] = NSNull() }
                            return row
                        }
                        self.finish(version, call, result: ["source": "apple-healthkit", "reviewStatus": "UNREVIEWED", "readAuthorization": "unknown", "workouts": rows, "emptyDoesNotMeanDenied": true, "requestId": version.requestId, "documentEpoch": version.document, "contextEpoch": version.context, "sessionEpoch": version.session])
                    }
                }
                self.activeQuery = query
                self.store.execute(query)
            }
        }
    }
}

// Capacitor 8.5.3 CAPPluginCall loses WKFrameInfo. Gate the original WK message,
// preserving its downstream result handling and all unrelated plugin messages.
private final class NativeHealthMessageGate: NSObject, WKScriptMessageHandler {
    weak var plugin: NativeHealthPlugin?
    weak var downstream: WebViewDelegationHandler?
    init(plugin: NativeHealthPlugin, downstream: WebViewDelegationHandler) { self.plugin = plugin; self.downstream = downstream }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { downstream?.userContentController(controller, didReceive: message); return }
        let isHealth = body["pluginId"] as? String == "NativeHealth" || body["service"] as? String == "NativeHealth"
        guard isHealth else { downstream?.userContentController(controller, didReceive: message); return }
        guard let plugin = plugin, body["type"] as? String == "message", message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "capacitor", message.frameInfo.securityOrigin.host == "localhost",
              message.frameInfo.securityOrigin.port == 0, plugin.trusted(message.frameInfo.request.url),
              plugin.trusted(message.webView?.url), let method = body["methodName"] as? String,
              ["availability", "beginContext", "invalidateContext", "invalidateSession", "requestAuthorization", "readRunningWorkouts"].contains(method),
              let callback = body["callbackId"] as? String, !callback.isEmpty, callback.count <= 128 else { return }
        // Synchronous control channel runs before any queued native result can deliver.
        if method == "invalidateContext" || method == "invalidateSession" { plugin.invalidate(session: method == "invalidateSession") }
        plugin.issueTicket(callback)
        downstream?.userContentController(controller, didReceive: message)
    }
}
