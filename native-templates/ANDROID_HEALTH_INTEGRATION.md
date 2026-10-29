# Android Health Connect 독립 후보: native review 후 fail-closed

상태: **기본 OFF · 건강 호출 강제 비활성화 · UNREVIEWED**

## 현재 안전 조치와 정확한 한계

P1 문서/계정 세션 epoch 바인딩 및 main-frame ingress가 검증되지 않았다. 요청 시점의 document/session generation과 requestId, SPA/account 변경과 navigation/start 무효화, native ticket 발급/소비를 현재 범위에서 안전하게 연결했다고 주장하지 않는다. **이 때문에 availability·권한·읽기 세 메서드 모두 enter()에서 즉시 PluginCall.release(bridge)만 수행하고 전달된 suspend 작업을 평가하지 않는다.** 정식 SDK availability/권한/운동 조회, 네이티브 동의 UI, coroutine 시작도 이 경로에서 실행되지 않는다. 이전 permission Activity callback도 release/drop만 한다.

- 문서가 바뀌었을 수 있는 call에 성공 응답뿐 아니라 오류 응답도 보내지 않는다. native top URL 일치나 JS가 보내는 epoch/boolean을 신뢰 경계로 대체하지 않는다.
- 이 단계에서 검증된 main-frame ingress 설치가 없으므로 건강 기능은 기기/API 지원 여부와 무관하게 비활성화된다. legacy androidBridge fallback도 건강 동작을 실행하지 못한다. 다른 NativeDocuments 기능·기존 브리지는 바꾸지 않았다.
- drop된 직접 호출의 JS Promise는 settle되지 않는다. **현재 UI는 이 API를 호출하지 말고 disabled 상태를 표시해야 한다.** 건강 availability를 통해 비활성 상태를 물어보는 것도 지원하지 않는다. 빌드/계획 metadata의 healthInvocationEnabled:false를 사용해야 한다. 늦은 오류를 새 문서에 전송해 Promise를 정리하려고 하면 안 된다.
- account-off 설정은 네이티브 callback의 계정 안전성을 증명하지 않는다. 계정 바뀜·로그아웃·revision 보존 경계는 아직 검증되지 않았다. 데이터 전달 자체를 막은 것이지 계정 바인딩을 완성한 것이 아니다.
- Kotlin의 기존 SDK/DTO 코드 블록은 컴파일 검토용 **도달 불가 후보**로 보존했다. enter()의 release-only gate를 바꾸는 것은 재활성화 승인이나 P1 해결이 아니다. source-contract 테스트도 해당 gate 변경을 거부한다.

## 변경한 파일과 기본 OFF 계약

1. native-templates/android/NativeHealthPlugin.kt
2. scripts/configure-android-health.mjs
3. scripts/configure-android-health.test.mjs
4. 본 문서

기존 생성기, Swift, configure-health.mjs, package/lock/release 설정은 수정하지 않는다. 실제 건강 DB·계정·비밀값·서명·배포에 접근하지 않았다. 추가 web-adapter 파일도 만들지 않았다.

planAndroidHealth(input, {enabled:false})는 빈 파일 계획이며 기본값도 OFF다. enabled:true는 기존 안전 게이트를 통과한 생성물 문자열에 대한 다섯 Android 파일의 **비활성 scaffold 계획**만 반환한다. 이 경우에도 healthInvocationEnabled:false 및 disabledReason: DOCUMENT_SESSION_MAIN_FRAME_BINDING_UNVERIFIED다. enabled는 scaffold opt-in이지 건강 호출 허용 플래그가 아니다. helper에는 filesystem/CLI/build 실행 부작용이 없다. 현재 generate-native에는 연결하지 않았다.

기존 canonical path·ancestor·symlink, source/receipt/version, INTERNET-only → backup-off/cleartext-off 변환, 새 출력 전용/기존 metadata 덮어쓰기 금지, account-off 실행환경, 자료 보존 게이트를 우회하지 않는다. 나중에 연결할 때도 기존 게이트 다음에 명시적 opt-in을 넣고 경계 검사된 writeNative만 사용해야 한다. 기존 자료를 삭제·재사용하거나 이 helper를 임의 수정 CLI로 노출하지 않는다.

