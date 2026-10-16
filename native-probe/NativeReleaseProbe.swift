#if DEBUG
import Foundation
import WebKit

// CI-only probe. No user fields, keys, journal values or credentials are captured.
enum NativeReleaseProbe {
    static func attach(to webView: WKWebView?) {
        let valid=["1","write","read"]
        let environmentPhase=ProcessInfo.processInfo.environment["TRAINORACLE_NATIVE_PROBE"]
        let arguments=ProcessInfo.processInfo.arguments
        let flagIndex=arguments.firstIndex(of: "--trainoracle-native-probe")
        let argumentPhase=flagIndex.flatMap { index in arguments.indices.contains(index+1) ? arguments[index+1] : nil }
        let phase=environmentPhase.flatMap { valid.contains($0) ? $0 : nil } ?? argumentPhase.flatMap { valid.contains($0) ? $0 : nil }
        guard let phase else { return }
        NSLog("TrainOracleNativeProbe: activated webViewPresent=%d", webView == nil ? 0 : 1)
        guard let webView else { return }
        waitForBootstrap(webView, phase: phase, remaining: 80)
    }
    private static func waitForBootstrap(_ webView: WKWebView, phase: String, remaining: Int) {
        guard remaining > 0 else { write(["probeReady": false, "failure": "bootstrap-timeout"]); return }
        webView.evaluateJavaScript("document.readyState === 'complete' && Boolean(window.__NATIVE_CAPABILITIES__)") { value, _ in
            if value as? Bool == true { run(webView, phase: phase) }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { waitForBootstrap(webView, phase: phase, remaining: remaining - 1) } }
        }
    }
    private static func run(_ webView: WKWebView, phase: String) {
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
            switch result {
            case .success(let value):
                if let text = value as? String, let data = text.data(using: .utf8), let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { write(dict) }
                else { write(["probeReady": false, "failure": "invalid-probe-result"]) }
            case .failure:
                write(["probeReady": false, "failure": "webview-evaluation-error"])
            }
        }
    }
    private static func write(_ value: [String: Any]) {
        guard let cache=FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let bytes=try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        // Only public boolean diagnostics in our own CI cache folder, never user records.
        let folder=cache.appendingPathComponent("TrainOracleNativeCI", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try bytes.write(to: folder.appendingPathComponent("native-release-probe.json"), options: [.atomic])
            NSLog("TrainOracleNativeProbe: diagnosticWritten=1")
        } catch {
            let failure=error as NSError
            let domain=[NSCocoaErrorDomain,NSPOSIXErrorDomain].contains(failure.domain) ? failure.domain : "other"
            NSLog("TrainOracleNativeProbe: diagnosticWritten=0 domain=%@ code=%ld", domain, failure.code)
        }
    }
}
#endif
