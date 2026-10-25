# 데이터베이스·사진·PDF 백업과 복원

이번 작업에서는 실행 도구와 자동 실행 설정을 추가했습니다. 실제 Supabase 연결 설정, 자동 백업 활성화, 운영 데이터 백업 및 별도 서버 복원 시험은 사용자의 요청에 따라 나중에 진행합니다. 현재 백업이 실행 중이거나 복원 시험이 끝났다는 뜻은 아닙니다.

## 백업에 포함되는 내용

- PostgreSQL 전체 custom dump: 플랫폼 관리 스키마를 포함한 보관용 원본입니다.
- 앱의 `public` 스키마와 데이터: 스타일, 프로젝트, 사용자 권한, PO, 생산 차수, 확정 마감, 변경 이력 등 현재 존재하는 앱 테이블을 모두 포함합니다.
- 로그인 계정: `auth.users`, `auth.identities`, `auth.mfa_factors`. 비밀번호 해시와 MFA 비밀 정보도 암호화 백업에 포함되므로 백업 암호와 파일을 별도로 보관합니다.
- `auth.users`에 연결된 앱 가입 트리거와 Storage 버킷·객체 권한 정책.
- 모든 Storage 버킷의 사진·PDF 등 실제 파일 바이트, 파일 경로, MIME 유형, 버킷 설정.
- 파일별 SHA-256, 테이블별 행 수, 백업 시각, 원본 프로젝트 ID.

모든 DB dump는 하나의 PostgreSQL repeatable-read snapshot을 사용합니다. 같은 snapshot의 `storage.objects`·버킷 설정이 실제 Storage API 목록과 일치하는지 확인하고, 파일 다운로드 후에도 객체 ID·수정 시각·메타데이터가 같아야 성공합니다. DB와 Storage를 묶는 원자적 트랜잭션은 없으므로, 중요한 복구 시점의 백업은 파일 업로드·삭제를 멈춘 시간에 추가로 실행하세요. 파일이 도중에 바뀌면 성공으로 기록하지 않고 실패합니다.

백업은 AES-256-GCM으로 암호화하며 매번 다른 salt와 nonce를 사용합니다. 암호 없이는 복원할 수 없습니다. `.sha256`은 다운로드한 암호화 파일의 손상을 확인할 때 사용합니다. 백업 암호는 32자 이상이어야 하며, `openssl rand -base64 48`로 만든 무작위 값을 권장합니다.

## 나중에 자동 백업을 켜는 방법

GitHub 저장소의 **Settings → Secrets and variables → Actions**에서 다음 **Secrets**를 등록합니다. 이 값들은 브라우저 코드나 Vercel의 `VITE_*` 환경 변수에 넣지 않습니다.

| Secret | 값 |
| --- | --- |
| `SUPABASE_URL` | 운영 Supabase 기본 주소. `/rest/v1` 등을 붙이지 않습니다. |
| `SUPABASE_DB_URL` | 운영 DB의 비밀번호가 포함된 direct 연결 또는 session pooler 연결 주소 |
| `SUPABASE_SERVICE_ROLE_KEY` | 운영 프로젝트의 서버 전용 `service_role` 키 |
| `SIG_BACKUP_PASSPHRASE` | 별도로 보관할 무작위 백업 암호 |
| `SUPABASE_DB_CA_CERT` | 필요한 경우 Supabase에서 내려받은 DB 루트 인증서의 PEM 내용 |

DB 비밀번호에 `@`, `:`, `/` 등이 있으면 URL 인코딩합니다. transaction pooler의 `6543` 포트는 지원하지 않습니다. IPv6 direct 연결이 안 되면 session pooler의 `5432` 포트와 `postgres.프로젝트ID` 사용자 이름을 사용합니다. API 프로젝트와 DB 프로젝트가 다르면 백업을 중단합니다.

Actions의 **Variables**에 `SIG_BACKUP_ENABLED=true`를 등록하면 한국 시간 매일 오전 3시에 실행됩니다. 변수 미등록 시 정기 실행은 건너뜁니다. **Actions → Encrypted database and files backup → Run workflow**로 먼저 수동 실행하고 성공 여부를 확인하세요. 수동 실행에도 위 Secrets가 필요합니다.

