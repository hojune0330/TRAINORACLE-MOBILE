#if DEBUG
import Foundation
import UIKit
import WebKit

// Explicit CI activation only. No user fields, keys, journal values or credentials.
@MainActor
enum NativeReleaseProbe {
    private static var attached=Set<ObjectIdentifier>()
    private static func requestedFilePhase() -> String? {
        #if TRAINORACLE_NATIVE_CI_PROBE
        let url=URL(fileURLWithPath:NSHomeDirectory()).appendingPathComponent("Library/Caches/TrainOracleNativeCI/native-probe-request.json")
        guard let handle=try? FileHandle(forReadingFrom:url) else { return nil }
        defer { try? handle.close() }
        guard let data=try? handle.read(upToCount:1025), data.count <= 1024,
              let request=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              let phase=request["phase"] as? String, ["write","read"].contains(phase) else { return nil }
        return phase
        #else
        return nil
        #endif
    }
    private final class State {
        let phase: String
        var stage="activated"
        var finished=false
        init(phase: String) { self.phase=phase }
    }
    static func attach(to webView: WKWebView?) {
        let valid=["1","write","read"]
        let environmentPhase=ProcessInfo.processInfo.environment["TRAINORACLE_NATIVE_PROBE"]
        let arguments=ProcessInfo.processInfo.arguments
        let flagIndex=arguments.firstIndex(of: "--trainoracle-native-probe")
        let argumentPhase=flagIndex.flatMap { index in arguments.indices.contains(index+1) ? arguments[index+1] : nil }
        let filePhase=requestedFilePhase()
        let phase=environmentPhase.flatMap { valid.contains($0) ? $0 : nil } ?? argumentPhase.flatMap { valid.contains($0) ? $0 : nil } ?? filePhase
        #if TRAINORACLE_NATIVE_CI_PROBE
        write(["attachReached":true,"environmentPhasePresent":environmentPhase != nil,"argumentFlagPresent":flagIndex != nil,"filePhaseAccepted":filePhase != nil,"phaseAccepted":phase != nil,"webViewPresent":webView != nil], file:"native-probe-signal.json")
        #endif
        guard environmentPhase != nil || flagIndex != nil || filePhase != nil else { return }
        var responder: UIResponder?=webView
        var controllerClass="none"
        while let current=responder {
            if let controller=current as? UIViewController { controllerClass=NSStringFromClass(type(of: controller)); break }
            responder=current.next
        }
        write(["activationReached":true,"phaseAccepted":phase != nil,"phase":phase ?? "invalid","webViewPresent":webView != nil,"controllerClass":controllerClass,"processIdentifier":ProcessInfo.processInfo.processIdentifier], file: "native-probe-activation.json")
        guard let phase, let webView else {
            write(["probeReady":false,"failure":phase == nil ? "activation-phase-invalid" : "webview-missing"])
            return
        }
        guard attached.insert(ObjectIdentifier(webView)).inserted else { return }
        let state=State(phase: phase)
        stage("activated", state: state)
        // Independent wall-clock deadline: a missing JS callback cannot suppress failure.
        DispatchQueue.main.asyncAfter(deadline: .now()+120) {
            finish(["probeReady":false,"failure":"native-watchdog-timeout","storageStage":state.phase,"lastStage":state.stage], state: state)
        }
        waitForBootstrap(webView, state: state)
    }
    private static func stage(_ value: String, state: State) {
        guard !state.finished else { return }
        state.stage=value
        write(["phase":state.phase,"stage":value], file: "native-probe-progress.json")
    }
    private static func finish(_ value: [String:Any], state: State) {
        guard !state.finished else { return }
        state.finished=true
        write(value)
    }
    private static func waitForBootstrap(_ webView: WKWebView, state: State) {
        guard !state.finished else { return }
        let nativeReady=webView.window != nil && !webView.isLoading && webView.url?.scheme == "capacitor" && webView.url?.host == "localhost"
        guard nativeReady else {
            stage("waiting-for-native-navigation", state: state)
            DispatchQueue.main.asyncAfter(deadline: .now()+0.5) { waitForBootstrap(webView, state: state) }
            return
        }
        stage("bootstrap-evaluation-submitted", state: state)
        webView.evaluateJavaScript("document.readyState === 'complete' && Boolean(window.__NATIVE_CAPABILITIES__)") { value, _ in
            guard !state.finished else { return }
            stage("bootstrap-callback-received", state: state)
            if value as? Bool == true { run(webView, phase: state.phase, state: state) }
            else { DispatchQueue.main.asyncAfter(deadline: .now()+0.5) { waitForBootstrap(webView, state: state) } }
        }
    }
    private static func run(_ webView: WKWebView, phase: String, state: State) {
        guard !state.finished else { return }
        stage("runtime-submitted", state: state)
        let script = #"""
        const c = window.__NATIVE_CAPABILITIES__ || {};
        const result = {probeReady:true, storageStage:phase, secureContext:c.secureContext===true, locksAvailable:c.locksRequest===true, cryptoAvailable:c.cryptoSubtle===true, indexedDBAvailable:c.indexedDB===true, localStorageAvailable:c.localStorage===true, nativeDocumentsAvailable:window.Capacitor?.isPluginAvailable('NativeDocuments')===true, appPluginAvailable:window.Capacitor?.isPluginAvailable('App')===true};
        try { let done=false; await navigator.locks.request('__trainoracle_native_ci_probe__', {mode:'exclusive'}, async()=>{done=true;}); result.realLock=done; } catch { result.realLock=false; }
        try {
          const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
          const iv=crypto.getRandomValues(new Uint8Array(12));
          const data=new TextEncoder().encode('TRAINORACLE_NATIVE_CI_PROBE');
          const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data);
          const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,encrypted);
          result.cryptoRoundTrip=new TextDecoder().decode(decrypted)==='TRAINORACLE_NATIVE_CI_PROBE';
        } catch {result.cryptoRoundTrip=false;}
        const localKey='__trainoracle_native_ci_probe_v1__';
        try {
          if(phase==='read') {
            result.localStoragePersistence=localStorage.getItem(localKey)==='probe-only';
          } else {
            if(localStorage.getItem(localKey)!==null) throw Error('reserved-probe-key-exists');
            localStorage.setItem(localKey,'probe-only');
          }
          result.localStorageRoundTrip=localStorage.getItem(localKey)==='probe-only';
          if(phase!=='write') localStorage.removeItem(localKey);
        } catch {result.localStorageRoundTrip=false;}
        try {
          let created=false;
          const db=await new Promise((ok,bad)=>{const r=indexedDB.open('__trainoracle_native_ci_probe_v1__',1); r.onupgradeneeded=()=>{created=true;r.result.createObjectStore('probe');};r.onsuccess=()=>ok(r.result);r.onerror=()=>bad(r.error);});
          if(phase!=='read') await new Promise((ok,bad)=>{const t=db.transaction('probe','readwrite');t.objectStore('probe').put('probe-only','roundtrip');t.oncomplete=ok;t.onerror=()=>bad(t.error);});
          const value=await new Promise((ok,bad)=>{const t=db.transaction('probe','readonly');const r=t.objectStore('probe').get('roundtrip');r.onsuccess=()=>ok(r.result);r.onerror=()=>bad(r.error);});
          result.indexedDBRoundTrip=value==='probe-only';
          if(phase==='read') result.indexedDBPersistence=!created && value==='probe-only';
          db.close();
          if(phase!=='write') await new Promise((ok,bad)=>{const r=indexedDB.deleteDatabase('__trainoracle_native_ci_probe_v1__');r.onsuccess=ok;r.onerror=()=>bad(r.error);});
        } catch {result.indexedDBRoundTrip=false;}
        await new Promise(ok=>setTimeout(ok,1000));
        const text=document.body?.innerText || '';
        result.rootRendered=(document.getElementById('root')?.childElementCount || 0)>0;
        result.coreContentPresent=text.includes('훈련') && (text.includes('기록')||text.includes('운동'));
        result.storageFailureVisible=text.includes('기록을 확인하지 못');
        return JSON.stringify(result);
        """#
        webView.callAsyncJavaScript(script, arguments: ["phase":phase], in: nil, in: .page) { result in
            guard !state.finished else { return }
            stage("runtime-callback-received", state: state)
            switch result {
            case .success(let value):
                if let text = value as? String, let data = text.data(using: .utf8), let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { finish(dict, state: state) }
                else { finish(["probeReady":false,"failure":"invalid-probe-result"], state: state) }
            case .failure:
                finish(["probeReady":false,"failure":"webview-evaluation-error"], state: state)
            }
        }
    }
    private static func write(_ value: [String: Any], file: String="native-release-probe.json") {
        guard ["native-release-probe.json","native-probe-activation.json","native-probe-progress.json","native-probe-signal.json"].contains(file),
              let cache=FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let bytes=try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        // Only public boolean diagnostics in our own CI cache folder, never user records.
        let folder=cache.appendingPathComponent("TrainOracleNativeCI", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try bytes.write(to: folder.appendingPathComponent(file), options: [.atomic])
            NSLog("TrainOracleNativeProbe: diagnosticWritten=1")
        } catch {
            let failure=error as NSError
            let domain=[NSCocoaErrorDomain,NSPOSIXErrorDomain].contains(failure.domain) ? failure.domain : "other"
            NSLog("TrainOracleNativeProbe: diagnosticWritten=0 domain=%@ code=%ld", domain, failure.code)
        }
    }
}
#endif
