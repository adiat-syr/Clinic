# Результат этапа 3

Дата: **05.11.2026**. Реализован только этап 3. Работа остановлена перед этапом 4. Использовались только синтетические данные. Реальных пациентов, внешних сервисов, публикации, форм записи и интерфейса админки нет. Frontend и оригиналы Stitch сохранены.

## Реализовано

- Одноразовый bootstrap ADMIN и подключение/восстановление существующих сотрудников через приватную TTY CLI. Нет стандартных паролей, секретов в argv/pipe или вывода credentials; persistent marker и общая PostgreSQL-блокировка исключают второй bootstrap, включая конкурентные процессы.
- Argon2id 64 MiB/timeCost 3/parallelism 1 через node-argon2 0.45.2, уникальная соль библиотеки, максимум 4 параллельных вычисления на процесс. Пароль 16–128 символов при выдаче/смене.
- Обязательный TOTP MFA для обеих ролей через OTPAuth 9.6.0: SHA-1/6 digits/30 s/окно ±1, атомарный монотонный counter исключает replay и конкурентное повторное принятие. Секрет AES-256-GCM зашифрован с привязкой к staff UUID; ключ отдельно от БД.
- Серверные cookie-сессии: случайный 256-bit token, только SHA-256 в БД; CHALLENGE 5 минут, AUTHENTICATED 8 часов и idle 30 минут. Ротация при входе/MFA; HttpOnly/SameSite=Lax/Path=/, Secure и __Host- на HTTPS; исключение HTTP только для loopback development/test с другим именем cookie.
- Выход, собственная смена пароля, блокировка, смена роли/MFA и явный отзыв сессий. DB-триггер отзывает все сессии при изменении security material. Сотрудник без полного MFA не получает защищённый доступ.
- CSRF HMAC, привязанный к nonce cookie и текущему session token, точный Origin, проверка cross-site Fetch Metadata; login также защищён. Нужен повторный GET csrf после ротации. CORS не открыт; токены не попадают в localStorage.
- Backend RBAC и повторная проверка текущих роли/сессии в каждой защищённой транзакции. ADMIN управляет каталогом/сотрудниками/аудитом; RECEPTIONIST не имеет этих прав. Его schedule/booking API — этап 4. Запрет блокировки/понижения последнего активного ADMIN сериализован между процессами.
- Public/admin REST каталога: пагинация, карточки slug/UUID, создание/редактирование врачей/услуг, цены и длительность, назначения врач–услуга и деактивация без удаления истории. Strict Zod и DTO allowlists блокируют mass assignment/неизменяемые поля; ORM-модели наружу не возвращаются.
- API сотрудников создаёт только неактивные аккаунты без готового пароля/MFA; activation требует offline provisioning. HTTP не принимает passwordHash/MFA secret/внутренние timestamps.
- Общий PostgreSQL limiter API/входа/MFA/смены пароля, HMAC identities без открытых IP/email/token. Forwarded IP игнорируется (`trust proxy=false`); распределённые процессы используют один атомарный счётчик.
- Атомарный audit административных мутаций и чтения staff/audit: actor id, requestId и имена разрешённых полей без значений. Ошибка audit откатывает действие. Сохраняется append-only защита UPDATE/DELETE. Ошибки/логи не содержат SQL/stack/body/секретов; клиент получает безопасный код и requestId.
- OpenAPI 3.1 с генерацией DTO из текущих Zod schemas и проверкой актуальности; инструкции выдачи/восстановления, протокол cookies/CSRF, лимиты, минимальные scopes БД и production-границы в [AUTH.md](AUTH.md).

## Архитектурные решения

Сохранены npm-монорепозиторий, Express-модульный монолит, React/Vite и PostgreSQL/Prisma. Логические auth/staff/audit сгруппированы в `modules/security`, catalogue DTO/services — в `modules/catalog`. Router выполняет HTTP-адаптацию и вызывает сервисы; запросы к БД не вынесены в HTTP handlers. Административная проверка доступа и изменение каталога входят в одну транзакцию.

Общий порядок: staff-management advisory lock при управлении сотрудниками → staff UUID по порядку → session → doctor → service. `booking/catalog-mutations` используется и API каталога, и прежним BookingService. Изменение услуги не захватывает затем врачей. Ядро бронирования, exclusion constraints, snapshots, consent и idempotency сохранены.

Добавлена **третья** миграция `20261105000100_staff_security`: две технические таблицы (bootstrap marker и rate buckets), CHECK/FK/индексы, immutable marker и отзыв сессий. Итого **13 моделей**. Первые две миграции не переписаны: все три SHA-256 совпадают с `_prisma_migrations` локальной БД. Новые модели необходимы для одноразового bootstrap и общих лимитов без Redis/внешней системы; бизнес-модель пациентов не расширяется.

