# SIG-TD 중국 공장 데모 배포 (운영 사이트와 분리)

## 무엇을 준비했나
- GitHub 브랜치: `demo/china-preview`
- 정적 데모용 EdgeOne Makers 설정: `edgeone.json`
- 기존 `main` 및 현재 Vercel 배포에는 영향을 주지 않음
- 데모는 실제 Supabase와 연결하지 않고 브라우저 로컬 저장소 및 예시 데이터만 사용
- 공장 담당자를 포함한 시연용 사용자 이름은 가명으로 변경

## 먼저 확인할 사항
중국 담당자가 오전에 접속했던 **어제의 전체 URL**과 지금 오류가 난 **전체 URL**을 문자 하나까지 비교합니다.
두 주소가 다르면 이전 링크가 열리는지 먼저 확인하세요. 같은 주소라도 안전성 검사 화면이 나타나면 브라우저 주소창에 `statics.teams.cdn.office.net` 또는 `safelinks`가 있는지 확인합니다. 이는 Microsoft Defender Safe Links 안내일 수 있습니다. 사내 IT팀에 정상 업무용 도메인의 검사 실패 여부를 확인해 주세요.

## EdgeOne Makers에서 GitHub를 통해 별도 데모 만들기
1. https://edgeone.ai/pages/new 에 로그인해 **Import Git Repository**를 선택합니다.
2. GitHub 저장소 `givenchy1952-made/SIG-TD`를 연결합니다.
3. 새 프로젝트 이름을 `sig-td-china-demo`로 설정합니다.
4. 배포 브랜치를 `demo/china-preview`로 선택합니다. 처음에 `main`만 선택된다면, 배포 전에 프로젝트 Git/환경 설정에서 **Production Branch**를 이 브랜치로 바꾼 뒤 새 배포를 실행합니다. **반드시 배포된 커밋의 브랜치가 `demo/china-preview`인지 확인하세요.**
5. 프레임워크는 `Vite`, 설치는 `npm ci`, 빌드는 `VITE_ENABLE_DEMO=true VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run build`, 출력 폴더는 `dist`를 사용합니다. 이 값은 `edgeone.json`에 포함돼 있지만 콘솔이 자동으로 인식하지 못하면 직접 입력합니다.
6. `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 등 운영 데이터베이스 관련 환경변수를 **입력하지 마세요.**
7. 배포 성공 후 생성된 실제 접속 URL을 확인하고 중국 담당자에게 전달해 현지에서 접속/화면 이동/샘플 수정 등을 점검합니다.

## 주의: 중국에서 접속 가능하다고 아직 보장할 수 없음
- EdgeOne의 중국 내 가속 구역에 자체 도메인을 연결하려면 일반적으로 중국 ICP 등록/备案이 필요합니다.
- EdgeOne 중국 포함 구역의 기본 프로젝트/배포 도메인 미리보기 URL은 **3시간 유효**하며, 새 URL이 필요할 수 있습니다. 장기 공유를 하려면 적절히 등록된 자체 도메인이 필요합니다.
- 중국 미포함 글로벌 구역의 기본 도메인은 중국에서 401 오류가 발생할 수 있습니다.
- 운영 DB를 연결하는 경우 중국에서 DB, 사진, 로그인 등 모든 기능을 별도로 점검해야 합니다. 이 브랜치는 가상 데이터 전용입니다.

## 테스트 체크리스트
- [ ] PC 크롬에서 메인 대시보드 열기
- [ ] 휴대폰 모바일 데이터로 접속하기
- [ ] 샘플 스타일 상세 확인 / 수정 / 저장
- [ ] '권한 체험'으로 공장 담당자 선택 후 본사와 권한 범위 비교
- [ ] 샘플 변경 후 새로고침 시 유지되는지 확인
- [ ] 데이터가 담당자마다 각자의 브라우저에만 저장되는 것을 안내

## 중국 공장에 보낼 테스트 안내(간체 중국어)
请在 Chrome 或 Edge 浏览器的地址栏直接输入我提供的演示网址，分别使用公司网络和手机流量测试。请确认能否打开主页、查看样衣进度、修改并保存演示数据。如果无法打开，请发送**包含完整地址栏**的截图，方便我们确认是否为 Microsoft 安全链接检查或网络连接问题。演示站使用的是虚拟数据，不包含正式订单数据。

## 공식 문서
- Vercel 중국 접속: https://vercel.com/kb/guide/accessing-vercel-hosted-sites-from-mainland-china
- EdgeOne SPA rewrites: https://pages.edgeone.ai/document/edgeone-json
- EdgeOne 중국 접속/ICP: https://edgeone.ai/document/175201428435140608
