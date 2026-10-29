# Android Health Connect 독립 연동 후보

상태: **기본 OFF · UNREVIEWED · 네이티브 컴파일/기기/UI 검증 미실행**

이 변경은 기존 생성기·릴리스 설정·Swift·`configure-health.mjs`를 수정하지 않는다. 실제 건강 DB·계정·비밀값·서명·배포에 접근하지 않았다. Samsung Health 전용 SDK를 사용하지 않는다. 삼성 헬스 등 원본 앱이 **Health Connect에 실제 공유했고 사용자가 읽기를 승인한 활동만** 읽을 수 있다. 삼성 계정 로그인, 시계 직접 연결, 삼성 헬스 전체 기록·과거 기록 접근을 보장하지 않는다.

## 파일과 현재 실행 경계

- `native-templates/android/NativeHealthPlugin.kt`: Capacitor `NativeHealth` 플러그인과 시스템 권한 설명용 네이티브 Activity. 패키지 자리표시자는 `__APP_ID__`.
- `scripts/configure-android-health.mjs`: `planAndroidHealth(input, { enabled: false })` 순수 함수. 기본 호출은 빈 파일 계획을 반환한다. 파일을 쓰거나 CLI·생성기·빌드를 실행하지 않는다. `enabled: true`만 Android 생성물 다섯 파일의 내용 계획을 반환한다.
- `scripts/configure-android-health.test.mjs`: 합성 fixture 및 Kotlin **소스 계약** 정적 검사. 실제 건강 데이터 없음.
- 본 문서.

기존 `generate-native.mjs`에 자동 연결하지 않았으므로 현재 `generate:native`로 건강 권한이 활성화되지 않는다. 함수 import 또한 부작용이 없다. 기존 출력 디렉터리에 이 helper를 따로 적용하거나 기존 metadata를 덮어쓰면 안 된다.

## 공식 근거와 고정 버전 검토

2026-10-29 공식 문서를 agent-reach의 Jina 웹 읽기 경로로 확인했다.

- Android 시작 가이드: https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started
  - Android 14 이상은 프레임워크 모듈, Android 13 이하는 별도 제공자 앱.
  - `getSdkStatus`, `getOrCreate`, `PermissionController.createRequestPermissionResultContract`, 매 작업 전 `getGrantedPermissions` 재확인.
  - 제공자 package query, Android 13 이하 `ACTION_SHOW_PERMISSIONS_RATIONALE`, Android 14 이상 보호된 `VIEW_PERMISSION_USAGE` alias 필요.
  - connect-client 1.1.0 이상: compileSdk 36 및 AGP 8.9.1 이상 요구.
- AndroidX 릴리스: https://developer.android.com/jetpack/androidx/releases/health-connect
  - 확인한 안정판은 **1.1.0**, 2025-10-08 정식 출시. 가이드 예제의 1.2.0-alpha06 대신 안정판으로 고정.
- 읽기 가이드: https://developer.android.com/health-and-fitness/guides/health-connect/develop/read-data
  - `ReadRecordsRequest`, 시간 범위·페이지 처리, 전경 읽기와 별도 백그라운드 권한의 구분. 기본 과거 조회 제한을 우회하지 않는다.

계획의 정확한 고정값: Capacitor **8.5.3**, Health Connect **1.1.0**, Kotlin Gradle plugin **2.2.20**, kotlinx-coroutines-android **1.10.2**, JDK/JVM **21**, compileSdk **36**. Kotlin·coroutines 조합은 후보 고정값이지 실제 Android 의존성 해결/컴파일 호환성을 검증했다는 뜻이 아니다. 기존 AGP를 자동 업그레이드하지 않으며 helper는 AGP 8.9.1 이상 8.x의 정확한 버전 문자열만 허용한다. 신규 major는 별도 검토한다. wrapper minSdk 26은 유지하되 Health Connect 미지원 기기에서는 `availability` 결과로 기능을 차단한다. Android 9 이상 지원 기기·제공자 조건도 기기 검증이 필요하다.

## API와 최소 권한

`NativeHealth`는 다음 세 메서드만 노출한다.

