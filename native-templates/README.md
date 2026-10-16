# 독립 Capacitor 8.5.3 래퍼용 제한 어댑터

원본 앱/원본 테스트를 수정하지 않는 템플릿입니다. 생성 플랫폼 통합, 의존성 설치, 번들링, CI, 네이티브 빌드/기기 QA는 부모 작업입니다. 이 폴더의 Java/Swift 파일은 아직 플랫폼 컴파일을 거치지 않았습니다.

## 파일과 JS API

- `web-adapter/bootstrap.js`: `@capacitor/core` 8.5.3의 `registerPlugin('NativeDocuments')` 선언과 초기 인터셉터.
- `native-templates/android/NativeDocumentsPlugin.java`: 앱 내부 플러그인. 패키지 자리표시자 `__APP_ID__`.
- `native-templates/ios/NativeDocumentsPlugin.swift`: `CAPBridgedPlugin` 및 정적 로컬 문서 모달.
- `native-templates/ios/NativeBridgeViewController.swift`: 플러그인 등록 및 새 디렉터리/빈 디렉터리 전용 명시적 백업 준비 헬퍼. 기존 비어 있지 않은 저장소의 메타데이터는 변경하지 않습니다.
- `scripts/native-adapter.test.mjs`: 독립 Node 테스트. 앱 테스트는 실행하지 않습니다.

플러그인 메서드:

```js
NativeDocuments.saveDocument({ filename, mimeType, dataBase64 })
// Promise<{status: 'saved' | 'cancelled'}>; 오류 시 reject
NativeDocuments.openLocalDocument({ path: 'legal/privacy.html' })
// Promise<void>; 번들 public/ 아래의 안전한 상대 .html 경로만 허용
NativeDocuments.openExternal({ url: 'https://example.org/' })
// Promise<void>; https/mailto 전용. 호출자는 반드시 사용자 클릭에서만 호출
```

허용 MIME은 정확히 `application/json`, `image/png`입니다. 데이터는 재인코딩하지 않고 Blob 원본 바이트를 base64로 전송합니다. 상한은 **33,554,432바이트(32MiB)**, 파일명은 UTF-16 기준 1~255자로 경로 분리자/제어문자/단독 점 경로를 거부하며 임의로 고치지 않습니다. OS 저장 창에서 사용자가 파일명을 바꾸는 것은 OS 동작입니다. 동시에 하나의 내보내기만 열고 중복 요청은 무시하거나 `BUSY`로 거부합니다. 저장 실패 UI를 원본 앱에 주입하지 않으며 JS 인터셉터의 거부는 조용히 종료합니다. 실제 실패/취소 동작은 기기 QA가 필요합니다.

`window.__NATIVE_CAPABILITIES__`에는 `secureContext`, `locksRequest`, `cryptoSubtle`, `indexedDB`, `localStorage`의 boolean만 기록합니다. getter 접근은 예외를 처리하며 잠금 요청, crypto 호출, 저장소 open/write/clear/migration을 수행하지 않습니다. true는 기능의 완전한 동작이나 영속성 보증이 아닙니다. Web Locks/crypto가 없으면 원본 fail-closed를 그대로 유지합니다.

## 웹 번들 통합

