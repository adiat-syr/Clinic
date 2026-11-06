# Этап 7 — техническое завершение

Дата: 06–07.11.2026, Asia/Qyzylorda. Работа на `codex/stage-7`, исходная база этапа6 `e0424ec`; незакоммиченные ранее дополнения MVP/CLI сохранены отдельно в `04becdb2b53b` до изменений этапа7. Существующие функции/дизайн/миграции не откатывались. Использовались только synthetic данные. **Настоящий production-релиз не выполнялся, реальные пациенты не подключены.**

## Что реализовано

Сохранён модульный React/Vite/Express/TypeScript/PostgreSQL18.6/Prisma7.10.1 монорепозиторий. Публичные RU/KK главная, услуги/цены/detail, специалисты/detail, контакты/privacy, онлайн-запись с PENDING и дополнительное самостоятельное согласие с кодом работают через реальные API. Staff UI: обе роли с MFA, пароль/logout/отзыв sessions, расписание/календарь, подтверждение/перенос/отмена/COMPLETED/NO_SHOW, catalog/staff/audit по правам, consent withdrawal и staffcreate по коду. Новых CRM/оплат/МИС/личного кабинета/SMS нет. Просмотр/перенос/отмена посетителем остаются через регистратуру, как утверждено MVP: публичного unsafe bypass staff API не добавлено.

- Production/staging multi-stage Docker, pinned images, privatePG/закрытый API, Caddy TLS/redirect/security headers, restricted mounts/capabilities/nonroot runtime, pool/resource limits, readiness/graceful shutdown. Secrets генерируются отдельно и монтируются *_FILE, не передаются в web bundle.
- Разделены bootstrap/migrator/runtime/operator/maintenance/backup роли. Startup отказывается при опасной runtime конфигурации/другой PG версии/потере exclusions. Семь отрицательных realPG проверок дополняют обычные integration tests владельца DB.
- Конфигурация отдельного экземпляра: бренд/локальный logo/контакты/часы/лицензия/privacy/IANA зона, данные каталога вPG, immutable документы CLI. Synthetic default, явная clinic activation/hash документа. До catalogueReviewed возможна настройка админки с пустым каталогом, но все три пути создания закрыты сервером. Phone consent отдельно gated; обычная online остаётся основной.
- Versioned MFA/contact/backup/ledger keyrings, retained legacy support, идемпотентная ротация. GCM требует16byte tag; доступ после ротации фактора отзывается.
- Policy-based cleanup/удаление контактов, approved-defaultfalse. Withdrawal/erasure intent шифруется, fsync записывается в отдельный signed registry/checkpoint; SQL failure не теряет подтверждённое требование, replay идемпотентен. Cursor подписывает DBname/OID и не переносится между DB.
- Автоматический consistent-snapshot pg_dump18 backup, две зашифрованные копии, SHA/MAC manifest, настраиваемая rotation. Restore в новую закрытуюDB, проверка полного архива до pg_restore, integrity/constraints, latest privacy replay и quarantine старых staff credentials. Finalize fences source и снова replay перед CONNECT target.
- Self-hosted monitor API/PG/TLS/certdays/backup/ledger/privacy replay/PENDING/auth, безопасные агрегаты/status/exit2, scheduler heartbeat и systemd templates. Подготовлены first setup/up/migrate/update/rollback/restore/diagnose команды и runbooks.
- Live publicSSR использует только publicDTO, короткий coalesced cache и invalidation после catalog mutation, rate/concurrency caps. Архивированный slug даёт404 без старых HTML. Исправлена локальная сборка React, которая могла подхватить development NODE_ENV из root.env; artifact guard исключает jsx-dev-runtime. Main JS243.83KB/gzip76.18KB, отдельные catalog60.70KB/admin70.58KB chunks. Шрифты локальные.
- Даты staff UI привязаны к IANA зоны клиники, включая исторический offset/отличающиеся зоны. Брендинг/profile вместо жёстких демо-реквизитов. При реальном browser review поправлены mobile footer spacing/44px targets и RU/KK skip-link. Stitch оригиналы не менялись.

## Исправленные проблемы

