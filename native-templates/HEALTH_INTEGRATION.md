# HealthKit 읽기 전용 후보 통합

상태: **UNREVIEWED / 기본 OFF / 생성기 미연결 / 네이티브 컴파일 미검증**

대상: Capacitor 8.5.3, iOS 16.0 이상. Windows에서 Swift/HealthKit 빌드는 실행하지 않았다. JS fixture 통과를 iOS 동작 확인이나 출시 승인으로 해석하지 않는다. 실제 사용자 건강 DB 조회, 서명, 스토어 제출, 배포는 수행하지 않았다.

## 생성된 네 파일과 책임

- `native-templates/ios/NativeHealthPlugin.swift`: 가용성, 명시적 읽기 권한 요청, 최근 달리기 조회 구현.
- `scripts/configure-health.mjs`: 부작용 없는 opt-in 순수 변환과 Xcode 설정 helper exports.
- `scripts/configure-health.test.mjs`: 독립 실행 JS fixture 및 Swift 소스 불변식 검사.
- 이 문서. 기존 생성기·브리지 템플릿·웹 저장 흐름은 수정하지 않았다.

`node --test scripts/configure-health.test.mjs`로 실행한다. 최초 검증: 21개 통과, 실패 0. 쿼리 검사는 JS 계약 mirror이고 보안 검사는 Swift 소스 검사이며, 네이티브 실행 테스트가 아니다.

## API와 최소 데이터

`NativeHealth.availability()`는 기기 지원 여부만 반환한다. 권한 창을 띄우지 않으며 `readAuthorization: "unknown"`이다.

`NativeHealth.requestAuthorization()`은 네이티브 확인 UI를 먼저 표시한다. 사용자가 계속을 선택한 뒤에만 `workoutType()` 읽기 권한을 요청한다. `toShare`는 빈 집합이다. `requestCompleted: true`는 요청 절차의 완료이지 읽기 허용의 증명이 아니다. 앱 시작/복귀 시 자동 호출하지 않는다.

`NativeHealth.readRunningWorkouts({start?, end?, limit?})`는 매번 네이티브 확인 UI를 거친다. 날짜는 ISO8601 시간대 포함 문자열, 기본 최근 30일, 최대 최근 90일 이내이다. 미래 끝 날짜나 역전된 날짜는 거절한다. 기본 50개, 최대 100개, 최소 1개의 정수 제한이 있다. `.running` 운동만 시작·종료가 기간 안에 완전히 들어오는 조건으로 최신 시작순 조회한다. 별도 권한 요청을 자동 수행하지 않는다.

반환 envelope:

```js
{
  source: 'apple-healthkit',
  reviewStatus: 'UNREVIEWED',
  readAuthorization: 'unknown',
  emptyDoesNotMeanDenied: true,
  workouts: [{ uuid, start, end, durationSeconds, distanceMeters }]
}
```

UUID/시작/종료/운동시간/미터 거리 외 원문 운동 정보는 내보내지 않는다. 거리 미기록은 `null`이며 추정하지 않는다. GPS 경로, 좌표, 심박, 칼로리, 메모, metadata, 원본 앱/기기 식별자는 제외한다. `source`는 HealthKit 수집 경로일 뿐 Apple Watch에서 직접 측정했거나 원본 앱이 Apple이라는 주장이 아니다. HealthKit 시스템 권한 화면은 운동 전체 유형 단위이며 이 앱의 쿼리만 달리기로 제한한다.

빈 배열은 무기록·조회 범위·비공유·권한 상태 등 여러 원인이 가능하다. 빈 결과나 `authorizationStatus(for:)`로 읽기 거부를 단정하지 않는다. 이 구현은 데이터를 파일/기존 보관함/계정/서버에 쓰거나 기존 기록과 병합하지 않는다. 웹 연결 담당은 결과를 UNREVIEWED 후보로만 다루고, 검토 화면 및 명시적 저장·계정 전송 동의를 별도로 구현해야 한다. 동의가 있다고 가정하여 자동 저장하면 안 된다.

## 프레임·탐색 방어