1. `availability()`: `available`, `provider-update-required`, `unavailable`와 현재 운동 읽기 승인 여부. 권한 화면을 열거나 데이터를 조회하지 않는다.
2. `requestReadPermission()`: 네이티브 설명/수동 확인 다음에 정식 Health Connect 권한 계약을 연다. 취소·거절 가능. 결과 callback에서 실제 승인 상태를 재조회한다. 앱 시작·load·resume에서 요청하지 않는다.
3. `readRecentRunningSessions({ startTime, endTime, limit? })`: ISO-8601 Instant, 미래 금지, 최근 **28일** 안에서 최대 **7일** 범위, 기본 50/최대 **100개**, 100개씩 최대 **5페이지/500개 원본 운동** 조회. 달리기만 필터링하며 범위를 완전히 벗어나거나 걸친 활동은 반환하지 않는다. 매 읽기와 permission result 전후 출처/권한을 재확인한다. 네이티브 읽기 확인창도 필요하다.

추가 권한은 `android.permission.health.READ_EXERCISE` 하나다. 기존 INTERNET 권한은 보존하지만 이 플러그인은 네트워크를 사용하지 않는다. 쓰기·GPS·운동 경로·메모·제목·심박·거리·칼로리·수면·건강 과거 무제한·백그라운드 권한은 추가하지 않는다. ExerciseSessionRecord API 응답 자체는 제공자가 정한 모델이며, 이 후보는 title/notes/route 속성을 읽거나 브리지로 직렬화하지 않는다. 경로 전용 API도 호출하지 않는다.

DTO 허용 필드:

```json
{
  "provider": "health-connect",
  "sourcePackage": "원본 앱 패키지",
  "sourceRecordId": "Health Connect record id",
  "startTime": "UTC Instant",
  "endTime": "UTC Instant",
  "exerciseType": "running",
  "reviewStatus": "UNREVIEWED"
}
```

외부 응답에는 `sessions`, `bounded`, `scannedRecords`, `pagesRead`가 있다. `bounded: true`는 개수·페이지 경계로 잘렸을 수 있다는 뜻이다. 최근순 원본 운동 중 달리기만 필터링하므로 다른 운동이 많으면 달리기 100개를 모두 찾지 못할 수 있다. 빈 목록은 권한 거절·시계 기록 없음·삼성 헬스 기록 없음의 증거가 아니다. 원본이 아직 동기화하지 않았거나, 접근 가능한 기간·지원 유형이 달라질 수 있다. treadmill 등 다른 운동 타입은 이 후보에 포함하지 않는다.

## 신뢰·계정·보존 경계

- 허용 WebView origin은 **https://localhost**의 기본 포트/사용자 정보 없음뿐이다. 원격 https://trainoracle.io, http, 명시 포트, 다른 호스트는 차단한다. 진입·페이지 조회·응답 시점에 다시 확인한다. 플랫폼 JS 브리지의 XSS까지 해결하는 보안 경계는 아니므로 기존 번들/탐색/CSP 검증을 그대로 유지해야 한다.
- 네이티브 수동 확인, 단일 작업 busy lock, 전경 상태, 취소·권한 철회·origin 변경을 방어한다. 시스템 권한 화면으로 전환한 경우 결과 callback에서 다시 검사한다. 원시 예외/건강 데이터는 로그에 남기지 않는다.
- 모든 DTO는 **UNREVIEWED**이며 이 후보에 승인·저장 API는 없다. 웹 UI 수동 검토 전 ACCOUNT/PENDING 기록으로 자동 변환하거나 업로드하지 않는다.
- provider/원본 앱/record id를 함께 보존한다. 삼성 헬스라는 이름으로 모든 Health Connect 결과를 재라벨링하거나 기존 JSON 파일 import로 포장하지 않는다. record id는 이 기기·제공자 맥락용이며 영구 범용 ID로 가정하지 않는다. 여러 앱의 같은 운동은 중복일 수 있으므로 UI/기존 dedup 경계가 필요하다.
- DTO는 메모리 응답만 제공하며 파일·DB·설정·캐시·서버에 저장하지 않는다. 네이티브 객체 수명/GC 차원의 보장이지 암호학적 메모리 지우기 보장은 아니다. 계정 변경·로그아웃 때 웹 미리보기 폐기, revision/명시 승인/계정 격리는 기존 ingest 계약에서 처리해야 한다.
- permission rationale Activity는 정적 네이티브 문구만 표시하며 extras·WebView·건강 API를 처리하지 않는다. 배포용 개인정보 처리방침을 완성했다는 뜻이 아니다.

