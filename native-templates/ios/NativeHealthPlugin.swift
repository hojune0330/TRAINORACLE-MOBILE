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
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readRunningWorkouts", returnType: CAPPluginReturnPromise)
    ]
    private let store = HKHealthStore()
    private var gate: NativeHealthMessageGate?
    private var tickets: [String: (Date, Int)] = [:]
    private var generation = 0
    private var busy = false
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
            self.tickets.removeAll()
        }
    }
    fileprivate func trusted(_ url: URL?) -> Bool {
        guard let u = url else { return false }
        return u.scheme == "capacitor" && u.host == "localhost" && u.port == nil && u.user == nil && u.password == nil
            && !u.path.hasPrefix("/_capacitor_http_interceptor_")
    }
    fileprivate func issueTicket(_ callback: String) {
        tickets = tickets.filter { $0.value.0 > Date() }
        if tickets.count >= 32 { tickets.removeAll() }
        tickets[callback] = (Date().addingTimeInterval(5), generation)
    }
    private func consume(_ call: CAPPluginCall) -> Bool {
        guard let ticket = tickets.removeValue(forKey: call.callbackId), ticket.0 > Date(), ticket.1 == generation,
              trusted(bridge?.webView?.url), bridge?.webView?.isLoading == false, gate != nil else {
            call.reject("UNTRUSTED_CONTEXT"); return false
        }
        return true
    }
    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        generation += 1
        tickets.removeAll()
        if !trusted(navigationAction.request.url) { return NSNumber(value: true) }
        return nil
    }
    private func current(_ value: Int) -> Bool {
        generation == value && trusted(bridge?.webView?.url) && bridge?.webView?.isLoading == false
    }
    @objc func availability(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.consume(call) else { return }
            call.resolve(["available": HKHealthStore.isHealthDataAvailable(), "readAuthorization": "unknown", "reviewStatus": "UNREVIEWED"])
        }
    }
    private func begin(_ call: CAPPluginCall, title: String, message: String, accepted: @escaping (Int) -> Void) {
        guard consume(call) else { return }
        guard HKHealthStore.isHealthDataAvailable() else { call.reject("HEALTH_UNAVAILABLE"); return }
        guard !busy, let presenter = bridge?.viewController, presenter.presentedViewController == nil,
              presenter.view.window?.windowScene?.activationState == .foregroundActive else { call.reject("BUSY_OR_INACTIVE"); return }
        busy = true
        let version = generation
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in self.busy = false; call.reject("USER_CANCELLED") })
        alert.addAction(UIAlertAction(title: "계속", style: .default) { _ in
            guard self.current(version) else { self.busy = false; call.reject("CONTEXT_CHANGED"); return }
            accepted(version)
        })
        presenter.present(alert, animated: true)
    }
    @objc func requestAuthorization(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.begin(call, title: "Apple 건강 읽기 권한", message: "달리기 운동 날짜·시간·거리만 읽습니다. 쓰기, GPS 경로, 메모는 요청하지 않습니다.") { version in
                self.store.requestAuthorization(toShare: Set<HKSampleType>(), read: Set<HKObjectType>([HKObjectType.workoutType()])) { completed, error in
                    DispatchQueue.main.async {
                        self.busy = false
                        guard self.current(version) else { call.reject("CONTEXT_CHANGED"); return }
                        guard error == nil, completed else { call.reject("AUTHORIZATION_REQUEST_FAILED"); return }
                        // Completion is NOT proof that read authorization was granted.
                        call.resolve(["requestCompleted": true, "readAuthorization": "unknown", "reviewStatus": "UNREVIEWED"])
                    }
                }
            }
        }
    }
    @objc func readRunningWorkouts(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
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
                  end.timeIntervalSince(start) <= 90 * 86400 else { call.reject("INVALID_QUERY"); return }
            self.begin(call, title: "최근 달리기 가져오기", message: "선택 기간의 최대 \(Int(limit))개 달리기를 미검토 후보로 읽습니다. 기존 기록은 변경하지 않으며 저장·계정 전송은 별도 확인이 필요합니다.") { version in
                let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
                    HKQuery.predicateForWorkouts(with: .running),
                    HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate, .strictEndDate])
                ])
                let query = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate, limit: Int(limit), sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]) { _, samples, error in
                    DispatchQueue.main.async {
                        self.busy = false
                        guard self.current(version) else { call.reject("CONTEXT_CHANGED"); return }
                        guard error == nil else { call.reject("HEALTH_QUERY_FAILED"); return }
                        let formatter = ISO8601DateFormatter()
                        let rows: [[String: Any]] = (samples as? [HKWorkout] ?? []).map { workout in
                            var row: [String: Any] = ["uuid": workout.uuid.uuidString, "start": formatter.string(from: workout.startDate), "end": formatter.string(from: workout.endDate), "durationSeconds": workout.duration]
                            if let distance = workout.totalDistance?.doubleValue(for: .meter()), distance.isFinite, distance >= 0 { row["distanceMeters"] = distance }
                            else { row["distanceMeters"] = NSNull() }
                            return row
                        }
                        call.resolve(["source": "apple-healthkit", "reviewStatus": "UNREVIEWED", "readAuthorization": "unknown", "workouts": rows, "emptyDoesNotMeanDenied": true])
                    }
                }
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
              ["availability", "requestAuthorization", "readRunningWorkouts"].contains(method),
              let callback = body["callbackId"] as? String, !callback.isEmpty, callback.count <= 128 else { return }
        plugin.issueTicket(callback)
        downstream?.userContentController(controller, didReceive: message)
    }
}
