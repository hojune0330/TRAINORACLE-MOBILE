# Android offline-only Health Connect preview ingress

상태: 기본 OFF / UNREVIEWED / 새 코드 Android 컴파일·기기 QA 미실행.

## 경계
기존 Capacitor NativeHealth 세 메서드는 영구 release/drop이다. 새 경로는 TrainOracleHealthPreview라는 WebViewCompat.addWebMessageListener만 사용한다. sourceOrigin=https://localhost, isMainFrame, WEB_MESSAGE_LISTENER 및 DOCUMENT_START_SCRIPT 지원을 모두 요구하며 실패 시 건강만 OFF다. legacy fallback은 없다.

공식 Capacitor 8.5.3 BridgeActivity.java/Bridge.java/PluginHandle.java/BridgeWebViewClient.java/Plugin.java 실제 소스를 조회했다. PluginHandle(Bridge, Class) 생성자가 즉시 this.load()를 호출하고 loadInstance는 setPluginHandle → setBridge → instance.load() → initializeActivityLaunchers 순서다. 즉 이 버전의 class 등록은 lazy가 아니다. BridgeActivity.onCreate → load → bridgeBuilder.create → Bridge 생성자 registerAllPlugins → PluginHandle 즉시 load → Bridge.loadWebView 순서이며, 건강 load는 최초 URL 로드보다 앞선다. Bridge는 getWebViewClient/setWebViewClient를 제공한다. 기존 client가 정확히 기본 BridgeWebViewClient일 때만 subclass를 설치하고 모든 재정의 callback에서 super를 호출한다. 다른 플러그인의 subclass는 대체하지 않고 OFF한다. 이후 client가 바뀌어도 native live 검사가 거절한다. 오류/제거 시 자신이 설치한 client일 때만 원본을 복원한다.

onPageStarted와 onPageCommitVisible은 epoch를 변경한다. commitObserved와 proxyReady를 분리하고 commit/documentStart 양쪽에서 공통 reconcile을 실행한다. documentStart 발신 proxy 자체는 신뢰해 등록하지 않는다. commit 후 native 랜덤 challenge를 현재 표시 문서의 document-start closure에 readiness-only evaluateJavascript로 전달하고, 그 문서가 검증된 main-frame custom 채널로 반환한 단일-use challenge에 대해서만 proxyReady를 설정한다. documentStart가 commit 뒤 도착하거나 missing-hook callback과 교차해도 다시 reconcile한다. SPA push/replace/pop/hash/pagehide는 native 및 JS context를 무효화한다. 실제 WebView callback 순서·프록시 동일성·BFCache 동작은 아직 기기 검증이 필요하다.

native UUID context token + document epoch + JS 랜덤 sessionId/contextId + requestId(최대256회 단일 사용), monotonic 90초 TTL, 원문서 JavaScriptReplyProxy를 묶는다. 동의 직후, 각 SDK suspend 직후, 최종 권한 재확인 후 및 전달 직전에 generation/foreground/native accountMode/client 소유권을 검사한다. stale/cancel/background는 새 문서에 오류도 전달하지 않는다. JS의 자체 Promise만 로컬 invalidate/timeout으로 종료한다.

permission UI 동안 onPause는 특별 처리하지만 onStop은 실제 background와 확실히 구분할 수 없어 보수적으로 폐기한다. 권한 승인 자체는 시스템에 남을 수 있으므로 복귀 후 open→availability로 재확인한다. 전체화면 권한 UI의 정상 응답을 보장하지 않는다. 데이터 읽기 pause는 즉시 무효화한다. permission callback은 현재 context가 살아 있고 RESUMED일 때만 권한을 재조회한다.

## opt-in 계획
planAndroidHealth(input,{enabled:false})가 기본이다. 기존 enabled:true는 scaffold만 추가하며 invocation은 여전히 OFF다. 실제 새 경로 opt-in은 다음을 모두 요구한다.

    {enabled:true, previewEnabled:true, consumerIntegrationReviewed:true, accountMode:'off'}