1. 부모 패키지에서 `@capacitor/core`, `@capacitor/android`, `@capacitor/ios`, `@capacitor/cli`를 **8.5.3**으로 고정합니다. 기본 뒤로가기 처리는 공식 `@capacitor/app` **8.1.2**에 맡깁니다.
2. 부모 esbuild가 `web-adapter/bootstrap.js`를 `bundle: true`, `format: 'iife'`, `platform: 'browser'`, `outfile: 'www/native/bootstrap.js'`로 빌드합니다. 이 파일을 ESM 그대로 웹뷰에 넣지 않습니다.
3. 생성 `www/index.html`에 `<script src="native/bootstrap.js"></script>`를 **기존 앱 모듈 스크립트보다 앞에**, async/defer 없이 넣습니다. 원본 소스 HTML/앱 모듈은 재작성하지 않습니다.
4. 기존 legal/support HTML 및 필요한 정적 리소스를 같은 상대 경로로 `www`에 복사하고 Capacitor sync로 플랫폼 public 자산에 포함합니다. HTML을 다른 사이트에서 로드하지 않습니다.
5. 웹 원본의 `URL.createObjectURL(blob)` → `a.download=...` → `a.click()` → 즉시 `URL.revokeObjectURL(...)` 흐름을 유지합니다. adapter가 클릭 순간 Blob 참조를 확보하므로 revoke 후 비동기 변환이 안전합니다. 설치 전에 만들어진 Blob URL은 캡처할 수 없습니다. 저장에는 capture 단계에서 관찰한 실제 `isTrusted === true` 클릭 또는 반복되지 않은 Enter/Space 키 입력이 먼저 필요합니다. 허가는 단조 시계 기준 5초 미만 유효하며 추적 중인 다운로드 시도에서 딱 한 번 소비됩니다. 따라서 원본 사용자 버튼 처리 후 비동기 PNG 생성과 `a.click()`은 창 안에서 허용되지만, 무허가/재사용/만료/합성 입력 다운로드는 native 호출과 브라우저 fallback 모두 막습니다. `navigator.userActivation`을 수정하거나 흉내 내지 않습니다. 모든 허용된 내보내기도 반드시 OS 저장 창을 거칩니다. 5초 이상 걸리는 내보내기는 다시 실제 사용자 입력이 필요합니다. 이 허가는 adapter 경로의 경계이며 악성 원본 앱 코드가 native bridge를 직접 호출하는 상황까지 막는 별도 보안 격리 기능은 아닙니다.
6. `_blank` 로컬 문서 링크는 `legal/privacy.html`, `/support.html`처럼 안전한 경로여야 합니다. `..`, `.`, 중복 슬래시, 백슬래시, 퍼센트 인코딩, query/hash, 절대 URL을 거부합니다. 모달은 JS 비활성, 네트워크 리소스 차단, 닫기 버튼을 제공합니다. 외부 https/mailto 링크는 trusted 사용자 클릭에서만 시스템 핸들러로 보내며 앱 웹뷰 안에 열지 않습니다. 프로그램에 의한 외부 링크 클릭은 막습니다.

## Android 통합

1. `__APP_ID__`를 확정 앱 ID(예정 `io.trainoracle.app`)로 바꾸고 Java 파일을 생성 프로젝트의 `android/app/src/main/java/io/trainoracle/app/NativeDocumentsPlugin.java`에 복사합니다. 디렉터리는 확정 패키지에 맞춥니다.
2. 같은 패키지의 `MainActivity extends BridgeActivity`에 `android.os.Bundle`을 import하고 다음을 추가합니다. 생성 파일에 이미 onCreate가 있으면 중복 선언하지 말고 병합합니다.

```java
@Override
public void onCreate(Bundle savedInstanceState) {
    registerPlugin(NativeDocumentsPlugin.class);
    super.onCreate(savedInstanceState);
}
```

`registerPlugin`을 bridge가 생성되는 `super.onCreate`보다 먼저 호출해 로컬 클래스를 초기 플러그인 목록에 넣습니다. 별도 플러그인 패키지/자동 등록 파일은 필요 없습니다. 부모가 사용하는 Capacitor 8.5.3 생성 프로젝트에서 컴파일 및 `isPluginAvailable('NativeDocuments')`를 확인해야 합니다.

3. 생성 `AndroidManifest.xml`의 `<application>`에 `android:allowBackup="false"`, `android:fullBackupContent="false"`, `android:dataExtractionRules="@xml/data_extraction_rules"`를 설정합니다. `res/xml/data_extraction_rules.xml`은 다음처럼 cloud와 device-transfer 양쪽을 제외합니다.