성공한 실행의 Artifacts에서 `sig-backup-실행번호`를 내려받을 수 있습니다. 보관 기간은 31일이며, 기간이 지나면 GitHub가 삭제합니다. 월별 보관본은 암호화된 상태로 별도 보관소에 복사하세요. GitHub에 알림 이메일 수신을 설정해 실패한 workflow를 확인하고, 적어도 월 1회 최근 성공 백업과 별도 프로젝트 복원 시험을 확인하는 운영 담당자를 정합니다. 이 workflow가 별도 알림 서비스로 메시지를 발송하지는 않습니다.

기본 해제 크기 제한은 manifest와 중복 dump를 포함한 256 MiB입니다. 필요하면 Actions 변수 `SIG_BACKUP_MAX_BYTES`를 늘릴 수 있으며 최대 2 GiB입니다. 한 백업은 최대 100,000개 Storage 파일을 지원합니다. 메모리에 ZIP을 만들기 때문에 큰 데이터베이스에는 별도의 스트리밍 백업 도구와 장기 보관소가 필요합니다.

## 수동 실행

Node.js 22 이상과 원본 서버 버전 이상인 PostgreSQL client tools가 필요합니다. 자동 workflow는 PostgreSQL 17 client를 설치합니다. DB 서버가 18 이상이면 workflow의 client 버전도 함께 올리세요. TLS는 `verify-full`로 서버 인증서와 호스트 이름을 검증합니다. 인증서 검증이 실패하면 Supabase에서 DB 루트 인증서를 내려받아 `SUPABASE_DB_SSL_ROOT_CERT`에 파일 경로를 지정하세요. 인증서 검증을 끄는 방식은 지원하지 않습니다.

[.env.backup.example](../.env.backup.example)을 참고해 **저장소 바깥의 비공개 환경 설정 파일**을 만들고 접근 권한을 `600`으로 제한합니다. 환경 변수를 안전하게 주입한 뒤 실행합니다. 환경 파일을 읽을 때는 파일 내용이 신뢰할 수 있는지 확인하세요. 비밀값을 명령줄 인수나 채팅에 붙여 넣지 않습니다.

```bash
npm ci --ignore-scripts
node scripts/backup-workspace.mjs
```

결과에는 암호화 파일 경로, SHA-256, 테이블 수, Storage 파일 수만 출력됩니다. 평문 dump는 접근 권한이 제한된 임시 디렉터리에 생성했다가 정상 종료·오류 처리 시 삭제합니다. 실행 컴퓨터의 디스크 암호화를 사용하고, 강제 종료된 작업의 임시 파일은 운영 담당자가 정리하세요.

## 별도 프로젝트로 복원

**새 Supabase 프로젝트**를 준비합니다. 앱 SQL을 먼저 적용하거나 가입자를 만들거나 버킷을 만들지 않습니다. 기존 앱 테이블·함수·계정·버킷·파일이 하나라도 있는 대상은 복원 대상이 될 수 없습니다. 원본 프로젝트와 `SIG_PROTECTED_PROJECT_REFS`에 등록한 프로젝트로의 복원도 거부합니다. `SUPABASE_URL`이 설정되어 있다면 해당 현재 운영 프로젝트 역시 보호합니다.

환경 설정에 다음 값을 추가합니다.

| 환경 변수 | 값 |
| --- | --- |
| `TARGET_SUPABASE_URL` | **새 복원 시험 프로젝트**의 기본 주소 |
| `TARGET_SUPABASE_DB_URL` | 같은 복원 프로젝트의 DB 연결 주소 |
| `TARGET_SUPABASE_SERVICE_ROLE_KEY` | 같은 복원 프로젝트의 서버 키 |
| `TARGET_SUPABASE_DB_SSL_ROOT_CERT` | 필요한 경우 새 프로젝트의 DB 인증서 파일 경로 |
| `SIG_PROTECTED_PROJECT_REFS` | 추가로 보호할 운영 프로젝트 ID들을 쉼표로 구분 |
| `SIG_BACKUP_PASSPHRASE` | 백업 생성 시 사용한 원래 암호 |

