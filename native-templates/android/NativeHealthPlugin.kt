package __APP_ID__

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.webkit.WebView
import android.widget.TextView
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.lifecycle.Lifecycle
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.BridgeWebViewClient
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

@CapacitorPlugin(name = "NativeHealth")
class NativeHealthPlugin : Plugin() {
    companion object {
        private const val OFFLINE_PREVIEW_ENABLED = false
        private const val CHANNEL = "TrainOracleHealthPreview"
        private const val TTL = 90000L
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val permissions = setOf(HealthPermission.getReadPermission(ExerciseSessionRecord::class))
    private var installed = false
    private var listenerInstalled = false
    private var loadAttempted = false
    private var commitObserved = false
    private var proxyReady = false
    private var navigationEpoch = 0L
    private var documentStartSerial = 0L
    private var probeChallenge: String? = null
    private var probeNavigationEpoch = -1L
    private var probeIssued = 0L
    private var documentProxy: JavaScriptReplyProxy? = null
    private var epoch = 0L
    private var current: PreviewContext? = null
    private var pending: Request? = null
    private var permissionFlightRequest: Request? = null
    private var permissionResultRequest: Request? = null
    private var resumeObserverInstalled = false
    private val resumeObserver = androidx.lifecycle.LifecycleEventObserver { _, event ->
        if(event == Lifecycle.Event.ON_RESUME) completePermissionIfResumed()
    }
    private var dialog: AlertDialog? = null
    private var job: Job? = null
    private var script: ScriptHandler? = null
    private var launcher: ActivityResultLauncher<Set<String>>? = null
    private var ownedClient: BridgeWebViewClient? = null
    private var previousClient: BridgeWebViewClient? = null
    private data class PreviewContext(val epoch: Long, val session: String, val contextId: String,
        val token: String, val proxy: JavaScriptReplyProxy, val issued: Long,
        val used: MutableSet<String> = mutableSetOf())
    private data class Request(val ctx: PreviewContext, val id: String, val method: String,
        val args: JSONObject, val born: Long = SystemClock.elapsedRealtime())
    // Permanent deny path: never expose data through Capacitor, including its legacy iframe fallback.
    private fun enter(call: PluginCall) { call.release(bridge) }
    @PluginMethod fun availability(call: PluginCall) = enter(call)
    @PluginMethod fun requestReadPermission(call: PluginCall) = enter(call)
    @PluginMethod fun readRecentRunningSessions(call: PluginCall) = enter(call)

    private fun accountOff() = config.getString("accountMode", "") == "off"
    private fun foreground() = activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    private fun fixedOrigin(u: Uri) = u.scheme == "https" && u.host == "localhost" && u.port == -1 && u.userInfo == null
    private fun live(r: Request, needForeground: Boolean = true): Boolean = installed && accountOff() && commitObserved && proxyReady &&
        current === r.ctx && epoch == r.ctx.epoch && bridge.webViewClient === ownedClient &&
        SystemClock.elapsedRealtime() - r.born <= TTL && SystemClock.elapsedRealtime() - r.ctx.issued <= TTL &&
        (!needForeground || foreground())
    private fun requireLive(r: Request) { if (!live(r)) throw CancellationException("STALE") }
    private fun invalidate() {
        epoch++; current = null; pending = null; permissionResultRequest = null
        job?.cancel(); job = null
        dialog?.setOnCancelListener(null); dialog?.dismiss(); dialog = null
        // Stale requests are dropped, never resolve/reject through a newer document.
    }
    override fun load() {
        if (loadAttempted) return
        loadAttempted = true
        if (!OFFLINE_PREVIEW_ENABLED || !accountOff()) return
        try {
            // Verified eager 8.5.3 PluginHandle path only. A late manual load cannot arm health.
            check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
            check(!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
            check(bridge.webView.url == null || bridge.webView.url == "about:blank")
            check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
            check(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
            val old = bridge.webViewClient
            // Preserve known Capacitor super behavior; refuse to replace any other plugin's subclass.
            check(old.javaClass == BridgeWebViewClient::class.java)
            previousClient = old
            val client = object : BridgeWebViewClient(bridge) {
                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    navigationEpoch++; commitObserved = false; proxyReady = false; documentProxy = null; probeChallenge = null
                    invalidate(); super.onPageStarted(view, url, favicon)
                }
                override fun onPageCommitVisible(view: WebView, url: String?) {
                    navigationEpoch++; proxyReady = false; documentProxy = null; probeChallenge = null; invalidate()
                    commitObserved = url != null && fixedOrigin(Uri.parse(url))
                    super.onPageCommitVisible(view, url)
                    reconcileDocumentReady()
                }
            }
            ownedClient = client; bridge.setWebViewClient(client)
            launcher = activity.registerForActivityResult(PermissionController.createRequestPermissionResultContract()) {
                val original = permissionFlightRequest
                permissionFlightRequest = null
                // Never attach a delayed result to whatever pending request happens to exist now.
                if(original != null && pending === original && live(original, false)) {
                    permissionResultRequest = original
                    completePermissionIfResumed()
                }
            }
            activity.lifecycle.addObserver(resumeObserver); resumeObserverInstalled = true
            WebViewCompat.addWebMessageListener(bridge.webView, CHANNEL, setOf("https://localhost")) { _, msg, origin, main, proxy ->
                if (!installed || !main || !fixedOrigin(origin) || !accountOff()) return@addWebMessageListener
                if (msg.type != androidx.webkit.WebMessageCompat.TYPE_STRING) return@addWebMessageListener
                val text = msg.data ?: return@addWebMessageListener
                if (text.length > 4096) return@addWebMessageListener
                try {
                    val envelope = JSONObject(text)
                    if(envelope.opt("v") != 1) return@addWebMessageListener
                    when(envelope.opt("method")) {
                        "documentStart" -> { documentStartSerial++; reconcileDocumentReady() }
                        "documentReady" -> acceptDocumentReady(envelope, proxy)
                        else -> receive(envelope, proxy)
                    }
                } catch (_: Exception) { /* malformed ingress: drop */ }
            }
            listenerInstalled = true
            script = WebViewCompat.addDocumentStartJavaScript(bridge.webView, """
                (()=>{if(window!==window.top)return;const c=window.TrainOracleHealthPreview;const documentId=crypto.randomUUID();
                Object.defineProperty(window,'__TrainOracleHealthProbe',{configurable:false,writable:false,value:(challenge)=>{
                  if(typeof challenge!=='string'||challenge.length>80)return false;
                  c.postMessage(JSON.stringify({v:1,method:'documentReady',documentId,challenge}));return true;
                }});
                c.postMessage(JSON.stringify({v:1,method:'documentStart',documentId}));
                const drop=()=>{c.postMessage(JSON.stringify({v:1,method:'invalidate'}));window.dispatchEvent(new Event('trainoracle-health-invalidated'));};
                for(const k of ['pushState','replaceState']){const f=history[k];history[k]=function(...a){drop();return f.apply(this,a);};}
                for(const k of ['popstate','hashchange','pagehide'])window.addEventListener(k,drop);
                })();
            """.trimIndent(), setOf("https://localhost"))
            installed = true
        } catch (_: Exception) { disable() }
    }
    private fun disable() {
        installed = false; commitObserved = false; proxyReady = false; probeChallenge = null; documentProxy = null; invalidate()
        if(resumeObserverInstalled) { activity.lifecycle.removeObserver(resumeObserver); resumeObserverInstalled = false }
        permissionFlightRequest = null; permissionResultRequest = null
        script?.remove(); script = null
        if (listenerInstalled) {
            try { WebViewCompat.removeWebMessageListener(bridge.webView, CHANNEL) } catch (_: Exception) {}
            listenerInstalled = false
        }
        if (bridge.webViewClient === ownedClient) previousClient?.let { bridge.setWebViewClient(it) }
        launcher?.unregister(); launcher = null
    }
    // Both callback orders converge here. A documentStart only wakes a current-page probe;
    // it never binds its sender proxy, so delayed old-document starts/init replays cannot win.
    private fun reconcileDocumentReady() {
        if(probeChallenge != null && SystemClock.elapsedRealtime() - probeIssued > 5000L) probeChallenge = null
        if(!installed || !accountOff() || !commitObserved || proxyReady || probeChallenge != null || bridge.webViewClient !== ownedClient) return
        val challenge = UUID.randomUUID().toString()
        val generation = navigationEpoch
        val serial = documentStartSerial
        probeChallenge = challenge; probeNavigationEpoch = generation; probeIssued = SystemClock.elapsedRealtime()
        // Readiness-only challenge, never health payload or resolve/reject. The platform API
        // evaluates in the currently displayed document; navigation invalidates this generation.
        val js = "(function(){const p=window.__TrainOracleHealthProbe;return typeof p==='function'&&p(" + JSONObject.quote(challenge) + ")===true;})()"
        try { bridge.webView.evaluateJavascript(js) { value ->
            if(probeNavigationEpoch != navigationEpoch || generation != navigationEpoch || probeChallenge != challenge) return@evaluateJavascript
            if(value != "true") {
                probeChallenge = null
                // documentStart may have arrived while this missing-hook result was queued.
                if(documentStartSerial != serial) reconcileDocumentReady()
            }
        } } catch(_: Exception) { if(probeChallenge == challenge) probeChallenge = null }
    }
    private fun acceptDocumentReady(o: JSONObject, proxy: JavaScriptReplyProxy) {
        if(!installed || !accountOff() || !commitObserved || proxyReady || bridge.webViewClient !== ownedClient ||
            probeNavigationEpoch != navigationEpoch || probeChallenge == null || o.opt("challenge") != probeChallenge ||
            SystemClock.elapsedRealtime() - probeIssued > 5000L || identifier(o,"documentId") == null) return
        probeChallenge = null // Single-use; duplicate/old ready or documentStart cannot rebind.
        documentProxy = proxy; proxyReady = true
    }
    private fun identifier(o: JSONObject, key: String): String? {
        val v = o.opt(key)
        return if (v is String && v.matches(Regex("[A-Za-z0-9_-]{1,80}"))) v else null
    }
    private fun receive(o: JSONObject, proxy: JavaScriptReplyProxy) {
        if (o.opt("v") != 1 || (!commitObserved || !proxyReady) || proxy !== documentProxy || bridge.webViewClient !== ownedClient) return
        if (o.opt("method") == "invalidate") { invalidate(); return }
        if (!foreground()) return
        val id = identifier(o, "requestId") ?: return
        val session = identifier(o, "sessionId") ?: return
        val contextId = identifier(o, "contextId") ?: return
        if (o.opt("accountMode") != "off") { invalidate(); return }
        val method = o.optString("method")
        if (method == "open") {
            if(current?.used?.contains(id) == true) return
            invalidate()
            val c = PreviewContext(epoch, session, contextId, UUID.randomUUID().toString(), proxy, SystemClock.elapsedRealtime())
            current = c; c.used.add(id)
            send(Request(c,id,method,JSONObject()), JSONObject().put("token",c.token).put("epoch",c.epoch).put("status","open"))
            return
        }
        val c = current ?: return
        if (c.proxy !== proxy || c.session != session || c.contextId != contextId || o.opt("token") != c.token ||
            (o.opt("epoch") as? Number)?.toDouble() != c.epoch.toDouble() || c.used.size >= 256 || !c.used.add(id)) return
        val args = o.opt("args"); if (args !is JSONObject) return
        val r = Request(c,id,method,args)
        if (!live(r)) return
        if (pending != null) { send(r,null,"BUSY"); return }
        if (method !in setOf("availability","requestAuthorization","readRunningWorkouts")) { send(r,null,"INVALID_METHOD"); return }
        pending = r
        job = scope.launch {
            try {
                requireLive(r)
                when(method) {
                    "availability" -> {
                        val status = HealthConnectClient.getSdkStatus(context)
                        val granted = if(status == HealthConnectClient.SDK_AVAILABLE) hc().permissionController.getGrantedPermissions().containsAll(permissions) else false
                        requireLive(r)
                        send(r,JSONObject().put("status",when(status) {
                            HealthConnectClient.SDK_AVAILABLE -> "available"
                            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "provider-update-required"
                            else -> "unavailable"
                        }).put("readExerciseGranted",granted))
                    }
                    "requestAuthorization" -> consent(r,true)
                    "readRunningWorkouts" -> { validateRange(r.args); consent(r,false) }
                }
            } catch(cancelled: CancellationException) { throw cancelled }
            catch(_: SecurityException) { send(r,null,"PERMISSION_REQUIRED") }
            catch(_: IllegalArgumentException) { send(r,null,"INVALID_RANGE_OR_LIMIT") }
            catch(_: Exception) { send(r,null,"HEALTH_UNAVAILABLE") }
        }
    }
    private fun hc(): HealthConnectClient {
        check(HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE)
        return HealthConnectClient.getOrCreate(context)
    }
    private fun send(r: Request, result: JSONObject?, error: String? = null) {
        if (!live(r)) { if(pending === r) pending = null; return }
        val o = JSONObject().put("v",1).put("requestId",r.id).put("sessionId",r.ctx.session)
            .put("contextId",r.ctx.contextId).put("epoch",r.ctx.epoch).put("ok",error == null)
        if(result != null) o.put("result",result.put("provider","health-connect").put("reviewStatus","UNREVIEWED"))
        if(error != null) o.put("error",error)
        // Exact original document proxy, not evaluateJavascript or a global Capacitor callback.
        if(live(r)) try { r.ctx.proxy.postMessage(o.toString()) } catch(_: Exception) {}
        if(pending === r) pending = null
    }
    private fun consent(r: Request, permission: Boolean) {
        requireLive(r)
        dialog = AlertDialog.Builder(activity).setTitle(if(permission) "운동 읽기 승인" else "달리기 미리보기")
            .setMessage("오프라인 미리보기 전용입니다. 운동세션 객체 조회 후 달리기의 허용필드만 표시합니다. 부가필드(메모·제목·경로)는 사용·저장·전송하지 않습니다. 삼성 헬스 등 원본 앱이 Health Connect에 공유한 활동만 대상이며 결과는 UNREVIEWED입니다.")
            .setNegativeButton("취소") { _,_ -> send(r,null,"USER_CANCELLED") }
            .setOnCancelListener { send(r,null,"USER_CANCELLED") }
            .setPositiveButton(if(permission) "권한 화면" else "읽기") { _,_ ->
                if(live(r)) {
                    if(permission) {
                        if(permissionFlightRequest != null) { send(r,null,"BUSY"); return@setPositiveButton }
                        permissionFlightRequest = r
                        try { launcher?.launch(permissions) ?: throw IllegalStateException() }
                        catch(_: Exception) { permissionFlightRequest = null; send(r,null,"PERMISSION_UI_UNAVAILABLE") }
                    } else job = scope.launch { read(r) }
                }
            }.create()
        dialog?.show()
    }
    private fun completePermissionIfResumed() {
        val r = permissionResultRequest ?: return
        if(pending !== r || !live(r, false)) { permissionResultRequest = null; return }
        if(!foreground()) return
        permissionResultRequest = null
        job = scope.launch {
            try {
                val granted = hc().permissionController.getGrantedPermissions().containsAll(permissions)
                requireLive(r); send(r,JSONObject().put("status",if(granted) "granted" else "denied"))
            } catch(cancelled: CancellationException) { throw cancelled }
            catch(_: Exception) { send(r,null,"PERMISSION_CHECK_FAILED") }
        }
    }
    private fun strictLimit(o: JSONObject): Int {
        if(!o.has("limit")) return 50
        val raw = o.opt("limit"); require(raw is Number)
        val value = raw.toDouble()
        require(value.isFinite() && value % 1.0 == 0.0 && value >= 1.0 && value <= 100.0)
        return value.toInt()
    }
    private fun validateRange(o: JSONObject): Triple<Instant,Instant,Int> {
        require(o.opt("startTime") is String && o.opt("endTime") is String)
        val start = Instant.parse(o.getString("startTime")); val end = Instant.parse(o.getString("endTime")); val now = Instant.now()
        require(start.isBefore(end) && !end.isAfter(now) && !start.isBefore(now.minus(Duration.ofDays(28))) && Duration.between(start,end) <= Duration.ofDays(7))
        return Triple(start,end,strictLimit(o))
    }
    private suspend fun read(r: Request) {
        try {
            requireLive(r)
            val (start,end,limit) = validateRange(r.args); val client = hc()
            val granted = client.permissionController.getGrantedPermissions().containsAll(permissions)
            requireLive(r); if(!granted) throw SecurityException()
            val rows = JSONArray(); var page: String? = null; var pages = 0; var scanned = 0; var bounded = false
            do {
                requireLive(r)
                val response = client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(start,end),ascendingOrder = false,pageSize = 100,pageToken = page))
                requireLive(r); pages++
                for(record in response.records) {
                    if(scanned >= 500) { bounded = true; break }; scanned++
                    if(record.exerciseType != ExerciseSessionRecord.EXERCISE_TYPE_RUNNING || record.startTime.isBefore(start) || record.endTime.isAfter(end) || !record.startTime.isBefore(record.endTime)) continue
                    val source = record.metadata.dataOrigin.packageName; val id = record.metadata.id
                    if(!source.matches(Regex("[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)+")) || source.length > 255 || id.isBlank() || id.length > 256) continue
                    rows.put(JSONObject().put("provider","health-connect").put("sourcePackage",source).put("sourceRecordId",id)
                        .put("startTime",record.startTime.toString()).put("endTime",record.endTime.toString())
                        .put("exerciseType","running").put("reviewStatus","UNREVIEWED"))
                    if(rows.length() >= limit) { bounded = true; break }
                }
                page = response.pageToken
            } while(!bounded && page != null && pages < 5 && scanned < 500)
            val stillGranted = client.permissionController.getGrantedPermissions().containsAll(permissions)
            requireLive(r); if(!stillGranted) throw SecurityException()
            send(r,JSONObject().put("sessions",rows).put("bounded",bounded || page != null))
        } catch(cancelled: CancellationException) { throw cancelled }
        catch(_: SecurityException) { send(r,null,"PERMISSION_REQUIRED") }
        catch(_: IllegalArgumentException) { send(r,null,"INVALID_RANGE_OR_LIMIT") }
        catch(_: Exception) { send(r,null,"READ_FAILED") }
    }
    override fun handleOnPause() {
        val original = pending
        val expectedPermissionPause = original != null && original.method == "requestAuthorization" &&
            (permissionFlightRequest === original || permissionResultRequest === original) && live(original, false)
        if(!expectedPermissionPause) invalidate()
        super.handleOnPause()
    }
    // Full stop (even full-screen permission UI) is ambiguous: conservatively drop and require reopen.
    override fun handleOnStop() { invalidate(); super.handleOnStop() }
    override fun handleOnResume() { super.handleOnResume(); completePermissionIfResumed() }
    override fun handleOnDestroy() { disable(); scope.cancel(); super.handleOnDestroy() }
}
class HealthPermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = TextView(this); text.setPadding(32,48,32,32)
        text.text = "TrainOracle 오프라인 건강 미리보기\n\n수동 운동 읽기 권한만 사용합니다. Health Connect 운동세션 객체 조회 후 달리기 시간·출처 등 허용필드만 표시합니다. 메모·제목·경로 등 부가필드는 사용·저장·전송하지 않습니다. 원본 앱이 실제 공유한 활동만 대상이며 계정에 저장하지 않습니다. 결과는 UNREVIEWED이고 Health Connect 설정에서 언제든 권한을 철회할 수 있습니다. 배포 전 개인정보 처리방침·보관·삭제·문의 문구를 별도 검토해야 합니다."
        setContentView(text)
    }
}