| Проблема                                                                    | Исправление/доказательство                                                                                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Повторное получение соединения внутри authTX (booking pre-read/MFA limiter) | Используется текущий TX; pool_size1 regression tests наPG.                                                                                                      |
| Audit descriptor email отображался как ошибка                               | Безопасное имя поля разрешено metadata schema; значениеemail не логируется.                                                                                     |
| Короткие GCM tags/неполная envelope validation                              | Явный tag16/minlength и negative crypto test.                                                                                                                   |
| Неаутентифицированный archive manifest/недостаточно свежий privacy ledger   | MAC manifest, authenticated prefix/checkpoint/entries, independent copy reconciliation, fail-closed restore negatives.                                          |
| Потеря последующего отзыва при старом backup/SQL rollback                   | Durable approved withdrawal intent до commit, maintenance/restore replay, контакты не стираются только из факта отзыва.                                         |
| Перенос signed privacy cursor между БД                                      | Signed identity+actual PGname/OID comparison; realDB cursor transplant negative.                                                                                |
| Старые sessions/уволенные credentials после restore                         | Все staff credentials quarantined и sessions удалены до открытияDB.                                                                                             |
| Неограниченный дорогой SSR/stale public HTML                                | Max4 render, separateIPquota, coalescing/TTL/invalidation, negatives120→429, readiness доступен.                                                                |
| Неидемпотентный повторный publicCA export                                   | Новый собственный inode с chmod/chown до atomic rename, повторные up/update прошли. Приватный ключ CA не экспортируется.                                        |
| Параллельный deployment и HTTPS fixture                                     | Во время собственной проверки возник Compose conflict; добавлен instance operation.lock и negative concurrency test. Повторный update проведён последовательно. |
| E2E network test зависел от UTC/clinic date и initialfetch                  | Явное ожидание initial result + refresh после abort handler; точечный test прошёл. Backend/UI защита не ослаблялась.                                            |

Независимый read-only review: STAGE-7-SECURITY-REVIEW.md. В рассмотренных путях открытых подтверждённых Critical/High после исправлений не осталось; это ограниченный вывод по коду/проверкам, не сертификат отсутствия всех уязвимостей. SAST/dependency coverage/triage — STAGE-7-SCANS.md.

## Фактические проверки

| Команда/сценарий                                        | Результат                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm ci                                                  | Два успешных clean installs; первоначальный Windows EPERM при работающем Vite устранён остановкой только процессов этого checkout. 431installed/435audited,0knownadvisories.                                                                                                                                                                         |
| npm audit --audit-level=high                            | 0 vulnerabilities; отдельный supply-chain обзор root/workspaces/lock tree, ограничения metadata названы в SCANS.                                                                                                                                                                                                                                     |
| npm run lint / typecheck / format:check / openapi:check | Успешны; после последних изменений управляющих скриптов также точечный ESLint. Финальные format/diff checks выполняются перед commit.                                                                                                                                                                                                                |
| npm run db:validate / db:deploy / db:check              | Schema valid, append-only миграция5 применена через migrate deploy к local dev без reset; PG18.6/btree_gist доступны.                                                                                                                                                                                                                                |
| npm test                                                | **51/51**,8files. Первый sandbox run получил loopback EACCES; повтор с локальным networking прошёл, код auth не отключался.                                                                                                                                                                                                                          |
| npm run test:integration                                | **87/87**,4files,85.04s. Все5миграций с нуля/повторный deploy, каталоги constraints, core races20, SQLSTATE23P01, differentduration/adjacency/breaks/workhours, atomicmove/cancel/idempotency/rollback, auth/MFA/replay/expiry/revocation/RBAC/CSRF/strictfields/publicsecrets, phoneTTL/version/consume/races и stage7 regressions. СвояDB удалена. |
| npm run test:ops:unit                                   | **6/6**: GCM corruption, manifest binding, registry/checkpoint/rotation/tamper, deployment isolation/policy/rollback protocol.                                                                                                                                                                                                                       |
| npm run test:web                                        | Все26сценариев проверены:25успешны в общем прогоне и1 исправленный network test успешно отдельно. Исходный полный прогон25/26 не назван26/26 одним запуском. Собственные fixtureDB удалены.                                                                                                                                                          |
| Production Linux Docker builds                          | API/web/operator/tools/testtools собраны. Последние UI изменения отдельно API/web пересобраны и проверены через HTTPS. Images не опубликованы.                                                                                                                                                                                                       |
| infra/test-ops.mjs stage7                               | **34 restore assertions +7 negative grants**, contact5/MFA1rekey и повтор0/0, реальная Linux privateTTY credentials без эха/сохранение роли; actual encrypted dump+secondcopy/MAC/corruption/keyring/restore/cutover/privacy replay/cursor transplant. PG logs не содержат synthetic negativeemail marker. OwnedDB удалены.                          |
| infra/test-https.mjs stage7                             | **4/4** реальных browsertests: headers/currentcatalog404, onlinePENDING/consent, mobileKK/keyboard, secureMFAcookie/CSRF/logout + live archive/reactivate и storedXSS/SQLi negatives. Node проверил chain/hostname/redirect до browser exception толькоlocalinternalCA.                                                                              |
| Synthetic HTTPS read load                               | 40requests,4workers, p95 **26ms**,max27ms,total212ms,HTTP200. 20publicSSR+20readiness. Малый локальный smoke, не production SLO/capacity proof.                                                                                                                                                                                                      |
| npm run smoke                                           | Productionbuild+compiledAPI/Vite/proxy/PGready/publiccatalog/admin401/assets PASS. Prerender24publicroutes изPGpublicDTO, безcontacts.                                                                                                                                                                                                               |
| Staging up/update                                       | Все4longrunning containers healthy, повторныйCAexport PASS; update создаёт encrypted backup перед migrate/grants и проходит readiness. Demo каталог seeded тольковownstaging, без общего staffpassword.                                                                                                                                              |
| Staging monitor                                         | operational_healthy,alerts[],pending0,auth_failures0,certificateDays finite0.436 на момент проверки. Не NaN/ложныйgreen.                                                                                                                                                                                                                             |
| Rollback smoke                                          | Фиксированные проверенные API/web imageIDs, privacyprotocol2, assets publication и healthy. Это проверка команды на той же версии; межверсионный rollback будущих migrations требует release acceptance. DowngradeDB не делался.                                                                                                                     |
| Semgrep                                                 | Initial13successful/2unavailablepacks, delta13/0failed, final3/0failed; финальный secrets0/nodejs0 и1 известный reviewed escapedSSR warning. OSS, не Pro.                                                                                                                                                                                            |