먼저 검증만 수행합니다. `--confirm-target`에는 주소 전체가 아닌 **복원 시험 프로젝트 ID**를 직접 입력합니다.

```bash
node scripts/restore-workspace.mjs /secure/SIG-backup.sigbackup --confirm-target NEW_PROJECT_REF
```

이 단계는 암호 해제·모든 파일 체크섬·프로젝트 ID·대상 DB/Storage가 비었는지를 검사하며 데이터를 쓰지 않습니다. `mode: "dry-run"` 결과를 확인한 다음 같은 명령에 `--apply`를 붙여 실제 복원을 실행합니다.

```bash
node scripts/restore-workspace.mjs /secure/SIG-backup.sigbackup --confirm-target NEW_PROJECT_REF --apply
```

복원 순서는 앱 스키마의 pre-data → 로그인 계정 → 앱 데이터 → 앱 인덱스·FK·RLS·트리거 → 버킷과 실제 파일 → 가입 트리거·Storage 정책입니다. 기존 Supabase 관리 스키마 전체를 덮어쓰지 않습니다. 새 DB의 테이블별 행 수와 복원된 모든 Storage 파일의 바이트 체크섬을 확인한 뒤 성공 결과를 출력합니다. `db/full.dump`는 보관·전문가 복구용이며 이 명령으로 새 프로젝트의 관리 스키마에 강제로 덮어쓰지 않습니다.

복원은 DB와 Storage 전체에 걸친 단일 트랜잭션이 아닙니다. 중간에 실패하면 대상에 일부 데이터가 남을 수 있습니다. 그런 대상은 사용자에게 공개하지 말고, 실패 원인을 고친 뒤 **다른 새 빈 프로젝트**에서 다시 시험합니다. 자동으로 원본 데이터를 지우거나 불완전한 복원 대상을 운영으로 전환하지 않습니다.

복원 후 시험용 앱 배포를 새 프로젝트에 연결하고 관리자·본사·A공장·B공장 계정으로 로그인, 공장별 조회 범위, 사진/PDF 열람, 과거 확정 마감, 신규 가입·승인을 확인하세요. 운영 URL 전환은 이 시험이 끝난 뒤 별도로 결정합니다.

## 별도로 설정해야 하는 항목

Supabase의 Auth 이메일 인증 여부·URL 허용 목록·SMTP·OAuth 제공자 키·JWT 서명 키, Edge Function 배포/서버 비밀값, Vercel의 배포 설정·환경 변수·도메인, GitHub Secrets는 이 백업으로 자동 복원되지 않습니다. 새 프로젝트에 운영 설정을 다시 적용해야 합니다. 기존 로그인 세션·refresh token은 이식하지 않으므로 팀원은 다시 로그인합니다. 사용자 비밀번호를 평문으로 추출하거나 재설정하지 않습니다.

원본과 복원 프로젝트의 PostgreSQL·Supabase Auth/Storage 스키마 버전과 필요한 확장이 호환되어야 합니다. 버전 차이로 import가 실패하면 오류를 무시하고 진행하지 않습니다.

## 현재 검증 범위

로컬 테스트는 실제 암호화·인증 태그·파일 체크섬·ZIP 경로 검사·프로젝트 보호를 실행합니다. PGlite의 PostgreSQL 카탈로그에서 가입 트리거·Storage 정책을 추출해 다른 격리 DB에 다시 적용하는 SQL 시험도 포함합니다. 별도로 격리한 가짜 PostgreSQL client/Storage 응답으로 snapshot 인수·복원 순서·dry-run·파일 재업로드·실패 처리 흐름을 검증합니다. 이 테스트는 실제 PostgreSQL dump/restore나 운영 Supabase 복원 성공을 대신하지 않습니다. 실제 서버 연결과 복원 시험은 아직 실행하지 않았습니다.