```xml
<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup disableIfNoEncryptionCapabilities="true">
    <exclude domain="root" path="."/><exclude domain="file" path="."/>
    <exclude domain="database" path="."/><exclude domain="sharedpref" path="."/>
    <exclude domain="external" path="."/>
    <exclude domain="device_root" path="."/><exclude domain="device_file" path="."/>
    <exclude domain="device_database" path="."/><exclude domain="device_sharedpref" path="."/>
  </cloud-backup>
  <device-transfer>
    <exclude domain="root" path="."/><exclude domain="file" path="."/>
    <exclude domain="database" path="."/><exclude domain="sharedpref" path="."/>
    <exclude domain="external" path="."/>
    <exclude domain="device_root" path="."/><exclude domain="device_file" path="."/>
    <exclude domain="device_database" path="."/><exclude domain="device_sharedpref" path="."/>
  </device-transfer>
</data-extraction-rules>
```

제조사 전송 정책은 OS/기기별 확인이 필요합니다. 별도 저장소/센서/헬스 권한은 추가하지 않습니다. ACTION_CREATE_DOCUMENT 시스템 저장 창에서 **선택 성공 후에만** 대상 URI stream을 엽니다. 취소 시 stream을 열지 않고 대기 메모리를 지웁니다. 앱이 프로세스 종료를 겪으면 메모리 Blob의 작업 복구는 제공하지 않습니다. 문서 모달의 닫기와 기본 dialog 닫기는 허용하되 MainActivity의 back override나 원본 history sentinel 우회는 추가하지 않습니다.

## iOS 통합

1. 두 Swift 파일을 생성 Xcode 프로젝트 `ios/App/App/`에 복사합니다. Xcode의 **Add Files to App**으로 둘 다 App target membership 및 Compile Sources에 포함합니다. 파일 복사만으로 Xcode 프로젝트에 등록된다고 가정하지 않습니다.
2. `Main.storyboard`의 기존 Capacitor bridge view controller를 선택하고 Identity inspector의 **Custom Class = NativeBridgeViewController, Module = App (현재 target module)**로 변경합니다. 기존 initial view controller/segue/window 연결은 그대로 둡니다. storyboard 없이 bootstrap하는 래퍼라면 root bridge controller를 이 클래스로 인스턴스화하는 부모 통합이 필요합니다.
3. `capacitorDidLoad()`의 `bridge?.registerPluginInstance(NativeDocumentsPlugin())`가 플러그인을 등록합니다. Objective-C 등록 shim이나 비공개 API는 사용하지 않습니다. 부모가 iOS 최소 16.0을 설정하고 Capacitor 8.5.3 및 실제 Xcode SDK에서 컴파일/동작 확인합니다.
4. signing/capabilities에서 **iCloud, CloudKit, HealthKit, background sync**를 추가하지 않습니다. 관련 usage description도 필요 없습니다. 외부 열기는 UIApplication의 공개 API, 파일 내보내기는 `UIDocumentPickerViewController(forExporting:asCopy:)`입니다.
5. **중요한 취소 범위:** 이 공개 iOS API는 저장 창을 열기 전에 내보낼 로컬 임시 원본을 요구합니다. 따라서 '취소 시 어떠한 로컬 쓰기도 전혀 없음'은 이 API와 양립하지 않습니다. 템플릿은 전용 UUID tmp 폴더에 보호된 원본을 만들고 backup 제외를 best-effort 설정한 뒤 성공/취소/오류 시 제거합니다. 취소 시 사용자가 고른 목적지에는 파일을 내보내지 않습니다. 강제 종료 시 남을 수 있는 tmp는 OS 정리 대상이며 앱 시작 시 임의 삭제/복구는 하지 않습니다. 이 의미를 더 강한 무쓰기 보장으로 표현하지 마세요.
6. bridge controller에는 백업 준비 자동 호출이 **없습니다**. startup/bridge 준비/화면 표시/foreground에서 기존 저장소를 반복 변경하지 않습니다. 대신 같은 Swift 파일의 `NativeStoreBackupPreparation.prepareBeforeWebViewCreation()`를 부모가 명시적으로 통합할 수 있습니다. 이 헬퍼는 현재 **앱 전용 native sandbox**의 Documents, Library/WebKit, Library/Application Support, Library/Caches/WebKit만 다룹니다. 누락 디렉터리는 생성하고, 실제 디렉터리이며 비어 있음이 확인될 때만 `isExcludedFromBackup` 메타데이터를 설정합니다. 비어 있지 않은 기존 저장소는 메타데이터까지 그대로 건너뛰며, 심볼릭 링크도 건너뜁니다. 비어 있음 확인은 디렉터리 항목 이름 목록만 조회하며 저장된 값은 열지 않습니다. 삭제/이동/마이그레이션/기존 브라우저 사용자 저장소 접근은 하지 않습니다.

   **필수 부모 통합 지점:** AppDelegate의 `application(_:willFinishLaunchingWithOptions:)` 등 최초 실행 준비에서, **어떤 CAPBridgeViewController/WKWebView/저장소 writer도 생성되기 전** 동기적으로 `NativeStoreBackupPreparation.prepareBeforeWebViewCreation()`를 호출해야 합니다. 단순히 `capacitorDidLoad`나 `viewDidLoad`, `didFinishLaunching` 마지막에 넣지 마세요. storyboard 자동 로딩 시점이 먼저라면 부모가 lifecycle 순서를 검증하거나 수동 root controller 구성으로 먼저 준비해야 합니다. 순서를 보장할 수 없으면 헬퍼를 호출하지 말고 백업 제외를 미확인 상태로 보고해야 합니다. 이미 웹뷰/저장소 writer가 동작하는 동안 호출하면 emptiness 확인과 metadata 쓰기 사이 경합을 보장할 수 없습니다. 여러 writer가 없는 초기 lifecycle에서만 사용합니다.

   비어 있지 않은 기존 앱 저장소는 보존 우선이므로 이 헬퍼로 백업 제외를 보장하지 않습니다. 새 디렉터리에서 실제 WebKit 저장소의 백업 제외 상속도 실기기 QA가 필요합니다. 전체 백업 완전 차단이나 iCloud 동기화 기능을 주장하지 않습니다.

