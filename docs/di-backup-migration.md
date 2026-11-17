# DI팀 전용 백업·복호화·마이그레이션

DI 모드는 로컬 CLI 전용입니다. 사이트/UI/API를 변경하지 않으며 소스 DB에는 읽기 전용 연결만 사용합니다. 운영 DB에 migration SQL을 적용하지 않습니다. 실제 운영 백업은 개발 테스트에 사용하지 않습니다.

## 1. 전체 백업과 DI 백업의 차이

| 항목 | 기존 전체 모드 | DI 모드 |
|---|---|---|
| 실행 | `node scripts/backup-workspace.mjs` | `node scripts/backup-workspace.mjs --mode=di` 또는 `node scripts/backup-di.mjs backup` |
| public 구조·관계·함수·트리거·RLS | 포함 | 검토된 SQL 포함 |
| public 업무 데이터·업무 사용자 UUID | 포함 | 검토된 컬럼, PostgreSQL text 값으로 포함 |
| 전체 DB dump / auth 데이터·해시·MFA | 포함 | **생성하지 않음** |
| 인증 세션·서버 키·DB 비밀번호 | 전체 dump에 포함될 수 있음 | 제외. 환경 설정만 로컬에서 사용 |
| Storage | 전체 버킷·파일 | 전체 버킷·파일, 경로·메타데이터·SHA-256 |
| 복원 | 기존 `restore-workspace.mjs` | 이 문서에 따라 별도 대상에서 이식 |

DI 파일에 기존 전체 복원 도구를 적용하면 대상에 접속하기 전에 거부합니다. 전체 백업을 DI팀에 전달하지 마세요. 기존 전체 백업·복원 기능은 유지하지만, 기존 Actions의 운영 백업/Artifact 업로드는 제거했습니다. Actions는 비밀값 없이 Linux/Windows 합성 테스트만 실행합니다. DI 백업·복호화는 `GITHUB_ACTIONS=true` 환경에서도 거부합니다.

DI 암호화 파일 내부:

- `db/public-schema.sql`: public 테이블·타입·뷰·인덱스·함수·트리거·RLS·FK·권한 등 `pg_dump --schema-only --schema=public --no-owner` 결과를 검토한 SQL.
- `db/public-data.json`: `postgres-text-v1`. 테이블별 컬럼/타입/생성 컬럼 정보, 제외 컬럼, 행 배열. 각 셀은 PostgreSQL `::text` 문자열 또는 JSON null입니다. bigint/numeric, JSON 내부 큰 숫자도 정밀도를 보존합니다.
- `db/catalog.json`: 컬럼, 외래키의 원본/대상 컬럼, 외부 스키마 의존성, 시퀀스 정보. auth 행은 조회하지 않습니다.
- `storage/<경로의 SHA-256>.bin`: 원본 파일 바이트. 실제 bucket/name은 manifest로 연결합니다.
- `manifest.json`: UTC 백업 시각, 원본 프로젝트 ID, public 테이블별 행 수, 버킷·객체 메타데이터, 파일 크기/SHA-256, Storage owner ID·원본 DB 메타데이터(인증 키 제외), 제외 컬럼, 검토 해시, 일관성 수준.

`auth.users` FK **정의**는 업무 관계이므로 보존하지만 auth 테이블 **행**은 백업하지 않습니다. auth 가입 트리거와 Storage 정책 등 public 밖의 정의는 DI 형식에 포함하지 않습니다. 대상 플랫폼에 맞춰 별도로 검토·설정하세요. public 함수가 `auth.uid()` 등을 참조하면 대상에도 호환 함수/인증 연동이 필요합니다.

## 2. Windows 설치

1. 회사가 승인한 Node.js **22 이상 LTS** Windows installer를 https://nodejs.org/ 에서 설치합니다. npm과 PATH 옵션을 선택합니다.
2. https://www.postgresql.org/download/windows/ 의 PostgreSQL installer에서 **Command Line Tools**를 설치합니다. 로컬 DB 서버 설치는 필요하지 않습니다. `psql.exe`, `pg_dump.exe`, 이식 시 `pg_restore.exe`가 필요합니다. 클라이언트 major는 원본 DB 이상이어야 하며 대상 호환 버전도 확인합니다.
3. 새 PowerShell을 열고 설치를 확인합니다. 예시는 PostgreSQL 17 경로입니다. 실제 설치 버전으로 바꾸세요.

