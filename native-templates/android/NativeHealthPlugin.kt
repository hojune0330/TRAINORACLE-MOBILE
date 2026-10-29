package __APP_ID__

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.net.Uri
import android.widget.TextView
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Disabled scaffold: all ingress drops without evaluating work. SDK candidate bodies are unreachable. */
@CapacitorPlugin(name = "NativeHealth")
class NativeHealthPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val permissions = setOf(HealthPermission.getReadPermission(ExerciseSessionRecord::class))
    private val permissionContract = PermissionController.createRequestPermissionResultContract()
    private var busy = false
    private var dialog: AlertDialog? = null
    private fun trustedOrigin(): Boolean {
        val u = Uri.parse(bridge.webView.url ?: return false)
        return u.scheme == "https" && u.host == "localhost" && u.port == -1 && u.userInfo == null
    }
    // P1 FAIL-CLOSED: no verified document/session epoch or main-frame ingress ticket exists.
    // Do not evaluate work, query SDK, launch UI, or send resolve/reject into a newer document.
    // There is deliberately NO boolean/JS flag that enables this gate.
    @Suppress("UNUSED_PARAMETER")
    private fun enter(call: PluginCall, work: suspend () -> Unit) {
        call.release(bridge)
    }
    private fun strictLimit(call: PluginCall): Int? {
        if (!call.data.has("limit")) return 50
        val raw = call.data.opt("limit")
        if (raw !is Number) return null
        val value = raw.toDouble()
        if (!value.isFinite() || value % 1.0 != 0.0 || value < 1.0 || value > 100.0) return null
        return value.toInt()
    }
    private fun client(): HealthConnectClient {
        check(HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE)
        return HealthConnectClient.getOrCreate(context)
    }
    private fun reply(call: PluginCall, value: JSObject) {
        if (trustedOrigin()) call.resolve(value) else call.reject("ORIGIN_CHANGED")
    }
    @PluginMethod
    fun availability(call: PluginCall) = enter(call) {
        try {
            val status = HealthConnectClient.getSdkStatus(context)
            val result = JSObject().put("provider", "health-connect").put("reviewStatus", "UNREVIEWED")
            result.put("status", when (status) {
                HealthConnectClient.SDK_AVAILABLE -> "available"
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "provider-update-required"
                else -> "unavailable"
            })
            result.put("readExerciseGranted", status == HealthConnectClient.SDK_AVAILABLE &&
                client().permissionController.getGrantedPermissions().containsAll(permissions))
            reply(call, result)
        } finally { busy = false }
    }
    // No load/onCreate/automatic permission request. Native confirmation cannot be replaced by JS flags.
    @PluginMethod
    fun requestReadPermission(call: PluginCall) = enter(call) {
        client()
        dialog = AlertDialog.Builder(activity).setTitle("운동 읽기 연결")
            .setMessage("이 후보는 비활성화되어 있습니다. 활성화 검토 시 Health Connect 운동세션 객체를 조회한 뒤 달리기의 허용필드만 사용·표시합니다. 삼성 헬스의 모든 기록을 읽는 것은 아닙니다. 부가필드(메모·제목·경로 등)는 사용·저장·전송하지 않습니다. 다음 화면에서 직접 승인하거나 거절할 수 있습니다.")
            .setNegativeButton("취소") { _, _ -> busy = false; call.reject("USER_CANCELLED") }
            .setPositiveButton("권한 화면 열기") { _, _ ->
                if (!trustedOrigin()) { busy = false; call.reject("ORIGIN_CHANGED") }
                else try {
                    startActivityForResult(call, permissionContract.createIntent(activity, permissions), "healthPermissionResult")
                } catch (_: Exception) { busy = false; call.reject("PERMISSION_UI_UNAVAILABLE") }
            }.setOnCancelListener { busy = false; call.reject("USER_CANCELLED") }.create()
        dialog?.show()
    }
    @ActivityCallback
    @Suppress("UNUSED_PARAMETER")
    private fun healthPermissionResult(call: PluginCall?, result: ActivityResult) {
        // Never deliver a restored/late permission callback through an unbound Capacitor callback id.
        busy = false
        call?.release(bridge)
    }
    @PluginMethod
    fun readRecentRunningSessions(call: PluginCall) = enter(call) {
        val now = Instant.now()
        val start = try { Instant.parse(call.getString("startTime")) } catch (_: Exception) {
            busy = false; call.reject("INVALID_RANGE_OR_LIMIT"); return@enter
        }
        val end = try { Instant.parse(call.getString("endTime")) } catch (_: Exception) {
            busy = false; call.reject("INVALID_RANGE_OR_LIMIT"); return@enter
        }
        val limit = strictLimit(call) ?: run {
            busy = false; call.reject("INVALID_RANGE_OR_LIMIT"); return@enter
        }
        if (!start.isBefore(end) || end.isAfter(now) || start.isBefore(now.minus(Duration.ofDays(28))) ||
            Duration.between(start, end) > Duration.ofDays(7) || limit !in 1..100) {
            busy = false; call.reject("INVALID_RANGE_OR_LIMIT"); return@enter
        }
        val hc = client()
        if (!hc.permissionController.getGrantedPermissions().containsAll(permissions)) {
            busy = false; call.reject("PERMISSION_REQUIRED"); return@enter
        }
        dialog = AlertDialog.Builder(activity).setTitle("최근 달리기 미리보기")
            .setMessage("운동세션 객체 조회 후 선택한 최대 7일 범위의 달리기 허용필드만 최대 ${limit}개 표시하는 비활성 후보입니다. 부가필드는 사용·저장·전송하지 않습니다. 계정·훈련 기록에 저장하지 않으며 사용자 확인 전 UNREVIEWED 상태입니다.")
            .setNegativeButton("취소") { _, _ -> busy = false; call.reject("USER_CANCELLED") }
            .setPositiveButton("읽기") { _, _ ->
                if (!trustedOrigin()) { busy = false; call.reject("ORIGIN_CHANGED") }
                else scope.launch {
                    try {
                        if (!hc.permissionController.getGrantedPermissions().containsAll(permissions)) throw SecurityException()
                        val rows = JSArray()
                        var token: String? = null
                        var pages = 0
                        var scanned = 0
                        var bounded = false
                        do {
                            if (!trustedOrigin() || !activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) throw SecurityException()
                            val response = hc.readRecords(ReadRecordsRequest(
                                recordType = ExerciseSessionRecord::class,
                                timeRangeFilter = TimeRangeFilter.between(start, end),
                                ascendingOrder = false, pageSize = 100, pageToken = token))
                            // Candidate-only defense; actual ingress is disabled until epoch/ticket binding exists.
                            if (!trustedOrigin() || !activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) throw CancellationException()
                            pages++
                            for (record in response.records) {
                                scanned++
                                if (record.exerciseType != ExerciseSessionRecord.EXERCISE_TYPE_RUNNING) continue
                                if (record.startTime.isBefore(start) || record.endTime.isAfter(end)) continue
                                if (!record.startTime.isBefore(record.endTime)) continue
                                val source = record.metadata.dataOrigin.packageName
                                val id = record.metadata.id
                                if (!source.matches(Regex("[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)+")) ||
                                    source.length > 255 || id.isBlank() || id.length > 256) continue
                                // Allowlist DTO only. Never serialize record, route, title, notes or device.
                                rows.put(JSObject().put("provider", "health-connect")
                                    .put("sourcePackage", source).put("sourceRecordId", id)
                                    .put("startTime", record.startTime.toString()).put("endTime", record.endTime.toString())
                                    .put("exerciseType", "running").put("reviewStatus", "UNREVIEWED"))
                                if (rows.length() >= limit) { bounded = true; break }
                            }
                            token = response.pageToken
                        } while (!bounded && token != null && pages < 5)
                        if (!trustedOrigin() || !activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) throw CancellationException()
                        reply(call, JSObject().put("provider", "health-connect").put("reviewStatus", "UNREVIEWED")
                            .put("sessions", rows).put("bounded", bounded || token != null))
                    } catch (cancelled: CancellationException) { call.release(bridge); throw cancelled }
                    catch (_: SecurityException) { call.reject("PERMISSION_REQUIRED") }
                    catch (_: Exception) { call.reject("READ_FAILED") }
                    finally { busy = false }
                }
            }.setOnCancelListener { busy = false; call.reject("USER_CANCELLED") }.create()
        dialog?.show()
    }
    override fun handleOnDestroy() {
        dialog?.dismiss(); dialog = null; busy = false; scope.cancel()
        super.handleOnDestroy()
    }
}

/** System rationale only: no data reads, WebView navigation or intent-extra processing. */
class HealthPermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = TextView(this)
        text.setPadding(32, 48, 32, 32)
        text.text = "TrainOracle Health Connect 검토용 후보\n\n사용자가 수동 승인한 운동 읽기 권한만 사용합니다. 현재 건강 호출은 안전 경계 미완성으로 비활성화되어 있습니다. 활성화 전 검토 대상은 원본 앱이 Health Connect에 공유한 운동세션 객체를 조회한 뒤 달리기 시간·출처 등 허용필드만 표시하는 기능입니다. 조회 객체의 메모·제목·경로 등 부가필드는 사용·저장·전송하지 않습니다. 자동 실행·백그라운드 읽기·건강정보 쓰기·서버 전송·영구 저장은 하지 않습니다. 결과는 사용자 확인 전 UNREVIEWED입니다. Health Connect 설정에서 언제든 권한을 철회할 수 있습니다.\n\n배포 전 실제 앱의 개인정보 처리방침·보관 및 삭제·문의 경로와 이 문구를 함께 검토해야 합니다."
        setContentView(text)
    }
}