이때만 생성된 Kotlin OFFLINE_PREVIEW_ENABLED를 true로 바꾼다. 템플릿 원본은 false를 유지한다. runtime native Capacitor plugin config 역시 plugins.NativeHealth.accountMode='off'여야 한다. helper input runtimeConfig에 부모가 fresh generated android/app/src/main/assets/capacitor.config.json의 UTF-8 JSON 문자열을 전달해야 한다. previewEnabled:true일 때만 이 JSON을 검사하고 plugins.NativeHealth={accountMode:'off'}를 추가한 여섯 번째 output인 app/src/main/assets/capacitor.config.json을 반환한다. preview OFF의 scaffold 계획은 기존 다섯 파일이며 native config를 반환하지 않는다. requiredRuntimeConfig 힌트 필드는 제거했고 runtimeConfigPath가 실제 native-only 출력 경로다. root capacitor.config.json은 반환하거나 수정하지 않는다. runtime config가 없거나 다른 모드면 설치하지 않는다. JS accountMode도 off만 받는다. 실제 사용자 계정 ID를 인증으로 사용하지 않으며 source app account/login은 부모가 OFF로 유지해야 한다. account-off만으로 일반 계정 안전성이 완성됐다는 주장은 하지 않는다. 부모 consumer 연결/QA/명시 opt-in 전 실제 경로를 활성화하면 안 된다.

고정값 Capacitor8.5.3 / HC1.1.0 / Kotlin2.2.20 / coroutines1.10.2 / AndroidX WebKit1.14.0 / JDK21 / SDK36. 기존 generator의 source/receipt/version/path/symlink/백업차단/cleartext차단/새 출력·기록 보존 게이트를 변경하지 않는다. helper는 파일·CI를 직접 쓰지 않는 순수 계획기다. 부모가 자체 경계 검사된 writeNative로 적용해야 한다.

## JS 공개 계약
web-adapter/android-health-context.js의 exports:

- ANDROID_HEALTH_CHANNEL='TrainOracleHealthPreview'
- createAndroidHealthContext({window?, accountMode='off', timeoutMs=95000, randomId?})

반환 facade: open(), availability(), requestAuthorization(), readRunningWorkouts({startTime,endTime,limit?}), invalidateContext(reason?), session(), background(), dispose(). session()은 실제 account ID가 아니라 offline preview 랜덤 session을 새로 만든다. 부모 UI는 SPA/화면/세션/로그아웃 변경에서 invalidateContext/session, background/dispose를 반드시 호출한다. onmessage handler를 이미 소유한 consumer가 있으면 충돌로 거절한다. Capacitor 호출 fallback·저장·서버 전송 없음.

전송 envelope:

    {v:1,method,requestId,sessionId,contextId,accountMode:'off',args:{},token?,epoch?}

open에는 token/epoch가 없으며 응답 result={status:'open',token,epoch,provider:'health-connect',reviewStatus:'UNREVIEWED'}다. 이후 요청은 native가 발급한 token/epoch를 반드시 넣는다. 응답 envelope={v:1,requestId,sessionId,contextId,epoch,ok,result? ,error?}. availability result={status:'available'|'provider-update-required'|'unavailable',readExerciseGranted,provider,reviewStatus}. requestAuthorization result={status:'granted'|'denied',provider,reviewStatus}. read result={sessions:[DTO],bounded,provider,reviewStatus}. error는 건강정보 없는 고정 코드다.

DTO={provider:'health-connect',sourcePackage,sourceRecordId,startTime,endTime,exerciseType:'running',reviewStatus:'UNREVIEWED'}. query-count telemetry 없음. 운동세션 객체는 전체 종목을 조회한 후 running 필터링하므로 메모가 SDK 객체에 없다고 주장하지 않는다. 부가필드는 사용·저장·전송하지 않는다. READ_EXERCISE만, GPS/경로 API·쓰기·백그라운드/무제한 과거 권한 없음. 최근28일 내 최대7일, 최대100건/500원본/5페이지. limit은 키 부재에만50, raw finite integer1..100만 허용한다. 삼성 헬스 등 원본 앱이 실제 공유한 활동만 보이며 시계 직접연동/모든 이력 보장이 아니다. 기존 기록 mutation/계정 ingest/영구저장/건강 DB 직접검증은 하지 않았다.