## 공식 API 검토

2026-10-29 agent-reach Jina 경로로 공식 문서를 확인했다.

- https://developer.android.com/reference/androidx/webkit/WebViewCompat
  - addWebMessageListener는 WEB_MESSAGE_LISTENER feature check가 필요하고 allowedOriginRules에 맞는 프레임에 메시지 객체를 주입한다. allowed origin 일치 자체는 main frame 보장이 아니다.
- https://developer.android.com/reference/androidx/webkit/WebViewCompat.WebMessageListener
  - onPostMessage의 sourceOrigin은 발신 프레임의 origin이고 isMainFrame은 실제 main-frame 메시지 여부다. 이 native ingress에서 두 값을 검증해야 한다. bridge.webView.url 검사만으로 대체할 수 없다.
- Capacitor 8.5.3 PluginCall 공식 소스: https://github.com/ionic-team/capacitor/blob/8.5.3/android/capacitor/src/main/java/com/getcapacitor/PluginCall.java
  - release(bridge)는 keepAlive 해제·native call 해제·released 표시를 수행한다. resolve/reject 없이 drop하는 용도로 사용한다.
- https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started
  - 정식 권한 contract, getGrantedPermissions 재확인, provider query 및 Android 13 이하 rationale Activity/Android 14 이상 보호된 permission-usage alias.
- https://developer.android.com/jetpack/androidx/releases/health-connect
  - 안정판 connect-client 1.1.0 고정. 가이드 예시의 alpha를 사용하지 않는다.
- https://developer.android.com/health-and-fitness/guides/health-connect/develop/read-data
  - 운동세션 레코드 조회·시간 범위·페이지 및 전경/별도 백그라운드 권한 구분.

후보 고정값: Capacitor 8.5.3 / connect-client 1.1.0 / Kotlin plugin 2.2.20 / coroutines-android 1.10.2 / JDK·JVM 21 / compileSdk 36. Kotlin·coroutines 조합은 후보 고정이지 이 세션의 Android compilation 성공 증거가 아니다. AGP 8.9.1 이상 8.x의 정확한 버전만 helper가 허용하며 자동 업그레이드하지 않는다. wrapper minSdk 26 유지, Health Connect 제공자/OS 지원은 재활성화 시 별도 확인해야 한다.

## P2 후보 코드 보완과 데이터 의미

현재는 SDK를 조회하지 않는다. 다음은 도달 불가 후보의 의미이며 실행 기능을 설명하는 것이 아니다.

- Samsung Health 전용 SDK가 아니라 Health Connect 경유다. 삼성 헬스 등 원본 앱이 Health Connect에 실제 공유한 운동만 대상이며 삼성 계정·시계 직접 연결이나 전체 기록을 보장하지 않는다.
- SDK는 ExerciseSessionRecord **운동세션 객체(모든 종목)**를 조회하고 이후 running으로 필터링한다. 객체에 메모·제목 등 부가필드가 포함될 수 있으므로 “메모를 읽지 않는다” 또는 “달리기만 조회한다”는 기존 표현을 철회한다. 후보는 달리기의 허용필드만 사용·표시하고 부가필드는 **사용·저장·전송하지 않는다**. 운동 경로 전용 API/권한도 사용하지 않는다.
- 추가 권한은 READ_EXERCISE 하나다. 기존 INTERNET은 보존하지만 후보 자체 네트워크를 사용하지 않는다. 쓰기·GPS·경로·심박·배경 읽기·과거 무제한 권한을 추가하지 않는다. 현재는 그 READ_EXERCISE도 요청하지 않는다.
- 도달 불가 후보 범위: 최근 28일 내 최대 7일, 미래/역순 금지, 최대 100개 반환·100개씩 5페이지/500개 원본 운동. 내부 pages/scanned 카운터는 제한 계산용으로 유지하지만 scannedRecords/pagesRead를 JS 응답에서 제거했다. 원본 종목 분포 정보가 추가로 노출되지 않도록 한다.
- raw limit은 키가 없을 때만 50이다. 실제 Number, finite, 정수, 1..100을 요구한다. null/string/boolean/1.5/배열/객체/범위 밖을 거절하며 getInt/coercion/default fallback은 제거했다. JS parseAndroidHealthLimit은 실행 가능한 **스키마 참조**이며 native 보안 ingress나 Kotlin runtime 시험 대체물이 아니다.
- 후보의 마지막 read suspend 직후 및 resolve 직전 전경 검사를 추가하고 CancellationException은 release 후 별도 rethrow한다. 하지만 document/session epoch 검사가 아직 없으므로 이 개선을 충분한 lifecycle/계정 안전성이라고 주장하지 않는다. 실제 실행 경로는 모두 차단되어 read suspend/권한 UI pause/데이터읽기 pause 자체가 발생하지 않는다.
- 허용 DTO 후보: provider=health-connect, sourcePackage, sourceRecordId, startTime, endTime, exerciseType=running, reviewStatus=UNREVIEWED. outer 응답은 sessions/bounded만; query-count telemetry 제외. 기존 파일 import로 재포장하거나 Samsung 이름으로 전체 결과 재라벨링하지 않는다. 사용자 수동 검토 전 자동 계정 ingest·영구 저장·업로드 API는 없다.
- bounded/빈 결과는 완전한 이력이나 기록 부재·권한 거절의 증거가 아니다. treadmill 등 다른 운동 타입은 이 후보의 running 필터 밖이다.

