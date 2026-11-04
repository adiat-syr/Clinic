# Результат этапа 1

Дата: 04.11.2026. **Техническая основа выполнена; работа остановлена до подтверждения этапа 2.**

## Что готово

- Сопоставлены все HTML/PNG и DESIGN Stitch с исходной архитектурой. Ошибки, недостающие экраны, приоритеты токенов и план интеграции записаны в `DESIGN-INTEGRATION.md`.
- Создан npm-монорепозиторий: React/Vite/TypeScript, Express/TypeScript и общий пакет валидируемых DTO. Общие схемы не зависят от БД или секретов.
- Стартовая web-страница использует палитру/токены Stitch, локальные Inter/Plus Jakarta Sans и реальный запрос health через API proxy. Она явно сообщает, что запись недоступна, и не собирает контакты.
- API имеет liveness/readiness, request ID, безопасный формат ошибок, no-store, security headers, лимит JSON и проверку окружения. Есть shutdown и закрытие пула; доменных endpoints нет.
- PostgreSQL 18.6 запущен в отдельном Compose-проекте на `127.0.0.1:55432`, с собственным volume и случайным локальным паролем. Образ закреплён digest. Другие проекты/контейнеры не менялись.
- Prisma CLI/client/adapter зафиксированы одной стабильной версией, конфигурация и модель-независимая schema валидны. Readiness пока использует `pg`; подключение Prisma repositories следует за доменными моделями этапа 2.
- Добавлены strict TypeScript, ESLint, Prettier, Vitest, npm-команды, безопасный setup окружения и базовый GitHub Actions workflow.

## Архитектурные решения

1. **Модульный монолит в одном workspace:** web/API могут развиваться отдельно, контракты и инструменты проверяются совместно. Не добавлены микросервисы, брокеры и облачные зависимости.
2. **Stitch — источник визуального языка:** оригиналы не импортируются и не исполняются приложением. Будущие карточки/прайс/booking/admin получают данные из одного PostgreSQL/API, а не из JS-демо.
3. **Same-origin и проверка границ:** относительный `/api/v1`, development proxy, schema parsing ответов, безопасные ошибки. Авторизация/RBAC остаются отдельным этапом; отсутствие auth пока не маскируется декоративной формой входа.
4. **Без фиктивной БД:** schema без моделей, нет миграций/seed и нет CREATE ради демонстрации. Защита бронирования будет добавлена и проверена на настоящем PostgreSQL на этапах 2/4.
5. **Синтетическое окружение:** поддерживается только DATA_MODE=synthetic; реквизиты/телефоны/лицензия/имена из макетов не объявлены реальными данными клиники. Production и внешние каналы не подключены.

## Проверки

| Проверка                   | Фактический результат                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `npm ci`                   | Чистая установка по lockfile успешна; 420 установленных пакетов, audit 0                 |
| `npm run lint`             | Успешно, 0 предупреждений                                                                |
| `npm run typecheck`        | Все workspace, тесты API, Vite/Prisma и root Vitest configs — успешно                    |
| `npm test`                 | 15/15: окружение и HTTP, ошибки/лимит JSON/503/request ID/отсутствие ложного booking     |
| `npm run db:validate`      | Prisma schema валидна, доменных моделей нет                                              |
| `npm run db:check`         | PostgreSQL 18.6 доступен, btree_gist присутствует в available extensions                 |
| `npm run test:integration` | 1/1 на реальном PostgreSQL                                                               |
| `npm run smoke`            | Build + временный compiled API + Vite + proxy + DB readiness — успешно                   |
| `npm run build`            | contracts/API/web собираются, предупреждения о размере chunk отсутствуют                 |
| Фактический `npm run dev`  | Три watch-процесса запущены; `/`, `/src/main.tsx`, live/ready через proxy возвращают 200 |
| Завершение проверки dev    | Временные web/API остановлены; порты 3001/5173 больше не обслуживаются                   |
| Compose config             | Итоговая конфигурация валидна; отдельный контейнер healthy                               |
| Отсутствие этапа 2         | SELECT количества public tables возвращает 0; нет миграций и seed                        |
| Сохранность Stitch         | Все 13 извлечённых файлов побайтово равны ZIP; архив сохранён                            |
| Setup повторно             | Существующий `.env` сохранён без перезаписи значений                                     |