## 나중에 생성기에 opt-in 연결할 때 필요한 순서

현재는 아래 연결을 **하지 않았다**. 별도 검토 및 새 생성 디렉터리에서만 수행한다.

1. 기존 소스 SHA, 의존성/lock/version 고정, web receipt, account-off 환경, canonical path·ancestor·symlink 검사, 플랫폼 디렉터리/기존 generation metadata 존재 시 거절을 먼저 그대로 수행한다. 기존 자료를 삭제하거나 재사용하지 않는다.
2. 기존 manifest 변환으로 INTERNET-only/backup-off/cleartext-off 게이트를 통과시킨 후 **명시적 새 Android opt-in**일 때만 이 순수 planner에 해당 생성물 문자열을 넘긴다. 기본 OFF를 유지하고 ios 경로는 건드리지 않는다. planner 문자열 검사는 기존 실제 파일/receipt 검증을 대체하지 않는다.
3. 현재 생성기 내부의 경계 검사된 `writeNative`로 반환된 다섯 상대경로만 쓴다. helper를 임의 파일 수정용 CLI로 노출하지 않는다. 실제 Kotlin template 해시와 dependency resolution을 새 metadata에 기록하고 승인된 후보인지 확인한다.
4. 출력 후 소스/receipt 불변, safeTree, permissions/backup·리소스, Android manifest merge 및 기존 NativeDocuments smoke를 다시 검사한다. health-on 프로파일에 대해서만 기존 manifest 검증을 명시적으로 확장해야 하며 기존 gate 전체를 제거하면 안 된다.
5. 새 generation metadata는 exclusive-create로 남기며 OFF/ON, 후보 해시, 버전, UNREVIEWED, 컴파일/기기/UI 증거를 별도 기재한다. 기존 metadata·실패 증거·기록을 덮어쓰거나 삭제하지 않는다.

## 검증과 남은 차단조건

실행 가능한 정적 검증:

```sh
node --check scripts/configure-android-health.mjs
node --test scripts/configure-android-health.test.mjs
```

이 테스트는 12개 fixture/소스 계약 검사다. **Kotlin 문법 검사·Android 컴파일·SDK 링크·manifest merge·실제 권한 UI 성공을 뜻하지 않는다.**

`[blocked]` 실제 Android 컴파일: 현재 세션 PATH에 java/kotlinc/gradle이 없고 Android 생성물/SDK 의존성을 구성하지 않았다. JDK 21, Android SDK 36, 검토된 Gradle wrapper/AGP, 고정 Maven 의존성 해결, 새 Android 생성 디렉터리와 기존 receipt/보존 게이트 통과가 필요하다. 연결 후 최소 `:app:compileDebugKotlin`, `:app:processDebugMainManifest`, `:app:assembleDebug`를 실행하고 산출물 해시/로그를 남겨야 한다. 이 문서와 정적 fixture를 빌드 성공으로 보고하면 안 된다.

`[blocked]` 기기/UI: 실제 Android 13 이하 제공자 및 Android 14 이상 기기에서 미설치/업데이트 필요/지원 불가, 수동 승인/거절/취소/철회, 최초 실행 무권한, 원격 origin 차단, 전경 이탈, 프로세스 재생성, 다중 요청, 제한/빈 목록, 원본 앱 공유/중복, GPS·경로 노출 없음, UNREVIEWED와 수동 계정 ingest 경계를 검증해야 한다. 삼성 헬스의 실제 공유도 사용자가 기기에서 설정해야 한다.

`[blocked]` 배포: 실제 개인정보 처리방침/문의·보관·삭제 문구, Play Console Health Connect 데이터 접근 선언·건강 앱 정책·개발자 계정 요건, 스토어 심사·서명·사용자 승인은 별도다. 어떠한 배포 승인도 이 후보에 포함하지 않는다.
