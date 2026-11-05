# Авторизация и каталог — этап 3

Разрешены auth/MFA/RBAC, catalogue/staff/audit API, CLI первого ADMIN и восстановления credentials. UI и booking/schedule HTTP API не входят в этап.

## Принятые решения

- Argon2id через node-argon2: 64 MiB, timeCost 3, parallelism 1. Случайный cookie token 32 bytes; в БД только SHA-256. CHALLENGE 5 минут; после TOTP SHA-1/6 digits/30 seconds через OTPAuth — новый token, срок 8 часов и idle 30 минут. MFA для обеих ролей. Счётчик TOTP принимается один раз под блокировкой сотрудника.
- Secure/__Host-/HttpOnly/SameSite=Lax/Path=/ на HTTPS; plain HTTP допускается только для local development/test с отдельным cookie name. Ключи без стандартных значений, MFA secret зашифрован AES-GCM с привязкой к staff id.
- HMAC CSRF привязан к HttpOnly nonce и текущей сессии. Origin обязателен для мутаций, включая login. После token rotation нужно заново получить CSRF. CORS не открывается.
- Проверка текущей роли/сессии и admin-мутация — одна транзакция. Порядок: staff-management advisory lock при управлении сотрудниками → staff UUID → session → doctor → service. Каталог использует общий протокол блокировок этапа 2.
- Дополнительные bootstrap marker и PostgreSQL rate-limit buckets обеспечивают одноразовый ADMIN и общие лимиты нескольких процессов. DB-триггер отзывает сессии при изменении password/role/active/MFA material; старые миграции не меняются.
- ADMIN создаёт новые учётные записи неактивными, без готового пароля. Пароль и MFA привязывает оператор через локальную TTY CLI: скрытый ввод, без credentials в argv/output. TOTP base32 key предварительно создаётся офлайн оператором/Authenticator. Bootstrap сохраняет persistent marker; повтор запрещён даже после блокировки. Восстановление существующего аккаунта — отдельная CLI, без повышения роли.
- ADMIN-only каталог/сотрудники; RECEPTIONIST пока использует только public catalogue и собственную сессию. Его schedule/booking endpoints появятся на этапе 4. Общего settings PATCH нет: настройки пока конфигурационные.
- Audit изменений атомарен с записью; только имена изменённых полей, без значений/PII. Public DTO отделены от admin. Ошибка аудита откатывает изменение.