`format:check` выполняется после последнего обновления отчёта. Проверки на loopback выполнялись с необходимым доступом к локальной сети, без замены PostgreSQL моками. В HTTP-тестах отказ БД отдельно моделируется как зависимость, а реальное соединение покрыто integration/smoke.

Исправлены найденная тестом обработка некорректного DATABASE_URL и зависимость minimatch с известной уязвимостью; сообщения конфигурации не включают значения секретов. Shared browser-контракт использует Zod Mini, при этом проверка ответа остаётся настоящей. Полный security audit, гонки бронирования, auth и визуальное сравнение готовых страниц ещё не проводились: эти функции не входят в текущий этап.

GitHub Actions подготовлен и соответствует локальным командам; удалённый CI не запускался, Git-репозиторий/remote здесь не создавались. Результат не является готовым коммерческим сайтом или подтверждением юридического соответствия.

## Изменённые исходные файлы

```text
README.md
AGENTS.md
TASKS.md
```

## Новые файлы основы

```text
.editorconfig
.env.example
.github/workflows/ci.yml
.gitignore
.node-version
.npmrc
.prettierignore
.prettierrc.json
eslint.config.js
package.json
package-lock.json
tsconfig.base.json
tsconfig.json
vitest.config.ts
vitest.integration.config.ts
scripts/setup.mjs
scripts/smoke.mjs
infra/compose.yaml
docs/DESIGN-INTEGRATION.md
docs/FOUNDATION.md
docs/STAGE-1-REPORT.md
packages/contracts/package.json
packages/contracts/tsconfig.json
packages/contracts/src/index.ts
apps/api/package.json
apps/api/tsconfig.json
apps/api/tsconfig.check.json
apps/api/prisma.config.ts
apps/api/prisma/schema.prisma
apps/api/scripts/check-database.ts
apps/api/src/app.ts
apps/api/src/server.ts
apps/api/src/config/env.ts
apps/api/src/infrastructure/database.ts
apps/api/src/middleware/errors.ts
apps/api/tests/config.test.ts
apps/api/tests/http.test.ts
apps/api/tests/database.integration.test.ts
apps/web/package.json
apps/web/tsconfig.json
apps/web/vite.config.ts
apps/web/index.html
apps/web/public/favicon.svg
apps/web/public/robots.txt
apps/web/public/fonts/Inter-LICENSE.txt
apps/web/public/fonts/Plus-Jakarta-Sans-LICENSE.txt
apps/web/src/main.tsx
apps/web/src/api/health.ts
apps/web/src/app/App.tsx
apps/web/src/app/App.module.css
apps/web/src/styles/tokens.css
apps/web/src/styles/global.css
```

Дополнительно извлечены 13 оригиналов в `design-reference/stitch_premium_medical_clinic_portal/`: `code.html` и `screen.png` для `alatau_clinic_mvp_1`…`alatau_clinic_mvp_5` и `mvp`, а также `alatau_clinical_sanctuary/DESIGN.md`. Исходный ZIP не изменён; SHA-256: `dd8bb38e596df4beb8518c499591bd4ab5420ba64284101b3965692f4948ed97`.

Локальные `.env`, `node_modules` и `dist` — игнорируемые артефакты, не исходные файлы. Секреты в отчёт не включены.

## Следующая граница

Требуется подтверждение этапа 2: доменные модели, миграции, ограничения календаря и синтетический каталог. Не начинать авторизацию, booking API, public/admin экраны и публикацию автоматически. До real data остаются отдельные согласования реквизитов, каталога, согласия, сроков хранения и инфраструктуры Казахстана из TASKS.
