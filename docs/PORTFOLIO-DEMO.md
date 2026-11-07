# Публичное портфолио-демо

Разрешено пользователем 07.11.2026: отдельный общедоступный сайт с работающей **тестовой** записью. Настоящая клиника и реальные контакты не допускаются. Демо не является production-приёмкой основного проекта.

## Критерии

Сохранить существующий стек, транзакционное ядро и PostgreSQL exclusion constraints. Разместить отдельную пустую БД и применить всю историю через migrate deploy; не копировать локальные данные/аккаунты/ключи. Использовать только synthetic seed. Публичные контакты фиксированы: «Демо Посетитель», `+70000000000`; сервер отклоняет другие контакты до передачи ядру. Проверки CSRF, idempotency и конфликтов сохраняются. Staff API, вход сотрудников и выдача phone-consent закрыты публичным шлюзом. UI RU/KK сообщает о тестовом характере записи.

## Текущее размещение

Опубликовано 07.11.2026: [открыть демо](https://clinic-demo-portfolio-demo.up.railway.app/ru). Сайт работает на Railway независимо от компьютера разработчика.

- Project `alatau-clinic-demo`: `a6754b6c-0833-474f-bc30-132c7bd77fd1`.
- Environment `portfolio-demo`: `1d305382-20e8-4a16-9cd8-3833a0775d3d`.
- Приложение `clinic-demo`: `25a3c69a-8583-4010-9afb-749db860ef8b`.
- Postgres: `0ca9ffc5-5ee9-4d76-b260-12932ddba9ec`; БД `clinic_demo`. Публичный TCP proxy не создавался.
- Application deployment `09f46b88-22bf-4b54-86a0-13be90b35445`: SUCCESS; оба сервиса Online, pending work отсутствует.
- `/data`: отдельный volume `demo-secrets-and-ledger`, 500 MB; новый набор серверных ключей/паролей генерируется на сервере и сохраняется здесь. Локальная `.env`, аккаунт ADMIN и содержимое локальной БД не загружались.

## Реализация и обновление

`infra/Dockerfile.portfolio` собирает существующий monorepo с `VITE_PORTFOLIO_DEMO=true`. Это отдельный build flag, обычный локальный сайт и приём контактов в нём не переключаются в публичный демо-режим. Shared fixture contacts находятся в contracts. `infra/portfolio/entry.mjs` меняет владельца только `/data` и сбрасывает UID/GID до 1000 перед запуском приложения; root нужен исключительно для подготовки Railway volume. `start.mjs` применяет существующие bootstrap/migrate/grants, seed и расширяет synthetic расписание на 59 дней через существующий BookingService/doctor lock. Никакие применённые миграции не изменены.

Процесс HTTP использует существующий production API на loopback, runtime-роль БД и его startup-проверки. Публичный Express gateway разрешает каталог/расписание/CSRF/создание записи, проверяет фиксированные контакты, сохраняет Secure cookies и idempotency headers. Staff/auth, phone-consent и произвольные файлы недоступны. Демо не содержит активного staff аккаунта; публичный доступ к админке не выдавался.

Исходники передаются через Railway CLI после отдельного входа владельца. `node infra/portfolio/package.mjs` создаёт свежую allowlist-копию в `.deploy/portfolio-source-*`: без Git history, `.env`, `.deploy`, дампов, сгенерированных файлов и дизайн-референсов. Секретные значения не включаются в argv или вывод.

Проверенная команда загрузки (вместо SOURCE указать путь из package):

```powershell
.\.deploy\railway-cli\node_modules\.bin\railway.cmd up SOURCE --path-as-root --no-gitignore --project a6754b6c-0833-474f-bc30-132c7bd77fd1 --service 25a3c69a-8583-4010-9afb-749db860ef8b --environment 1d305382-20e8-4a16-9cd8-3833a0775d3d --detach --json
```

Конфигурация сервиса: Dockerfile `infra/Dockerfile.portfolio`, PORT8080, healthcheck `/api/v1/health/ready`, AUTH_ORIGIN равен публичному HTTPS origin, DATA_MODE=synthetic, DEMO_RELEASE=synthetic-portfolio. DEMO_BOOTSTRAP_URL — приватная Railway reference на Postgres.DATABASE_URL. Эти настройки уже применены. Повторная загрузка не создаёт новую БД и не меняет ключи. Не удалять/отсоединять volume с ключами: при потере исходного key state запуск существующей БД закрывается.

## Проверки 07.11.2026

- Typecheck PASS; npm test: **53/53**, включая два новых HTTP-теста границы демо. Targeted ESLint изменённых файлов, Prettier и git diff --check PASS.
- Полный `npm run lint` выявил существующее замечание `preserve-caught-error` в `infra/instance-lock.mjs:9`; оно не относится к демо и здесь не менялось. Полный lint не объявляется прошедшим.
- Railway Linux Docker build PASS; повторный deploy на тех же PG/volume SUCCESS; startup с полной историей миграций и production runtime checks прошёл.
- Внешние HTTPS GET: ready200, RU/KK200 с живым SSR/catalog-data, каталог200. `/admin`, staff API, auth/me, phone-consent, `.env` и исходник gateway возвращают404.
- Реальные действия в браузере: выбор услуги/врача/даты/времени, фиксированные read-only контакты, synthetic checkbox, отправка → **«Заявка принята»**. Создана только вымышленная запись.
- Внешний synthetic HTTP smoke: create201, идентичный replay200 с тем же результатом, новый ключ на занятый интервал409 SLOT_UNAVAILABLE, произвольные контакты400, неверный CSRF403. Занятый интервал исчезает из availability. CSRF cookie имеет Secure/HttpOnly, API no-store. Это smoke отдельного демо, без reset/drop/truncate и без обращения к локальной рабочей БД.
- Отдельная SSH-проверка UID не выполнялась: Railway CLI сообщил об отсутствии SSH key. Ключ SSH не создавался. Сброс привилегий реализован entrypoint; успешный запуск не выдаётся за независимую SSH-проверку UID.

## Ограничения

Платная подписка/домен не покупались. Доступность зависит от баланса и ограничений аккаунта Railway, постоянный бесплатный хостинг не гарантирован. Это synthetic demo, без заявлений о production SLA, независимых backup/checkpoint хранилищах или приёмке реальной клиники. Ledger/checkpoint находятся в разных каталогах одного демо-volume; это не независимая защита от потери носителя. Расписание пополняется при запуске, поэтому для длительной работы без перезапусков потребуется отдельное решение. Фактические технические и юридические production-блокеры основного проекта сохраняются.

Ранее зарезервированная запись Sites сохранена в игнорируемой `.deploy/portfolio-site/.openai/hosting.json`; она не содержит развёрнутой версии. Sites не запускает существующий Express/PostgreSQL и не используется для подмены ядра другой БД.