Capacitor 8.5.3 기본 `WebViewDelegationHandler`는 `WKFrameInfo`를 `CAPPluginCall`로 넘기지 않는다. 따라서 플러그인 load에서 `bridge` script handler를 검증용 forwarding wrapper로 교체한다. 기존 navigation delegate는 교체하지 않고 다른 플러그인 메시지는 원래 handler에 위임한다.

HealthKit 호출은 실제 `WKScriptMessage.frameInfo.isMainFrame`, `WKSecurityOrigin`의 `capacitor://localhost`와 무포트, 실제 프레임 URL 및 현재 최상위 WebView URL을 네이티브에서 검사한다. HTTP proxy interceptor 경로도 거절한다. JS가 넘긴 출처나 동의 boolean은 신뢰하지 않는다. 검증된 메시지에만 native callback ID 기반 5초·1회 티켓을 발급하며 플러그인 실행에서 소모한다. 허용된 메서드 3개 외에는 통과시키지 않는다. iframe/잘못된 출처 메시지는 반환 데이터 없이 버린다. 해당 비허용 호출의 JS Promise는 미해결일 수 있으므로 UI 어댑터는 타임아웃 오류를 처리해야 한다.

탐색 시 generation과 티켓을 무효화하고 외부 탐색을 거절한다. 확인창/비동기 완료 시 generation 및 현재 출처를 다시 검사하여 다른 문서에 결과를 보내지 않는다. 기본 탐색 가드는 플러그인이 설치된 동안에만 유효하며, trusted 최상위 앱 자체의 XSS를 해결하는 것은 아니다. 웹의 CSP와 스크립트 공급망 점검은 별도로 필요하다. 원격 server.url/live-reload/custom hostname 환경은 이 후보에서 지원하지 않는다. 다른 구성요소가 이후 `bridge` handler를 덮어쓰는 구성은 통합 검토에서 거절해야 한다.

## opt-in helper 연결 순서

helper를 import하는 것만으로는 아무 파일이나 설정도 바뀌지 않는다. `enabled` 생략 또는 `false`면 기존 입력을 그대로 유지한다. 문자열 `"true"` 등은 거절한다. 환경변수나 package script를 읽어 자동 켜지 않는다. 부모 작업자가 명시적인 배포 전 검토 이후 연결 여부를 결정한다.

1. 기존 `transformBridge(template, probe)` 결과를 `createHealthPlan({enabled: true, info: baseInfo, entitlements: {}, bridgeSource: transformedBridge, sources: baseSources})`에 넣는다. `baseInfo`는 기존 iOS Info.plist 변환 완료 후 값이다. 이중 등록·기존 건강 목적문구·기존 entitlement가 있으면 수동 검토가 필요하므로 helper가 거절한다.
2. 반환된 `bridgeSource`와 `info`를 기존 경계 검사된 `writeNative`/plist serializer로 생성 폴더에만 쓴다. 기존 템플릿은 수정하지 않는다.
3. `generatedFiles`의 Swift template을 `ios/App/App/NativeHealthPlugin.swift`로 복사한다. entitlement plist 객체를 serializer로 `ios/App/App/TrainOracleHealth.entitlements`에 생성한다. 목적 문구는 읽기용 `NSHealthShareUsageDescription`만, entitlement는 `com.apple.developer.healthkit: true`만 생성한다. 쓰기 목적문구, clinical/background entitlement는 추가하지 않는다.
4. 기존 `configureXcode(project, release, plan.sources, resources)`를 **먼저** 실행한다. `plan.sources`가 Swift 파일을 App target PBXSourcesBuildPhase에 명시적으로 등록한다.
5. 그 다음 `configureHealthXcode(project, {enabled: true})` 실행. 실제 App target source build phase에 정확히 1개 등록됐는지, Debug/Release iOS16 설정을 확인하고 양쪽 `CODE_SIGN_ENTITLEMENTS = App/TrainOracleHealth.entitlements`와 `com.apple.HealthKit` SystemCapabilities를 설정한다. 서명 팀/프로파일은 건드리지 않는다.
6. project를 serialize한 뒤 생성 메타데이터에 opt-in 여부, UNREVIEWED와 컴파일 미실행을 기록한다. 기본 OFF 생성물은 HealthKit 파일·권한·capability·등록을 추가하지 않아야 한다.