Desktop1440/mobile390 скриншоты просмотрены визуально; browser suite дополнительно проверяет tablet/desktop overflow, staffmobilecalendar, dialogs/errors/перенос/конфликт/permissions. После footer fix новые HTTPS скриншоты повторно проверены. Скриншоты synthetic, приватные rawfixtures/credentials не добавлены вGit.

## Эксплуатационные и непроверенные границы

Реальный Linux-хост, публичный домен/ACME renewal, география/независимость storage, hardware/secret escrow, physicalAuthenticator/персонал, remoteCI, deliveryalert и productionload/RPO/RTO не могут быть подтверждены ноутбуком. Systemd templates подготовлены, но не запускались на Windows. Полный Git-history secrets scan/CodeQL/Pro cross-file и аудит исходников всех thirdparty packages не выполнялись; фактическое покрытие SCANS явно ограничено.

Поддержан restore в новуюDB; physical snapshot rollback с тем же name/OID требует контролируемого cursor reset/epoch (не автоматически). MAC не обнаруживает одновременный rollback всех доверенных ledger/checkpoint копий; требуется независимый recovery anchor. После аварии stale file locks снимаются только после проверки отсутствия операций. Сбой cutover после finalized receipt и доGRANT оставляет target закрытым; безопасный runbook — новый restoretarget с latest replay, не ручной blindGRANT. Старые keys сохраняются для старых backups/entries. Никакие существующие базы/тома не удалялись.

Удаление contacts не объявляется полной необратимой анонимизацией всей bookinghistory; terminal records/consent/audit/identifiers остаются под контролируемой политикой. Retention по умолчанию выключен. Все правовые неопределённости, официальные источники и пределы проверки действующих редакций находятся **только в LEGAL-REVIEW-REQUIRED.md**. Техническая реализация не означает юридическую сертификацию/допуск настоящих пациентов.

Runbooks: DEPLOYMENT.md, OPERATIONS.md; карта разработчика DEVELOPER-GUIDE.md; staff ADMIN-GUIDE.md; внешняя приёмка STAGE-7-BLOCKERS.md. Этап7 заканчивается этой технической реализацией и фиксацией результата; настоящий production требует отдельного разрешения.

## Изменённые файлы

Полный список относительно сохранённой базы `04becdb` приводится ниже; raw artifacts/.env/.deploy/generated/dist исключены. Финальный commit включает этот отчёт.