```powershell
node --version
npm --version
$env:Path = 'C:\Program Files\PostgreSQL\17\bin;' + $env:Path
psql --version
pg_dump --version
```

4. Git으로 저장소를 받은 뒤 의존성을 lockfile 기준으로 설치합니다. 백업 암호/운영 데이터는 저장소에 넣지 않습니다.

```powershell
git clone https://github.com/givenchy1952-made/SIG-TD.git
Set-Location SIG-TD
# PR 병합 전 시험은 PR의 소스 브랜치를 checkout한 뒤 실행
npm ci --ignore-scripts
```

Git을 사용하지 않으면 PR의 소스 ZIP을 받아 압축 해제한 폴더에서 같은 npm 명령을 실행할 수 있습니다. 별도 npm 패키지나 Supabase CLI 설치는 필요하지 않습니다.

5. 회사 승인 비공개 디스크에 폴더를 만듭니다. 아래 경로는 **예시**이며 저장소 바깥, OneDrive/Git/공유 동기화 대상 밖이어야 합니다. Windows의 Node `mode: 0600`은 NTFS ACL을 보장하지 않으므로 폴더의 속성 → 보안에서 담당자만 접근하도록 설정하고 BitLocker를 사용합니다.

```powershell
New-Item -ItemType Directory -Path 'D:\DI-Secure' -Force
notepad 'D:\DI-Secure\di.env'
```