주의: 현재 `generate-native.mjs`는 Info.plist/entitlements/기존 capabilities의 HealthKit을 의도적으로 금지한다. 단순 helper 호출 추가만으로 완료되지 않는다. opt-in일 때에만 정확히 위 키/파일만 허용하도록 최종 검증을 좁혀 연결하고, OFF의 기존 거절 동작은 유지해야 한다. `configureXcode` 이후 helper를 호출해야 설정 삭제와 충돌하지 않는다. 이 후보는 해당 기존 파일을 수정하지 않았다. 아직 생성기 실행·네이티브 빌드에 통합되었다고 표시하면 안 된다.

## 남은 Xcode 및 실기기 검증

- macOS/Xcode에서 Capacitor 8.5.3 + iOS16 최소 대상으로 Swift 컴파일, Objective-C override/콜백 타입, 실제 script handler 수명/교체 순서 검증.
- 생성된 project를 xcode parser로 재파싱해 Swift App target membership, Debug/Release entitlement 경로, HealthKit capability를 다시 확인. 적절한 테스트용 Apple 앱 ID/프로비저닝에서 HealthKit entitlement가 유효한지 확인.
- 앱 최초 시작과 복귀 때 권한창이 자동 표시되지 않는지, 권한 UI 취소·허용·거부·기존 선택·지원 안 함·기기 잠금·빈 결과·거리 미기록 시험.
- 실제 기기의 별도 테스트 건강 기록으로 러닝만 읽고 UUID/날짜/시간/거리 외 필드가 JS/로그/파일/계정에 유출되지 않는지 검증. 사용자의 기존 건강 DB를 자동 조회하지 말 것.
- 상한 100/90일, 경계 날짜와 UTC offset, 비러닝 제외, 기록 중복 UUID, 무거리 운동 확인.
- main-frame 정상 호출과 same-origin/cross-origin iframe 직접 호출, 외부 탐색/동일 URL reload/조회 중 탐색, HTTP proxy 경로, 동의창 중 문서 변경에서 결과 유출 없는지 검증.
- 기존 NativeDocuments 플러그인과 probe, 현재 기록 보관함, 브리지 초기화와 다른 script handler 동작에 회귀가 없는지 확인.
- 웹 후보 검토 UI와 저장/계정 전송 별도 확인, 출처 보존, 중복 처리 및 계정 격리 연결은 아직 남아 있다. 이 브리지만으로 시계 자동 동기화가 완성된 것은 아니다.
- Android **Health Connect 연동은 남아 있음**. 이 작업에서는 Android 코드나 Samsung 전용 SDK를 구현하지 않았다.

## 확인한 공식 출처 (2026-10-29)

agent-reach의 Jina Reader 경로로 Apple 공식 문서 내용을 확인했다.

- https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data : 유형별 동의, 읽기 거부 여부 비공개, capability 및 목적 문구, 먼저 기기 가용성 검사.
- https://developer.apple.com/documentation/healthkit/hkhealthstore/requestauthorization(toshare:read:completion:) : 빈 쓰기 집합/읽기 집합, 비동기 완료, 성공이 실제 읽기 허용을 뜻하지 않음.
- https://developer.apple.com/documentation/healthkit/hksamplequery : predicate, 정렬과 limit을 갖는 샘플 조회.
- https://github.com/ionic-team/capacitor/blob/8.5.3/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift : frameInfo 누락 경계와 기본 탐색 위임 동작.
- https://github.com/ionic-team/capacitor/blob/8.5.3/ios/Capacitor/Capacitor/CapacitorBridge.swift : public delegation handler 접근과 interceptor 경로.

## 독립 검토 P1/P2 보완 (2026-10-29)