Настройки ключей/origin остаются серверной конфигурацией. Общего settings API, произвольного редактирования доступа, загрузки файлов, регистрации сотрудников или HTTP-выдачи MFA secrets нет. Контракты с серверными схемами не импортируются в web bundle. Слои и границы при подключении будущего booking HTTP должны сохраняться; безопасная композиция auth с его транзакцией будет частью этапа 4.

## Фактические проверки

Среда: Node **24.21.0**, npm **11.19.0**, PostgreSQL **18.6**, Prisma **7.10.1**. Версии существующего стека не менялись; новые зависимости только Argon2/OTPAuth и их lockfile tree.

| Проверка                                        | Результат                                                                                                                                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                        | Чистая установка: 428 packages, audit 432, **0 известных уязвимостей** на дату запуска                                                                                                                                                 |
| `npm test`                                      | **21/21**: 15 прежних HTTP/config и 6 новых checks ключей/origin/MFA encryption boundary                                                                                                                                               |
| `npm run test:integration`                      | **57/57** на реальном PostgreSQL: 30 сценариев этапа 3 + 27 регрессий этапа 2                                                                                                                                                          |
| Миграции с нуля и повторно                      | Три миграции применены в новой собственной БД runner, второй deploy no-op; ручные CHECK/triggers/exclusions и FK indexes проверяются каталогами PostgreSQL                                                                             |
| Прямой SQL                                      | CHECK bootstrap singleton/rate counter/finite expiry, MFA/email/offer/contact/consent/audit и прежние ограничения проверяются непосредственно в PostgreSQL                                                                             |
| Конкурентный bootstrap                          | Два независимых пула: ровно один ADMIN/marker, второй получает BOOTSTRAP_ALREADY_COMPLETED; повтор после блокировки запрещён                                                                                                           |
| Argon2/MFA                                      | Реальный hash/verify; encrypted secret; password-only challenge не даёт доступ; один код в двух приложениях даёт 200 и 401; replay/неверный код/истечение запрещены                                                                    |
| Сессии                                          | Hash вместо raw token, безопасные cookie flags, rotation/старый token 401, idle и absolute expiry отдельно, logout/password/role/block/MFA reset/revoke закрывают прежний доступ                                                       |
| CSRF/RBAC                                       | Отсутствующий/чужой Origin/header, старый CSRF после rotation, 401/403, RECEPTIONIST role escalation и неизвестные поля блокируются                                                                                                    |
| Общие лимиты                                    | Два приложения: account/IP/MFA/password limits; spoofed forwarded headers не обходят IP; из 20 concurrent bucket increments проходят ровно 5 при limit 5, 15 получают 429; expiry окна проверен                                        |
| Последний ADMIN                                 | Два администратора одновременно блокируют себя: 200/409, остаётся один активный ADMIN                                                                                                                                                  |
| Каталог                                         | Реальные POST/GET/PATCH/PUT, ru/kk поля, цена/длительность, safe public DTO, неизвестные/неизменяемые/некорректные значения 400, назначение/деактивация без удаления                                                                   |
| Исторические связи                              | Деактивация/изменение предложения сохраняют существующую запись и snapshots; booking HTTP остаётся 404                                                                                                                                 |
| Audit/ошибки                                    | Actor/field allowlist; чтение staff/audit аудируется; чужая metadata не выдаётся; искусственный DB secret в ошибке не попадает в ответ/логи, catalog write откатывается                                                                |
| Регрессия бронирования                          | 20 конкурентных вызовов сервиса → 1 успех/19 SLOT_UNAVAILABLE; 20 прямых SQL → 1 commit/19 SQLSTATE 23P01; idempotent 20-way replay, schedule race, соседние интервалы/перерывы, перенос/отмена/version/согласие и snapshots сохранены |
| `npm run lint`, `npm run typecheck`             | Успешно, TypeScript strict и 0 lint warnings                                                                                                                                                                                           |
| `npm run db:validate`, `npm run db:check`       | Schema валидна; реальный PostgreSQL 18.6 и btree_gist доступны                                                                                                                                                                         |
| `npm run openapi:check`, `npm run format:check` | Контракт актуален; форматирование проверено                                                                                                                                                                                            |
| `npm run smoke`                                 | Build contracts/API/web, compiled Express → Vite proxy → PostgreSQL, public catalogue/no-store и admin 401 — успешно; временные процессы закрыты                                                                                       |
| Локальный migrate deploy                        | Применена только новая миграция, без reset/drop/truncate рабочего DATABASE_URL                                                                                                                                                         |
| Итоговый состав clinic_local                    | 2 вымышленных врача, 3 услуги, 1 отключённый сотрудник; **0 активных сотрудников, сессий, записей и bootstrap markers**. Рабочий ADMIN не создавался                                                                                   |
| Cleanup тестов                                  | Все собственные временные БД удалены runner; оставшихся `clinic_test_<32hex>` — **0**                                                                                                                                                  |
| Stitch/frontend                                 | **13/13** извлечённых оригиналов совпадают с ZIP по SHA-256; web-исходники и дизайн не менялись, прежние JS/CSS asset names сохранены                                                                                                  |

