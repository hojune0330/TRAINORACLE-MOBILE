# 추가 프레임워크 라이선스 고지

| 패키지 | 고정 버전 | 라이선스 | upstream |
|---|---|---|---|
| @capacitor/core | 8.5.3 | MIT | https://github.com/ionic-team/capacitor |
| @capacitor/android | 8.5.3 | MIT | https://github.com/ionic-team/capacitor |
| @capacitor/ios | 8.5.3 | MIT | https://github.com/ionic-team/capacitor |
| @capacitor/cli (빌드 도구) | 8.5.3 | MIT | https://github.com/ionic-team/capacitor |
| @capacitor/app (부모 통합 기본 back 처리) | 8.1.2 | MIT | https://github.com/ionic-team/capacitor-plugins |
| esbuild (부모 번들 도구) | 부모 lockfile 버전 | MIT | https://github.com/evanw/esbuild |

설치/최종 배포 단계에서 **실제로 잠긴 패키지의 LICENSE 원문 및 저작권 줄**을 수집해 배포 고지에 포함해야 합니다. 참조 위치는 `node_modules/@capacitor/{core,android,ios,cli}/LICENSE*`, `node_modules/@capacitor/app/LICENSE*`, `node_modules/esbuild/LICENSE*`이며 플랫폼 전이 의존성 고지도 별도로 포함합니다. 이 목록은 전이 의존성 전체 감사 결과가 아닙니다. 버전별 upstream LICENSE와 배포물의 원문이 최종 기준입니다.

MIT License (표준 허가문, 실제 저작권 표시는 위 패키지 원문 유지):

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