Применяются [node-argon2](https://github.com/ranisalt/node-argon2) 0.45.2 и [OTPAuth](https://github.com/hectorm/otpauth) 9.6.0, зафиксированные lockfile. Argon2id соответствует направлению [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); параметры проверены функционально, production capacity требует измерений. CSRF следует принципу привязанного к сессии подписанного double-submit из [OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html). Это не заключение о соответствии законодательству РК.

## Окружение и первая выдача доступа

После `npm ci` выполнить `npm run setup`, `npm run db:up`, `npm run db:deploy`, при необходимости `npm run db:seed`. Setup генерирует независимые 32-byte `AUTH_MFA_KEY` и `AUTH_CSRF_KEY` только при отсутствии соответствующей переменной в локальном ignored `.env`; существующие значения сохраняет. `AUTH_ORIGIN` — точный origin браузерного приложения, локально `http://127.0.0.1:5173`. В production обязательно HTTPS. Чужие HTTP-origin, URL с credentials/path/query/hash и одинаковые ключи отвергаются без вывода их значений.

Секреты нужны только API и CLI. Их нельзя передавать frontend, помещать в `VITE_*`, Git, аргументы команд или примеры. Рабочая конфигурация пока принудительно `DATA_MODE=synthetic`. Seed не создаёт действующий доступ; в рамках реализации bootstrap рабочей БД не выполняется.

Оператор в приватном интерактивном терминале:

1. Подготавливает уникальный пароль 16–128 символов и случайный TOTP base32 key минимум 160 бит (32 символа A–Z/2–7). Создаёт ключ офлайн проверенным генератором/Authenticator, без облачной синхронизации и внешнего QR-сервиса. Настройки: SHA-1, 6 digits, 30 seconds; синхронизированные часы. Передаёт фактор конкретному сотруднику через утверждённый защищённый процесс.
2. Запускает `npm run staff:bootstrap`. CLI скрывает весь ввод: email, пароль дважды, base32 key и текущий код. Принимается только TTY, без pipe и дополнительных argv. Проверка кода, Argon2id, шифрование, создание активного ADMIN, одноразовый marker и аудит завершатся атомарно.
3. Ждёт **следующий** 30-секундный код: код подключения уже использован. Входит через API по последовательности ниже. Веб-интерфейс входа появится на этапе 6.

Marker не удаляется при блокировке ADMIN и защищён от обычных UPDATE/DELETE. Повтор bootstrap запрещён также при уже существующем активном ADMIN. Для API действует запрет заблокировать/понизить последнего активного ADMIN; privileged SQL/владелец БД может обойти ограничения и не является штатным способом работы.

Другого сотрудника ADMIN создаёт через `POST /admin/staff` (email и роль). Получается неактивный аккаунт без пароля/MFA. Оператор запускает `npm run staff:credentials` и выполняет ту же скрытую процедуру: новый пароль + новый MFA key + проверенный код. Она активирует **существующего** сотрудника, сохраняет его роль, отзывает все старые сессии и пишет системный audit. Эта же CLI восстанавливает утраченный фактор/пароль после проверки личности оператором; публичного восстановления, регистрации и recovery codes нет. Процедура требует административного доступа к серверу и ключам, поэтому доступ к ней должен быть отдельно контролируемым и журналируемым. Отмена Ctrl+C и ошибка не выводят введённые секреты. Интерактивный happy path терминала остаётся ручной приёмкой; внутренние транзакции CLI и запрет pipe покрыты тестами.

## HTTP-протокол и права

Точный контракт: [openapi.json](openapi.json), OpenAPI 3.1. `npm run openapi:generate` строит DTO из действующих Zod schemas; `npm run openapi:check` проверяет актуальность. Описание операций поддерживается вместе с router, а business refinements дополнительно описаны здесь. Все маршруты ниже имеют префикс `/api/v1`; неизвестные body/query-поля запрещены, JSON body максимум 16 KiB.

| Доступ               | Операции                                                               | Результат                                                                                                            |
| -------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Public               | GET `/doctors`, `/services`, `/:slug` соответствующего каталога        | Только активные сущности и активные назначения; цена десятичной строкой с 2 знаками, без технических/секретных полей |
| Public               | GET `/auth/csrf`                                                       | HttpOnly nonce cookie и `{csrfToken}`; запрос с чужим Origin/Sec-Fetch-Site cross-site запрещён                      |
| Public + CSRF        | POST `/auth/login`                                                     | Email/password → CHALLENGE cookie и `{mfaRequired:true}`; admin-доступ ещё закрыт                                    |
| CHALLENGE + CSRF     | POST `/auth/mfa/verify`                                                | `{code}` → ротация cookie и `{authenticated:true}`; принятие кода глобально одноразовое для сотрудника               |
| AUTHENTICATED        | GET `/auth/me`                                                         | Только собственные id/email/role                                                                                     |
| Сессия + CSRF        | POST `/auth/logout`                                                    | 204, отзыв и очистка cookie; допускается выход из CHALLENGE                                                          |
| AUTHENTICATED + CSRF | POST `/auth/password`                                                  | `{currentPassword,newPassword}` → 204 и отзыв всех собственных сессий                                                |
| ADMIN                | GET/POST `/admin/doctors`, `/admin/services`; GET/PATCH `/:id`         | Полный управляемый каталог; POST 201, PATCH 200; slug неизменяем; архивирование через isActive                       |
| ADMIN                | PUT `/admin/doctors/:id/services/:serviceId`                           | `{isActive}` создаёт/восстанавливает/деактивирует назначение без изменения истории                                   |
| ADMIN                | GET/POST `/admin/staff`, GET/PATCH `/:id`, POST `/:id/revoke-sessions` | Контролируемая выдача роли/блокировка/отзыв; password/MFA/token никогда не возвращаются                              |
| ADMIN                | GET `/admin/audit-events`                                              | Технический аудит, allowlist metadata, пагинация и диапазон до 31 дня (по умолчанию 7); само чтение аудируется       |

ADMIN-only распространяется и на чтение admin-каталога. RECEPTIONIST получает 403 на каталог управления, сотрудников и аудит; ему доступны собственный вход/MFA/пароль/выход и public catalogue. Его управление расписанием/записями будет подключено на этапе 4. Произвольных settings, passwordHash, role в catalog/login или изменения id/timestamps через body нет. Единственное HTTP-изменение роли — явный ADMIN-only staff PATCH. Настройки origin/ключей/таймзоны остаются конфигурацией сервера.

Пагинация: `page` 1–10000, `pageSize` 1–100 (по умолчанию 1/20); `{items,pagination:{page,pageSize,total}}`. Public карточки адресуются slug; admin — UUID. Фото — только подготовленный asset key `doctors/<slug>.(webp|avif|png|jpg)`, внешние URL/загрузка запрещены. Названия и описания — plain text, будущий UI не должен вставлять их через innerHTML.

Браузер использует same-origin proxy и cookies (`credentials: same-origin`), без localStorage:

1. GET `/auth/csrf`, сохранить csrfToken только в памяти страницы.
2. POST `/auth/login` с JSON, точным `Origin` и `X-CSRF-Token`; cookie устанавливает сервер.
3. **Снова** GET `/auth/csrf`, затем POST `/auth/mfa/verify` с новым токеном и актуальным кодом.
4. После успешной ротации снова GET `/auth/csrf`; защищённые мутации передают актуальный header. GET `/auth/me` подтверждает завершённую сессию.
5. При 401 начать вход заново; при 403 проверить права/CSRF; при 429 прекратить повторы до конца окна.

Без полной сессии защищённое чтение возвращает 401; неверная роль — 403. Для мутации CSRF проверяется до сессии: отсутствующий CSRF может дать 403 анонимному запросу. Неизвестный/отключённый аккаунт и неверный пароль дают одинаковый 401 LOGIN_FAILED; дубликат slug/email — 409 DUPLICATE_RESOURCE. При 500 наружу только INTERNAL_ERROR и requestId. MFA-коды, токены и ключи не входят в JSON ответов. Email сотрудников допустим только в защищённом staff DTO/собственном me; в public DTO и логах его нет.

## Координация, аудит и лимиты

В каждом защищённом запросе заново проверяются пользователь, роль, состояние MFA, token hash, auth stage, абсолютный и idle срок и revokedAt. Проверка и изменение выполняются в одной транзакции под блокировкой сотрудника/сессии. API-изменение доступа сериализовано с текущей работой этого сотрудника, поэтому последующий запрос со старой сессией не может выполнить мутацию. Дополнительный SQL-триггер отзывает все сессии при смене role/active/password/MFA ciphertext/enabled; смена TOTP counter сессии не отзывает. Он не заменяет общий lock-протокол для произвольных прямых SQL-операций.

Staff management берёт глобальную advisory-блокировку (75003,1), затем отсортированные UUID сотрудников и сессию. Дальше catalog write использует общие helpers doctor → service этапа 2; изменение service не захватывает врачей. Цена/длительность/активность не меняют snapshots и не отменяют существующие записи. Миграции этапа 2 сохранены.

Audit создаётся в той же транзакции, что административная операция. Он содержит actor id/requestId/entity id/action и только имена изменённых разрешённых полей, без значений. Чтение staff и audit фиксируется отдельно; чтения пациентов пока не существует. Public read/auth errors не возвращают ORM-модели. ReportUnexpected получает только серверный случайный requestId; HTTP body/headers/URL/cookies и исходная DB error не логируются. Audit UPDATE/DELETE запрещены прежним триггером; owner/TRUNCATE требуют отдельного ограничения прав.

| Лимит                     | Значение на общее фиксированное окно                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `/api/v1` кроме health    | 300 / IP / 1 минута                                                       |
| Password login            | 30 / IP / 15 минут и 10 / нормализованный email / 15 минут                |
| MFA                       | 30 / IP / 5 минут, 5 / challenge token / 5 минут, 5 / сотрудник / 5 минут |
| Смена собственного пароля | 5 / сотрудник / 15 минут                                                  |
| Argon2                    | Не более 4 параллельных операций на процесс; избыток → 429 AUTH_BUSY      |

PostgreSQL upsert считает попытки атомарно между процессами; ключи HMAC с разделением purpose, без IP/email/token в открытом виде. Лимиты включают успешные попытки и не сбрасываются успешным паролем. Истечение окна проверяется при обращении; автоматическое физическое удаление истёкших buckets/сессий — задача этапа 7, перед production обязательна защита от накопления. Отказ PostgreSQL не открывает доступ.

`trust proxy=false`: forwarded headers игнорируются, используется socket IP. Сейчас это безопасная локальная конфигурация, за reverse proxy все клиенты разделят его IP-лимит. До production нужно согласовать точную allowlist proxy/hops, запретить прямой доступ к API и отдельно проверить Origin/TLS/клиентский IP. Нельзя включать произвольный `trust proxy=true`. Rate limit не заменяет сетевую защиту от распределённого DoS и осознанной блокировки аккаунта.

## Минимальные права PostgreSQL

Локальный Compose/runner пока используют владельца синтетической БД. Это **не production runtime**. Ниже спецификация отдельных ролей до production; она не создаёт реальные accounts/пароли и не применяется автоматически:

| Роль                   | Разрешения                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| migration owner        | DDL, extensions, миграции; только оператор/CI миграций, не API                                                                                                                                                                             |
| runtime этапа 3        | CONNECT нужной БД, USAGE schema public; SELECT/INSERT/UPDATE doctors, services, doctor_services, staff_users, staff_sessions, rate_limit_buckets; SELECT/INSERT audit_events; без прав на bootstrap_state и таблицы пациентов/бронирования |
| offline staff operator | CONNECT/USAGE; SELECT/INSERT/UPDATE staff_users; SELECT/UPDATE staff_sessions (включая trigger revoke); SELECT/INSERT bootstrap_state и audit_events; без catalog/appointments/DDL                                                         |
| integration runner     | CREATEDB только в изолированной synthetic test-среде, никогда runtime                                                                                                                                                                      |
| maintenance            | Отдельная процедура очистки/backup с минимальными правами после утверждения retention; не общая runtime-роль                                                                                                                               |

Ни runtime, ни staff operator не должны быть owner/superuser, иметь CREATEDB/CREATEROLE/BYPASSRLS, CREATE в schema, TRUNCATE, DELETE/UPDATE audit или права на `_prisma_migrations`. В runtime не выдаётся INSERT/UPDATE/DELETE bootstrap marker: это исключает его повторное создание через приложение. SELECT bootstrap_state для HTTP не нужен. Для CLI оператор передаёт отдельный DATABASE_URL через защищённое окружение процесса (без credentials в shell history/argv), общие MFA/CSRF keys должны совпадать с сервером. Привилегии будущего booking API расширяются отдельно на этапе 4. Реальное создание ролей/GRANT, проверка отказов и безопасный миграционный pipeline требуют приёмки stage 7.

## Проверки и оставшиеся границы

Integration suite использует две независимые Prisma connections/app instances и только временную БД runner. Проверяет вход/отказ, concurrent bootstrap/MFA/rate limits, сроки/rotation/revoke, CSRF/Origin, 401/403, mass assignment, catalog CRUD/archival, audit rollback/allowlist, безопасные ответы/логи; повторяет календарь этапа 2. Детали фактического прогона — [STAGE-3-REPORT.md](STAGE-3-REPORT.md).

До production отдельно нужны: ручная TTY/Authenticator и browser HTTPS приёмка, антифишинговая политика MFA (TOTP не phishing-resistant), безопасная выдача/проверка личности и восстановление, secrets storage и ротация MFA ключа с повторным шифрованием (смена env-key сама данные не мигрирует), синхронизация часов, новые DB credentials/grants, retention/cleanup, нагрузка/DoS/proxy, backup/restore и применимость криптосредств/хранения в Казахстане. Текущий MFA envelope v1 не имеет key ring для автоматической ротации. MFA key потерян — расшифровать прежние факторы нельзя; восстановление требует CLI после проверки личности. Production и юридическая готовность не заявлены. UI и API бронирования этапов 4–6 не реализуются здесь.
