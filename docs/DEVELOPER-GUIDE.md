# Карта проекта для разработчика

Начать с README.md, AGENTS.md, TASKS.md и STAGE-7-REPORT.md. Старые отчёты — исторические снимки. Контракты — BOOKING-API.md/openapi.json, доступ — AUTH.md, БД — DATABASE.md, UI — DESIGN-INTEGRATION.md и оригиналы `design-reference/stitch_premium_medical_clinic_portal/`. Эксплуатация — DEPLOYMENT.md/OPERATIONS.md. Все юридические вопросы только LEGAL-REVIEW-REQUIRED.md.

| Задача               | Файлы/слой                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Команды/инструменты  | root package.json, workspaces, tsconfig*, eslint.config.js, .npmrc, .github/workflows/ci.yml                                                                          |
| API config/start     | apps/api/src/config/{env,secrets,clinic}.ts, server.ts, app.ts, infrastructure/{prisma,runtime-check}.ts                                                              |
| Booking/availability | apps/api/src/modules/booking/service.ts (ядро), repository.ts, transaction.ts, catalog-mutations.ts; HTTP DTO/crypto в http-service.ts/privacy.ts; routes в router.ts |
| Auth/MFA/RBAC        | apps/api/src/modules/security/service.ts, staff.ts, crypto.ts, config.ts, rate-limit.ts, router.ts; audit.ts/repository.ts — metadata allowlist/запись audit          |
| Каталог              | apps/api/src/modules/catalog/{schemas,service}.ts; admin routes в security/router.ts                                                                                  |
| Public SSR           | apps/api/src/modules/site/service.ts, apps/web/src/entry-server.tsx; только publicDTO, TTL2сек/coalescing, invalidation после успешных catalog mutations              |
| БД                   | apps/api/prisma/schema.prisma, prisma/migrations/**/migration.sql; ручные exclusions/triggers сохранять                                                               |
| CLI                  | apps/api/scripts/staff.ts/staff-input.ts, consent.ts; root staff:*; infra/ops/cli.mjs для контейнеров                                                                 |
| Public UI            | apps/web/src/app/{App,i18n,site.css}, features/{Booking,PatientConsent}, api/clinic.ts, styles/{tokens,global}.css                                                    |
| Staff UI             | apps/web/src/admin/Entry.tsx/Admin.tsx, Catalog/Staff/Appointments/Schedule/Audit, api.ts, i18n.ts; отдельный приватный cache                                         |
| Build/SEO            | apps/web/vite.config.ts, scripts/prerender.mjs/check-build.mjs; production React client и live publicSSR                                                              |
| Ops                  | infra/Dockerfile*, compose.production/staging.yaml, Caddyfile*, prepare/deploy.mjs; infra/ops/*.mjs — роли, backup/restore, ledger, cleanup, rotation, monitor        |
| Тесты                | apps/api/tests (unit/PG), apps/web/src/**/*.test.ts, tests/web и tests/https (Playwright), infra/tests (Linux roles/restore/TTY/crypto)                               |

Изменение поведения сначала описать в TASKS/контракте: DTO, доступ, audit, conflict/idempotency. Внешние значения unknown+Zod, Prisma-модель клиенту не возвращать. Public/admin schemas отдельны, поля allowlist. Контакты шифруются сервером, цены/длительность/end вычисляются core. Request bodies/headers/ошибки PG не логировать.

Защищённая мутация: `AuthService.withSession` → staff/session locks → `core.inTransaction(tx,actor,requestId)` без независимой вложенной транзакции. При создании idempotency advisory до doctor→service→consent/appointment. Расписание/catalog-mutations координируются теми же doctor/service locks. Appointment edit с version/409. Exclusion constraint БД остаётся последней защитой независимо от SELECT.

Новая миграция только append. Runner применяет всю историю с нуля, повторный deploy и catalog assertions. Не выполнять reset/drop/truncate рабочей DATABASE_URL. Тесты создают только собственные clinic_test32hex; штатная БД — migrate deploy. Новые таблицы/колонки требуют минимальных GRANT в infra/ops/database.mjs и негативного privilege test.

UI-текст добавлять RU/KK с проверкой полноты, accessible label и loading/empty/error/409. Чувствительные формы только memory, querystring только безопасные filters/lang. Не включать tokens/PII в localStorage/URLs/скриншоты. Даты через IANA clinic zone; не фиксировать +05 и не брать зону ОС. Деньги API — decimal-string KZT.

После локального setup/PG:

```sh
npm run lint
npm run typecheck
npm run format:check
npm run openapi:check
npm run db:validate
npm test
npm run test:ops:unit
npm run test:integration
npm run test:web
npm run smoke
npm audit --audit-level=high
```

`test:web` и smoke включают production build — не повторять одинаковые полные сборки без причины. После контрактов `npm run openapi:generate`. Root scripts генерируют Prisma. Artifact guard проверяет отсутствие jsx-dev-runtime. `SEO_REQUIRED=true` запрещает пустой DB snapshot. Docker build к БД не подключается; deploy assets job строит строгий public snapshot, liveSSR читает реальный каталог.

Ops/HTTPS: подготовить synthetic staging по DEPLOYMENT.md, затем `node infra/test-ops.mjs INSTANCE`, `node infra/test-https.mjs INSTANCE`. Второй временно переключает только staging API на свою fixtureDB и в finally возвращает URL. Sandbox может блокировать loopback/Docker (`EACCES`); нужны разрешённые локальные соединения, защита приложения не отключается.

Перед commit: git diff --check, отсутствие env/secrets/dumps, фактические результаты в отчёте и чистое дерево после commit. `.deploy`, `.tmp`, rawSAST/скриншоты, node_modules/dist/generated не добавлять в Git. Не менять старые миграции/Stitch. Remote CI не считать прошедшим без фактического запуска.