Интеграционные тесты используют только runner-created `clinic_test_<32hex>`, а не рабочую БД. SQLite/моками PostgreSQL-проверки не заменялись. Временные аккаунты/секреты случайны и существуют только в удалённой после теста синтетической БД; bootstrap/credentials CLI в рабочей БД не запускались. Docker Desktop потребовалось запустить локально перед проверками; после запуска PostgreSQL healthy.

## Изменённые существующие файлы — 17

```text
.env.example
.github/workflows/ci.yml
AGENTS.md
README.md
TASKS.md
package.json
package-lock.json
scripts/setup.mjs
scripts/smoke.mjs
apps/api/package.json
apps/api/prisma/schema.prisma
apps/api/src/app.ts
apps/api/src/server.ts
apps/api/src/middleware/errors.ts
apps/api/src/modules/booking/service.ts
apps/api/tests/booking.integration.test.ts
docs/DATABASE.md
```

## Новые файлы — 21

```text
apps/api/prisma/migrations/20261105000100_staff_security/migration.sql
apps/api/scripts/staff.ts
apps/api/scripts/openapi.ts
apps/api/src/modules/booking/catalog-mutations.ts
apps/api/src/modules/catalog/schemas.ts
apps/api/src/modules/catalog/service.ts
apps/api/src/modules/security/audit.ts
apps/api/src/modules/security/config.ts
apps/api/src/modules/security/crypto.ts
apps/api/src/modules/security/errors.ts
apps/api/src/modules/security/input.ts
apps/api/src/modules/security/rate-limit.ts
apps/api/src/modules/security/repository.ts
apps/api/src/modules/security/router.ts
apps/api/src/modules/security/service.ts
apps/api/src/modules/security/staff.ts
apps/api/tests/security-config.test.ts
apps/api/tests/security.integration.test.ts
docs/AUTH.md
docs/openapi.json
docs/STAGE-3-REPORT.md
```

Локальный `.env` дополнен отсутствовавшими случайными auth keys без вывода значений; он игнорируется. Generated Prisma client, dist, node_modules и диагностические `.tmp` — игнорируемые артефакты, не исходники. Git-репозиторий пока отсутствует; перечень относится к изменениям данного этапа, не к `git diff`. Исторические отчёты этапов 1–2 сохранены.

## Отдельно: непроверенное и оставшиеся риски

1. **Production HTTPS/browser и ручная TTY/Authenticator приёмка не выполнены.** В тестах настоящие HTTP/PG и проверка Set-Cookie Secure/__Host flags, но не реальный browser за production TLS/proxy. Проверены сервисные транзакции bootstrap/credentials и отказ CLI от pipe; ручной скрытый ввод, распространение фактора и организационная проверка личности — обязательная приёмка. TOTP не защищает от фишинга так же, как аппаратный фактор.
2. **Локальный PostgreSQL всё ещё synthetic owner.** Минимальные scopes runtime/operator/migration определены в AUTH.md, но production роли/GRANT и отрицательные проверки привилегий ещё не применялись. Owner/SQL administrator может обойти сервисные правила и TRUNCATE/drop защитные таблицы. Privileged CLI требует отдельного контроля доступа и операционного аудита.
3. **Production secrets/key rotation не готовы.** Локальные ключи только в ignored env; требуется защищённое хранилище, права, backup/recovery и ротация с повторным шифрованием. MFA envelope v1 не содержит key ring; простая смена AUTH_MFA_KEY делает прежние факторы нечитаемыми. Потеря ключа требует контролируемого повторного подключения факторов.
4. **Нет автоматического физического cleanup TTL.** Истечение сессий/лимитов проверяется логически, но rows могут накапливаться. Требуются retention/cleanup rate buckets, сессий и idempotency keys; audit purge/backup — только по утверждённой политике. Технические HMAC/идентификаторы тоже могут быть связываемыми данными.
5. **Production нагрузка/DoS/proxy не проверены.** Shared limits и 20-way concurrency подтверждены; production benchmark Argon2/пулов, failover, сеть около commit, распределённый DoS/account-lockout и alerting требуют отдельной работы. При trust proxy=false за proxy используется его IP; allowlist/hops и запрет прямого API-доступа должны быть настроены и протестированы до запуска.
6. **HTTP booking, production privacy, UI и эксплуатационные/юридические условия остаются открытыми.** Контакты ядра всё ещё доверенные SealedContacts, настоящая обработка формы/ключей — этап 4. Не подтверждены реальные реквизиты/переводы/согласия, инфраструктура Казахстана, применимость криптосредств, удаление/backup/restore. Юридическое соответствие и пригодность к реальным пациентам не заявляются.
7. **Удалённый CI не запускался.** Workflow обновлён (эпhemeral keys без вывода, OpenAPI check, deploy/seed synthetic service DB перед smoke), но нет подключённого Git-репозитория/Actions-run. Локальные эквивалентные проверки выполнены.

Этап 4 не начат. **Ожидается отдельное разрешение пользователя.**