## 검증과 차단조건
새 JS 합성/계획기 테스트는 통과했지만 Kotlin 실행·Android 컴파일·실제 권한 UI·프레임/동일 origin reload·SPA/세션/background/BFCache 검증이 아니다. 원래 generate-native.test.mjs는 이 작업 폴더의 node_modules/@capacitor/cli/assets/android-template.tar.gz 부재로 실행 차단됐다. 부모의 최신 commit에서 의존성 복원 후 원래 generator test와 compileDebugKotlin/processDebugMainManifest/assembleDebug를 다시 실행해야 한다. 이전 a58dad CI 성공은 새 코드의 성공 증거가 아니다. 실제 건강 DB/서명/스토어/CI 구성은 수정·접근하지 않았다.

공식 근거:
https://github.com/ionic-team/capacitor/blob/8.5.3/android/capacitor/src/main/java/com/getcapacitor/Bridge.java
https://github.com/ionic-team/capacitor/blob/8.5.3/android/capacitor/src/main/java/com/getcapacitor/BridgeWebViewClient.java
https://developer.android.com/reference/androidx/webkit/WebViewCompat
https://developer.android.com/reference/androidx/webkit/WebViewCompat.WebMessageListener
https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started

## 후속 startup/config 보완 (부모 통합 계약)

확인된 MainActivity hook은 기존 onCreate 내부에서 다음 순서다. 이 코드는 helper가 반환하는 native MainActivity 내용이며 부모 generator 자체는 이 작업에서 수정하지 않았다.

    registerPlugin(NativeDocumentsPlugin.class);
    registerPlugin(NativeHealthPlugin.class);
    super.onCreate(savedInstanceState);

8.5.3에서는 등록된 class의 PluginHandle 생성 시 eager load가 수행되므로 별도 bridge.getPlugin(...).load() 호출은 필요 없고 추가하지 않았다. super.onCreate 이후 강제 로드는 document-start 설치 보장이 없으므로 대안이 아니다. helper는 중복/늦은 documents 등록과 MainActivity load override를 거절한다. native load는 main-thread, Activity < STARTED, WebView URL null/about:blank 조건을 추가 검사하고 late/manual load면 건강만 OFF다. loadAttempted guard로 재설치도 차단한다. startupStrategy는 capacitor-8.5.3-eager-pluginhandle-before-loadWebView, startupRuntimeVerified는 false다. **소스 순서를 확인한 것이며 실제 첫 화면에 채널이 존재한다는 UI/기기 검증은 아직 하지 않았다.**

preview input runtimeConfig는 JSON 문자열만 받는다. appId=io.trainoracle.app, appName=TrainOracle, webDir=www, loggingBehavior=none, localhost HTTPS/cleartext=false, allowMixedContent=false, account-off 및 기존 health plugin 설정 부재를 검사한다. server.url·allowNavigation·대체 platform path·안전하지 않은 back handler 설정도 거절한다. 기존 다른 plugin/config 값은 보존하고 입력 문자열은 불변이다. CLI8.5.3 copyCapacitorConfig는 buildOptions만 제거하고 extConfig를 native capacitor.config.json으로 직렬화하므로 이 native JSON은 identity/webDir 등 필드를 보유하는 경로임을 소스로 확인했다.

부모는 exact output allowlist에 preview ON일 때만 app/src/main/assets/capacitor.config.json을 추가하고, 기존 safe path/receipt/불변 root config/새 output·기록보존 게이트를 유지해야 한다. root immutable config는 절대 수정하지 않는다. 옵션 이름은 previewEnabled/consumerIntegrationReviewed 그대로이며 consumerIntegrated 같은 별도 옵션은 받지 않는다.