## 검증과 제한

실행: `node --test scripts/native-adapter.test.mjs`. JSON/PNG 원본 바이트, 즉시 revoke, 32MiB 경계, traversal/외부 URL, trusted click, 1회용 저장 허가/재사용/5초 만료/키보드/비동기 PNG, 비변경 capability 탐지 및 네이티브 템플릿 정적 계약을 검사합니다. 백업 테스트는 빈 디렉터리 guard와 반복 자동 호출 부재를 확인하며 기존 비어 있지 않은 저장소의 metadata 변경을 요구하지 않습니다. 정적 문자열 검사는 네이티브 실행/컴파일 검증을 대신하지 않습니다.

기기 QA: 등록 성공, 실제 OS 저장 창/취소/실패, 저장 바이트 해시, 이름 보존, 앱 재실행 후 원본 IndexedDB/localStorage 영속성, Web Locks/crypto 실기능, 모달 Close 및 외부 링크, Android back sentinel, iOS 백업 제외 상태, remote resource 차단을 확인합니다. 앱/원본 suite, 네이티브 빌드, signing, store 심사, 백업 테스트는 여기서 실행하지 않았습니다.

공유 플러그인/소셜 공유/계정/클라우드 동기화/센서/헬스 SDK/분석/파일명·데이터 로그는 추가하지 않습니다. OS 저장 창이 제공하는 목적지에는 사용자가 설치한 클라우드 파일 제공자가 포함될 수 있으며 앱이 자동 동기화하는 것은 아닙니다. '전체 앱에서 수집 데이터 없음' 같은 개인정보 표시 결론을 이 어댑터만으로 주장하지 마세요. 실제 원본 앱과 최종 의존성을 따로 검토해야 합니다.

의존성 고지 참조: `THIRD_PARTY_NOTICES.md`.