이 절이 위 API 사용 예시보다 우선한다. **현재 실제 웹 consumer는 미통합이며 HealthKit 권한 요청/데이터 조회는 소스 상수 `consumerIntegrationReviewed = false`로 fail-closed이다.** helper opt-in, Info.plist, JS boolean, 임의 accountID로 이 게이트를 켤 수 없다. 가용성은 `enabled: false`, `blockedReason: CONTEXT_CONSUMER_NOT_INTEGRATED`를 표시하고 beginContext/읽기/권한 요청은 막힌다. 웹계정 OFF는 완화책일 뿐 일반 계정 격리 보장이 아니다.

새 `web-adapter/ios-health-context.js`는 iOS 전용 미연결 계약 모듈이다. bootstrap/router/auth에는 연결하지 않았다. Android의 health-context.js와 이름/역할을 공유하지 않는다. 테스트의 `consumerIntegrated: true`와 가짜 native는 합성 fixture 전용 사용이며 네이티브 상수나 실제 계정 인증을 대신하지 못한다. 이 요청에서는 public enable/서명/건강 DB 조회를 수행하지 않았다.

네이티브는 documentEpoch(기존 generation)·contextEpoch·sessionEpoch·lifecycleEpoch, 네이티브 발급 contextToken, 중복 방지 requestId와 활성 요청을 함께 바인딩한다. `beginContext`가 발급한 native snapshot만 요청에 사용한다. requestId/세대는 요청 연속성 경계이지 사용자 인증이나 계정 소유권 증명이 아니다. 임의 JS accountID는 전달하지도, 인증에 쓰지도 않는다.

후속 실제 통합 담당자는 **모든 SPA 화면 이동, 로그인·로그아웃·계정 전환, 관련 store 교체 전에** 소비자 invalidateContext/invalidateSession을 호출하고 ack를 await한 뒤 상태를 전환해야 한다. 로컬 pending은 즉시 STALE_CONTEXT로 닫히고 native gate는 원본 WKFrame 검증 후 control 메시지를 동기 처리해 기존 바인딩/티켓을 무효화한다. 새 화면·새 세션이 안정된 후에만 beginContext를 다시 열어야 한다. popstate/라우터의 이미 완료된 after-hook만 연결하는 것은 불충분하다. bootstrap/실제 router/auth/store 및 결과 적용 지점까지 모두 연결·검토하기 전에는 소스 게이트를 제거하면 안 된다.

동의 직후, HealthKit completion, 실제 resolve/reject 직전 모두 현재 바인딩과 foreground를 확인한다. 오래된 호출은 `releaseCall`/drop하며 새 문서에 reject까지 보내지 않는다. 로컬 소비자는 자체 세대로 낡은 성공/오류 적용을 막고 타임아웃을 처리한다. 네이티브 확인 UI의 정상 취소는 현재 문맥에서만 USER_CANCELLED를 반환하며 읽기 권한은 여전히 unknown이다.

willResignActive는 데이터 조회·앱 자체 동의창을 무효화하고 진행 중 query를 stop한다. 단, HealthKit 시스템 권한 UI의 정상적인 일시 inactive는 permission phase에서 따로 처리한다. 이때 완료 응답은 실제 foreground 복귀까지 보류하고 다시 검사한다. **실제 didEnterBackground는 permission phase도 포함해 모두 무효화한다.** 백그라운드 후 늦은 query 결과는 foreground로 돌아와도 새 화면에 전달하지 않는다. 복귀 시 자동 재조회/자동 재허가는 없다.

추가 실행: `node --test tests/ios-health-context.test.mjs` (합성 JS 및 Swift 소스 불변식 검사). 기존 `node --test scripts/configure-health.test.mjs`도 재실행한다. 새 테스트 역시 Swift compile, WebKit frame 전달, UIKit permission lifecycle, HealthKit 실기기 성공의 증거가 아니다. macOS/Xcode에서 `releaseCall` API/타입과 observer 수명, 실제 권한 UI 일시 inactive/진짜 background, SPA 전환 및 로그인·계정 교체 지연 결과, 같은 문서 동일 URL reload, callback release 동작을 별도 검증해야 한다. 후보 CI의 이전 커밋 결과가 이 변경을 검증하지 않으므로 부모의 새 커밋으로 다시 실행해야 한다.