## 재활성화 전 필수 P1 설계·검증

[blocked] native generation + requestId + document/session context binding, navigation/start/same-origin reload/SPA/account logout 변경 무효화를 기존 WebView/앱 수명주기에 정확히 연결해야 한다. JS가 보내는 context 값만 믿으면 안 된다.

[blocked] WebViewCompat.addWebMessageListener 설치와 feature 확인, sourceOrigin exact allowlist 및 isMainFrame 검증을 통과한 ingress에서만 일회 ticket 발급. ticket은 native에서 generation/context/request/method/expiry에 묶고 한 번만 소비해야 한다. 설치 실패·지원 불가·iframe·legacy fallback·재생/replay는 건강만 비활성/차단해야 한다. native topURL 체크는 방어 보조일 뿐 발신 프레임 검증 대체물이 아니다.

[blocked] 동의 직후, 모든 suspend 직후, 각 SDK 페이지, resolve 직전에 context/foreground/권한 재검증. stale/cancelled는 새 문서에 reject도 보내지 말고 release/drop. permission UI의 정상 pause와 데이터읽기 중 pause를 구분하고, 마지막 페이지 뒤 background된 경우도 전달하지 않아야 한다. 이를 구현·실기기 검증하기 전 release-only gate를 제거하지 않는다.

## 검증 수준과 부모 CI 재실행

로컬 실행:

    node --check scripts/configure-android-health.mjs
    node --check scripts/configure-android-health.test.mjs
    node --test scripts/configure-android-health.test.mjs

16개 통과: 순수 planner fixture, JSON schema 참조 실행, Kotlin gate/parser/DTO 소스 계약 정적 검사. Kotlin 실행·Android 컴파일·WebView iframe/navigation/session/lifecycle 검증이 아니다. 이전 12개 테스트 결과나 다른 commit의 CI 결과를 이번 변경의 성공 증거로 재사용하면 안 된다.

[blocked] 이 세션은 실제 Android compile을 실행하지 않았다. 부모의 generated compiler CI branch는 **이 네 파일의 새 commit**으로 재생성하고 compileDebugKotlin/processDebugMainManifest/assembleDebug를 재실행해야 한다. JDK 21, SDK 36, 검토된 AGP/Gradle 및 고정 의존성 해결과 기존 source/receipt/자료 보존 게이트가 필요하다. 컴파일 성공도 건강 기능 동작·P1 해결·UI 승인 성공을 의미하지 않는다.

[blocked] 실기기/계정/UI·Play Console 접근 선언/건강 앱 정책·개인정보 처리방침·문의/보관/삭제·서명/스토어 승인은 별도다. 현재 disabled 상태와 실제 사용 불가를 사용자에게 정확히 표시해야 한다.