환경 파일은 Node `--env-file` 형식입니다. 실제 값은 로컬에서만 입력합니다. 값에 `#`가 있으면 따옴표로 감쌉니다. 경로는 `/` 사용을 권장합니다.

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_DB_URL=postgresql://postgres:URL_ENCODED_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres
SUPABASE_SERVICE_ROLE_KEY=LOCAL_SERVER_KEY
SIG_BACKUP_PASSPHRASE=REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS
SIG_DI_REVIEW_DIRECTORY=D:/DI-Secure/review-001
SIG_DI_POLICY_FILE=D:/DI-Secure/review-001/policy.json
SIG_BACKUP_DIRECTORY=D:/DI-Secure/backups
PSQL_BIN=C:/Program Files/PostgreSQL/17/bin/psql.exe
PG_DUMP_BIN=C:/Program Files/PostgreSQL/17/bin/pg_dump.exe
# 인증서가 필요한 경우만 실제 파일 경로 추가
# SUPABASE_DB_SSL_ROOT_CERT=D:/DI-Secure/supabase-db-ca.crt
# 기본 256MiB, 최대 2GiB (ZIP을 메모리에 구성)
SIG_BACKUP_MAX_BYTES=268435456
```

암호는 최소 32자의 무작위 문자열을 별도로 만들어 비밀번호 관리자에 보관합니다. DB/API 키와 동일한 암호를 사용하지 마세요. DB 비밀번호의 특수문자는 URL 인코딩합니다. IPv6 direct 접속이 안 되면 Supabase 대시보드의 **session pooler 5432** 주소와 `postgres.PROJECT_REF` 사용자를 사용합니다. transaction pooler 6543은 거부합니다. API 프로젝트와 DB 프로젝트가 일치해야 하며 TLS `verify-full`을 사용합니다. 인증서 검증은 끄지 않습니다.

DB 계정은 전체 업무 행을 읽을 수 있어야 합니다. DI 연결은 `default_transaction_read_only=on`, `row_security=off`를 강제하므로 RLS 때문에 일부 행만 보이는 계정이면 조용히 불완전한 백업을 만드는 대신 실패합니다. 서비스 키는 Storage 읽기에만 사용하며 브라우저 코드에 전달하지 않습니다.

## 3. 먼저 비밀정보 검토

```powershell
# PowerShell 실행 정책으로 ps1이 차단되면 바로 아래 Node 명령 사용
.\scripts\backup-di.ps1 -Mode Review -EnvironmentFile 'D:\DI-Secure\di.env'
# 동일한 실행
node --env-file='D:\DI-Secure\di.env' scripts/backup-di.mjs review
```

둘 중 하나만 실행합니다. review 폴더는 처음에는 없어도 되며 기존 파일은 덮어쓰지 않습니다. 다시 검토할 때는 새 폴더를 지정하세요. review는 업무 행을 내보내지 않고 읽기 전용 snapshot에서 public DDL과 카탈로그를 추출합니다. **DDL 자체에도 비밀정보가 있을 수 있으므로 검토 파일을 PR·채팅·Artifact에 붙이지 마세요.**

`policy.json`은 처음에 `reviewed: false`, `storageReviewed: false`입니다. 담당자가 다음을 확인한 다음에만 둘을 true로 바꿉니다.

- `tables`의 모든 컬럼은 `include` 또는 `exclude` 중 정확히 하나에 있어야 합니다. 업무 컬럼과 UUID는 include에 유지하고 인증 비밀값 컬럼은 exclude로 이동합니다. 이름에 password/token/secret/credential/API key/MFA/session 등 인증 키워드가 있으면 자동 exclude이며 include로 되돌릴 수 없습니다. FK 컬럼 제외는 거부합니다.
- 일반 이름의 컬럼에도 비밀값이 저장될 수 있습니다. 스키마·업무 데이터 모델·인증 연동을 검토하여 해당 컬럼을 명시적으로 exclude합니다. 제외 컬럼의 값은 조회 SQL에도 들어가지 않습니다. 행 수는 유지합니다.
- JSON/JSONB와 감사 before/after 안의 인증 키 이름은 재귀 제거합니다. 평범한 키 이름에 들어간 비밀정보는 자동으로 판별할 수 없습니다. 그런 JSON 컬럼은 통째로 exclude하거나 조직이 검증한 별도 변환 절차를 먼저 설계해야 합니다. 원본 운영 데이터를 수정해서 해결하지 않습니다.
- 함수 본문·DEFAULT·뷰·COMMENT 등에 하드코딩된 비밀값을 검사합니다. 필요하면 **로컬 `public-schema.sql`만** 편집하여 리터럴을 제거하고 대상의 외부 비밀관리 방식으로 대체합니다. 테이블·관계·함수의 업무 의미와 대상 설정을 다시 검토합니다. 편집했다면 아래 해시를 `policy.json`의 `exportSchemaSha256`에 기록합니다. `schemaSha256`은 원본 구조 변경 감지용이므로 바꾸지 않습니다.

```powershell
(Get-FileHash 'D:\DI-Secure\review-001\public-schema.sql' -Algorithm SHA256).Hash.ToLowerInvariant()
```

- 모든 Storage 파일과 메타데이터에 인증 비밀값 파일이 없는지 데이터 소유자가 확인합니다. 이미지/PDF/압축파일 안의 임의의 비밀정보를 자동 판별하는 기능은 없습니다. 파일은 바이트 단위로 보존하므로 임의로 내용을 지우지 않습니다. 비밀정보가 섞인 파일이 있으면 전부 포함/비밀정보 제외 조건을 함께 만족할 수 없으므로 전달을 중단하고 별도 정제 이관 방식을 결정합니다.

토큰 패턴, DB URL, Bearer, JWT, private key, 현재 접속 비밀값이 발견되면 백업은 실패합니다. 이는 보조 검사이며 수동 검토를 대체하지 않습니다. 구조/컬럼이 검토 이후 달라지면 다시 review해야 합니다. 시퀀스 현재값 변화는 구조 변경으로 보지 않습니다. 검토되지 않은 새 컬럼은 자동으로 포함하지 않습니다.

## 4. DI 백업 실행 및 전달

가능하면 파일 업로드·교체·삭제를 멈춘 시간에 실행합니다. 운영 DB/사이트 데이터를 수정하거나 삭제하는 명령은 없습니다.

```powershell
.\scripts\backup-di.ps1 -Mode Backup -EnvironmentFile 'D:\DI-Secure\di.env'
# 또는
node --env-file='D:\DI-Secure\di.env' scripts/backup-workspace.mjs --mode=di
```

성공하면 파일 경로, 테이블/파일 수, SHA-256, `mode: di`, `verified: true`만 출력합니다. AES-256-GCM + scrypt, 매번 새 salt/nonce, 인증된 헤더를 사용합니다. 저장 직후 복호화·GCM tag·모든 내부 파일 SHA-256/크기를 다시 검증합니다. 실패한 최종 파일은 제거합니다. `SIG-DI-*.sigbackup`과 `.sha256` 두 파일만 승인된 비공개 전달 경로로 옮기고 **암호는 별도 채널**로 전달합니다. 환경 파일과 review 파일은 전달하지 않습니다. 공개 GitHub와 GitHub Actions Artifact에 올리지 않습니다.

```powershell
Get-FileHash 'D:\DI-Secure\backups\SIG-DI-실제파일명.sigbackup' -Algorithm SHA256
Get-Content 'D:\DI-Secure\backups\SIG-DI-실제파일명.sigbackup.sha256'
```

해시 문자열이 같은지 비교합니다. 외부 SHA 파일만으로 악의적 변경을 인증할 수는 없으며 GCM 검증이 최종 기준입니다.

DB 구조·행 수·업무 데이터는 하나의 repeatable-read snapshot입니다. Storage API 목록을 DB snapshot 및 다운로드 전후와 비교하여 변경 시 실패합니다. DB와 Storage를 묶는 원자적 snapshot은 아니며 시퀀스 값도 PostgreSQL 특성상 MVCC 대상이 아닙니다. 기본 총 크기 256MiB/최대 2GiB, 최대 파일 100,000개이며 메모리 여유가 필요합니다. 현재 psql 응답은 쿼리당 약 10MB로 제한되므로 큰 단일 테이블은 실패할 수 있습니다. 이런 규모는 스트리밍 방식의 추가 설계가 필요하며 제한을 무시하지 마세요. 임시 SQL은 정상/오류 종료 시 삭제되지만 강제 종료 시 `sig-di-*` 임시 폴더가 남을 수 있습니다. 디스크 암호화와 담당자의 로컬 정리가 필요합니다.

## 5. DI팀 복호화

DI팀 PC에도 Node.js 22+와 동일 코드/lockfile의 `npm ci --ignore-scripts`만 필요합니다. 복호화에는 PostgreSQL client/운영 DB/API 키가 필요하지 않습니다. 별도 비공개 `decrypt.env`에는 `SIG_BACKUP_PASSPHRASE`와 필요하면 `SIG_BACKUP_MAX_BYTES`만 넣습니다.

```powershell
.\scripts\backup-di.ps1 -Mode Decrypt -EnvironmentFile 'D:\DI-Secure\decrypt.env' -BackupFile 'D:\DI-Secure\received.sigbackup' -OutputDirectory 'D:\DI-Secure\decrypted-001'
# 또는
node --env-file='D:\DI-Secure\decrypt.env' scripts/backup-di.mjs decrypt 'D:\DI-Secure\received.sigbackup' 'D:\DI-Secure\decrypted-001'
```

출력 폴더는 **아직 존재하지 않는 경로**여야 합니다. 암호·인증 태그·전체 체크섬·압축 해제 한도·경로를 먼저 검증하고 그 후 파일을 씁니다. 기존 폴더는 덮어쓰지 않습니다. 실패하면 새로 만든 평문 폴더를 제거합니다. 복호화된 자료에는 개인정보·업무기밀이 있으므로 담당자만 접근하고 이관 종료 후 회사 보관 정책에 따라 정리합니다.

## 6. 인증 제외에 따른 FK와 UUID 매핑

현재 저장소는 `public.profiles.id → auth.users.id`를 사용하고 다른 업무 테이블은 profiles UUID를 참조합니다. 로그인 비밀번호/세션을 옮기지 않아도 **업무 UUID는 반드시 보존**해야 합니다. `db/catalog.json`의 모든 FK를 먼저 분류하고 JSON 감사 이력·Storage 경로에 담긴 UUID도 검토합니다. 이메일은 사람이 확인하는 매칭 보조값이며 그 자체를 안전한 자동 매칭 키로 취급하지 않습니다.

선택 A: 새 인증 시스템에서 원래 UUID 지정 생성이 가능하면 새 계정을 **동일 UUID로 새로 생성**합니다. 기존 비밀번호/MFA는 가져오지 않고 새 초대/비밀번호 설정을 수행합니다. auth→public 자동 가입 트리거는 업무 import 중 비활성 상태로 두어 profiles 중복과 감사 트리거 실행을 방지합니다. 계정 생성은 새 대상에서만 수행합니다.

선택 B: 새 시스템이 새 UUID를 발급하면 비공개 매핑표 `old_user_id,new_user_id`를 만듭니다. 중복/누락/다대일 충돌을 검사하고 다음을 **동일 규칙으로** 변환합니다.

- profiles의 PK, profiles 또는 auth.users를 참조하는 모든 FK, UUID 배열/JSON 값/감사 이력의 사용자 참조.
- catalog에 FK로 등록되지 않은 `created_by`, `updated_by`, `actor_id` 등 업무 의미상 사용자 필드.
- 사용자 UUID를 사용하는 Storage 경로와 해당 경로를 가리키는 업무 데이터. 바뀐 경로는 대상 업로드 때 반영하고 원본 manifest/파일은 보존합니다.

문자열 전체를 무차별 치환하지 말고 테이블·컬럼·JSON 경로별 변환 목록을 승인받아 적용합니다. 이름/이메일이 같다는 이유로 기존 계정의 업무 ID를 합치지 않습니다.

선택 C: 사내 SSO로 전환하여 auth.users가 없으면 대상 DB에 원본 UUID를 가진 업무 principal 테이블을 만들고 `profiles.id` FK와 인증 함수/RLS를 사내 principal로 연결합니다. 원본 auth FK 정의는 추적용으로 보관하되 대상에서 검증된 대체 FK로 설치합니다. 일반적인 빈 auth.users를 가짜 계정으로 채우거나 auth 스키마를 복원하는 방식은 사용하지 않습니다.

## 7. 별도 대상에서의 마이그레이션 순서

이 백업 도구는 운영/대상 DB에 자동 import하지 않습니다. DI 형식의 JSON은 `pg_restore` 입력이 아닙니다. 대상 사내 DB·SSO 구조가 정해진 다음 아래 절차를 대상 전용 import 프로그램/SQL로 적용합니다.

1. 원본과 분리한 빈 개발 대상과 전용 접속 정보를 준비합니다. 원본/운영 프로젝트에는 복호화된 SQL을 실행하지 않습니다. PostgreSQL 버전·확장·role·auth 함수 의존성을 확인합니다.
2. `public-schema.sql`을 검토하여 테이블/타입/시퀀스 등 사전 구조와 FK/인덱스/트리거/RLS 등 사후 구조를 나눕니다. 파일을 통째로 실행한 뒤 FK/트리거 오류를 무시하며 import하지 않습니다. public의 기존 schema 생성문/소유자 없는 role 권한도 대상에 맞게 검토합니다. public 밖의 Storage RLS와 가입 트리거는 별도 설정입니다.
3. 승인한 UUID 방식을 준비하고 **사전 구조만** 생성합니다. 앱 트리거, FK, 앱 사용자 접근은 아직 켜지 않습니다.
4. `public-data.json`의 각 테이블은 `columns` 순서와 `rows`의 위치가 대응합니다. SQL NULL은 JSON null, 문자열 `'null'`은 실제 text 값입니다. DB 드라이버의 **파라미터 바인딩**을 사용해 text 값을 PostgreSQL 타입으로 변환합니다. 식별자는 DB 드라이버의 identifier quoting을 사용하고 문자열 SQL 연결을 피합니다. 값이 이미 PostgreSQL text이므로 JS Number/parseFloat 변환을 하지 않습니다. JSON 숫자는 원문 text 그대로 전달합니다.
5. `generated` 컬럼은 INSERT에서 제외하여 대상에서 재계산합니다. identity는 필요하면 `OVERRIDING SYSTEM VALUE`로 원래 값을 보존합니다. `excludedColumns`는 INSERT에서 제외하고, NOT NULL/default/check가 인증 비밀값을 요구하면 대상 전용 외부 설정/nullable/구조 전환을 **명시적으로 설계**합니다. 원본 비밀정보를 다시 채워 넣지 않습니다. 유효한 대체 값이 없으면 마이그레이션을 실패 처리합니다.
6. 데이터 로드 후 catalog의 시퀀스/identity 값을 테이블의 실제 최대값과 백업 정보/증분 방향을 고려해 재설정합니다. 사후 인덱스·FK를 적용하고 미연결 사용자 UUID가 없는지 anti-join으로 검증합니다. `NOT VALID`로 생성했으면 반드시 `VALIDATE CONSTRAINT`까지 완료합니다. FK를 영구 삭제하거나 `session_replication_role=replica`로 무시한 채 운영하지 않습니다.
7. 대상 Storage API/사내 파일 서비스로 manifest의 버킷 설정을 재생성하고 `(bucket,name) → path`의 원본 바이트를 업로드합니다. MIME/메타데이터를 대상 API가 허용하는 방식으로 전달합니다. Supabase 관리 `storage.objects`에 직접 INSERT하지 않습니다. 읽기 전용/서버 생성 메타데이터(id/수정 시각)는 그대로 재현되지 않을 수 있으므로 원본 manifest를 추적 자료로 보존합니다. 대상에서 다운로드한 파일의 SHA-256을 모두 비교합니다.
8. 테이블별 행 수와 제외/변환 목록, UUID 연결, 관계 제약, RLS, role 권한을 비교합니다. 분할 테이블의 manifest count는 부모와 자식 조회를 모두 포함할 수 있으므로 각 relation을 동일한 방법으로 검증합니다. 업무 합계/금액/감사 이력도 확인합니다.
9. 대상의 인증 어댑터·앱 트리거·RLS·Storage 권한을 켜고 관리자/본사/공장별 조회·수정 권한, 사진/PDF, 승인/마감/신규 계정 플로를 테스트합니다. 검증이 끝난 후에만 별도 운영 전환 절차를 진행합니다.

DB/파일 전체 import는 단일 트랜잭션이 아닙니다. 중간 실패 대상은 공개하지 말고 원인을 해결한 뒤 다른 빈 대상으로 다시 시험합니다. 원본 DB와 기존 사이트는 변경하지 않습니다. 이메일/OAuth/SMTP/SSO/서버 비밀값은 대상에서 새로 설정합니다.

## 8. 개발 검증

```powershell
npx vitest run tests/backup-di.test.ts
# 아래 기존 테스트의 실행 파일 fixture는 Linux용이므로 Linux/WSL에서 실행
npx vitest run tests/backup-restore.test.ts
npm test
npm run build
# Linux/WSL + Docker에서 합성 DB만 사용하는 실제 pg_dump/snapshot 검증
node scripts/verify-di-postgres.mjs
```

합성 fixture로 DI 모드의 public-only 명령, 정책 검토·drift 차단, 비밀값 제외, 정밀도/UUID 보존, Storage 변경 감지, GCM/체크섬 실패, 복호화 시 덮어쓰기 방지, 전체 복원과의 형식 분리를 검증합니다. PGlite의 실제 PostgreSQL 카탈로그 SQL로 auth FK 추출과 text 값 조회도 검증합니다. CI의 Windows job은 DI 테스트를 실행하여 플랫폼 차이를 확인합니다. Linux job은 일회용 PostgreSQL 17 컨테이너에서 실제 pg_dump/snapshot/export/decrypt를 검증하고 컨테이너와 임시 파일을 정리합니다. Storage HTTP는 합성 fixture로 검증하며 실제 Supabase Storage와 대상 사내 DB 이식은 실행하지 않습니다. 운영 Supabase를 이용한 백업/복원 성공을 의미하지 않습니다.