후속 검증: 계획기14개 + 합성 JS7개 = 21개 통과. Kotlin 컴파일/기기 startup은 미실행이며 부모의 새 commit CI 및 최초 문서/ActivityResult 등록 시점 기기 QA가 필요하다. 실제 SDK 조회·건강 DB·서명·스토어 접근 없음.

추가 공식 근거:
https://github.com/ionic-team/capacitor/blob/8.5.3/android/capacitor/src/main/java/com/getcapacitor/BridgeActivity.java
https://github.com/ionic-team/capacitor/blob/8.5.3/android/capacitor/src/main/java/com/getcapacitor/PluginHandle.java
https://github.com/ionic-team/capacitor/blob/8.5.3/cli/src/tasks/copy.ts

## 후속 P2: callback 순서·권한 RESUMED 지연

문서 준비는 commitObserved / proxyReady / navigationEpoch / 단일 사용 probeChallenge로 분리했다. 이전 문서의 지연 documentStart는 현재 표시 문서의 준비 probe를 깨울 수만 있으며 그 발신 proxy를 등록하지 않는다. navigation은 challenge와 proxy를 폐기하며, 이전 challenge·중복 documentReady/init 재생은 proxy를 바꾸지 못한다. 현재 문서 challenge TTL은 5초이며 준비 전용 evaluateJavascript에 건강 데이터·계정 ID·승인 결과를 싣지 않는다. 실제 응답은 계속 원문서 JavaScriptReplyProxy만 사용한다. callback 순서를 보장한다고 가정하지 않는다. feature/closure/현재 문서 확인 실패는 건강 경로만 준비되지 않은 상태로 남는다.

권한 launch 시 permissionFlightRequest에 원래 Request를 저장한다. result는 그 객체의 pending 소유권·epoch·TTL을 확인하고 permissionResultRequest에 보관한다. STARTED에서 도착하면 즉시 결과를 폐기하지 않고 LifecycleEventObserver의 ON_RESUME에서 재시도한다. handleOnResume이 RESUMED보다 먼저 호출돼도 observer가 별도로 재시도한다. 새 요청에 이전 결과를 연결하지 않는다. 실제 onStop은 기존과 같이 context/result를 폐기하며 원래 flight는 callback을 안전하게 식별할 tombstone으로만 남긴다. 새 권한 launch는 이전 flight가 끝나기 전 거절하고, 오래된 flight가 새 데이터 읽기의 pause를 면제하지 않는다. observer는 disable/설치 실패/destroy에서 removeObserver로 정리한다.

회귀: 수정 전 새 소스 계약 2개가 실패(red)한 것을 확인한 뒤 수정 후 통과했다. 순서 역전·missing-hook callback 교차·오래된 문서 challenge/init replay·STARTED 결과→ON_RESUME·stop 후 새 요청 귀속 방지의 합성 reference state 검사를 추가했다. 템플릿에서 추출한 document-start JavaScript도 Node VM에서 합성 실행한다. reference-state/소스 계약/Node VM은 Kotlin·실제 Android WebView callback을 실행한 것이 아니며 네이티브 컴파일 성공으로 해석하면 안 된다. 부모의 최신 commit Android compile/기기 QA를 별도로 재실행해야 한다. 공개 facade와 runtimeConfig/부모 generator 계약은 변경하지 않았다.

공식 근거 추가:
https://developer.android.com/reference/androidx/lifecycle/LifecycleEventObserver
https://developer.android.com/reference/android/webkit/WebView#evaluateJavascript(java.lang.String,android.webkit.ValueCallback)
공식 WebView 문서는 evaluateJavascript가 현재 표시 문서에서 비동기로 실행되고 UI thread callback을 사용한다고 설명한다. 이 API는 준비 challenge 전용이며 건강 응답 전달 경로가 아니다.