```text
.dockerignore
.env.example
.github/workflows/ci.yml
.gitignore
.npmrc
.prettierignore
AGENTS.md
README.md
TASKS.md
apps/api/prisma.config.ts
apps/api/prisma/migrations/20261106000100_maintenance_rotation/migration.sql
apps/api/scripts/consent.ts
apps/api/scripts/openapi.ts
apps/api/scripts/staff.ts
apps/api/src/app.ts
apps/api/src/config/clinic.ts
apps/api/src/config/env.ts
apps/api/src/config/secrets.ts
apps/api/src/infrastructure/prisma.ts
apps/api/src/infrastructure/runtime-check.ts
apps/api/src/modules/booking/http-service.ts
apps/api/src/modules/booking/privacy.ts
apps/api/src/modules/booking/router.ts
apps/api/src/modules/booking/service.ts
apps/api/src/modules/security/audit.ts
apps/api/src/modules/security/config.ts
apps/api/src/modules/security/crypto.ts
apps/api/src/modules/security/rate-limit.ts
apps/api/src/modules/security/router.ts
apps/api/src/modules/security/service.ts
apps/api/src/modules/site/service.ts
apps/api/src/server.ts
apps/api/tests/booking-http.integration.test.ts
apps/api/tests/http.test.ts
apps/api/tests/security.integration.test.ts
apps/api/tests/stage7-config.test.ts
apps/web/package.json
apps/web/scripts/check-build.mjs
apps/web/scripts/prerender.mjs
apps/web/src/admin/Admin.tsx
apps/web/src/admin/Appointments.tsx
apps/web/src/admin/Entry.tsx
apps/web/src/admin/Schedule.tsx
apps/web/src/admin/api.ts
apps/web/src/admin/i18n.ts
apps/web/src/admin/timezone.test.ts
apps/web/src/api/clinic.ts
apps/web/src/app/App.tsx
apps/web/src/app/StaffEntry.tsx
apps/web/src/app/i18n.ts
apps/web/src/app/site.css
apps/web/src/entry-server.tsx
apps/web/src/features/Booking.tsx
apps/web/src/features/PatientConsent.tsx
apps/web/src/main.tsx
apps/web/vite.config.ts
docs/ADMIN-GUIDE.md
docs/AUTH.md
docs/BOOKING-API.md
docs/DATABASE.md
docs/DEPLOYMENT.md
docs/DEVELOPER-GUIDE.md
docs/LEGAL-REVIEW-REQUIRED.md
docs/OPERATIONS.md
docs/STAGE-7-BLOCKERS.md
docs/STAGE-7-REPORT.md
docs/STAGE-7-SCANS.md
docs/STAGE-7-SECURITY-REVIEW.md
docs/STAGE-7-WORKLOG.md
docs/openapi.json
eslint.config.js
infra/Caddyfile
infra/Caddyfile.site
infra/Caddyfile.staging
infra/Dockerfile
infra/Dockerfile.tools
infra/clinic.demo.json
infra/compose.production.yaml
infra/compose.staging.yaml
infra/deploy.mjs
infra/deployment-policy.mjs
infra/instance-lock.mjs
infra/ops/asset-permissions.mjs
infra/ops/assets.mjs
infra/ops/backup-keys.mjs
infra/ops/backup.mjs
infra/ops/cli.mjs
infra/ops/database.mjs
infra/ops/export-ca.mjs
infra/ops/ledger-keys.mjs
infra/ops/ledger.mjs
infra/ops/lib.mjs
infra/ops/maintenance.mjs
infra/ops/monitor.mjs
infra/ops/reconcile-privacy.mjs
infra/ops/rotation.mjs
infra/ops/withdrawal.mjs
infra/prepare.mjs
infra/systemd/clinic-monitor@.service
infra/systemd/clinic-monitor@.timer
infra/test-https.mjs
infra/test-ops.mjs
infra/tests/crypto-ledger.test.mjs
infra/tests/deployment-policy.test.mjs
infra/tests/ops-cleanup.mjs
infra/tests/ops-fixture.mjs
infra/tests/ops-restore.mjs
infra/tests/ops-tty.mjs
package.json
packages/contracts/src/index.ts
playwright.https.config.ts
tests/https/product.spec.ts
tests/web/admin.spec.ts
tsconfig.json
```
