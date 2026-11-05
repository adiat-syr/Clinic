# Этап 4: результат

Дата: 05.11.2026. Выполнены сохранение этапа 3, исправление MFA quota и API этапа 4. Только синтетические данные. После этапа 4 остановка перед этапом 5.

## Git и MFA

`git status` подтвердил незакоммиченные изменения этапа 3 поверх `4cdd99b` («Этап 2»). Все 38 файлов сохранены коммитом **1a71dc9**, включая исправление MFA и регрессионный тест. Существующий код не откатывался; миграции не переписывались. Первый Git write требовал выхода из read-only sandbox для .git, после штатного разрешения commit успешен; отказа automatic approval review не было.

Подтверждён **Medium** дефект доступности: в `AuthService.verifyMfa` поиск по token hash и mfa-account increment предшествовали проверке expiry/revokedAt/authStage. Атакующему требовалось знать старый token конкретного сотрудника (не произвольный UUID/email). Он мог получить привязанный CSRF через разрешённый GET и пятью запросами заблокировать новый MFA-вход этого сотрудника до истечения quota window. Пароль/MFA не обходились, ADMIN-права не выдавались.

Теперь account increment выполняется только после `withSession` и проверки CHALLENGE под блокировками сотрудника/сессии. IP/token limits остаются до проверки, чтобы ограничивать invalid traffic. Account limiter сохраняет неуспешную попытку отдельным commit, поэтому rollback неверного кода её не отменяет. Регрессионный тест: revoked challenge получает 401 пять раз, другой живой challenge того же сотрудника принимает правильный код через второй app instance. Перед этапом 4 прошли **58 integration + 21 unit/HTTP/config**.

## Реализован этап 4

- REST public availability и актуальное ru/kk согласие; strict DTO и ограничения даты/горизонта/частоты. Даты дня переводятся из CLINIC_TIME_ZONE независимо от ОС клиента/сервера; вывод ISO UTC с явным timezone.
- POST appointments с контактами/consent, Origin+CSRF и Idempotency-Key. Сервер рассчитывает цену/конец по PostgreSQL, проверяет offer/consent/work/break, сохраняет согласие/запись/key одной транзакцией. Public результат минимален, без контактов и внутреннего appointment id.
- Приложенное AES-256-GCM шифрование контактов через Node crypto: nonce/tag/AAD purpose+key-version, отдельный key ring, постоянный HMAC fingerprint и idempotency secret отдельно от MFA/CSRF/encryption keys. Конфигурация fail-closed; повторное шифрование с другим nonce не меняет идемпотентность. Чтение старого key version и отказы при tamper/purpose/key mismatch покрыты тестами.
- Обе staff-роли управляют конкретными рабочими окнами и записями: ограниченная очередь без контактов, карточка с расшифровкой и audit, confirmation/cancel/terminal statuses, атомарный перенос с version и проверками прежнего ядра. Массовое применение request body/поиск по телефону/заметки не добавлены.
- ADMIN фиксирует проверенный отзыв согласия с optimistic version и audit; без выдуманной автоматической отмены/удаления. Последующие действия требуют утверждённого retention/регламента.
- Контролируемая offline CLI публикации синтетического согласия: version/textRu/textKk, атомарная retirement прежнего документа, неизменяемость опубликованного текста, вывод только id/version.
- OpenAPI 3.1 дополнен из актуальных Zod schemas; setup/CI учитывают privacy keys. Инструкции и ограничения: [BOOKING-API.md](BOOKING-API.md).

Архитектура сохранена. `BookingService.inTransaction` принимает уже открытую auth-транзакцию, не запускает вложенную независимую транзакцию; mutations и actor audit завершаются одним commit. Самостоятельное core API этапа 2 сохраняет прежний transaction wrapper/retries. Public booking по-прежнему первым берёт advisory idempotency lock; staff HTTP — staff/session, затем doctor/service/appointment. Общие doctor locks координируют каталог/расписание/бронирование. Exclusion/FK/CHECK/consent/append-only и 13 моделей не изменены, новых миграций не понадобилось.

## Проверки

| Проверка                      | Результат                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm test                      | **24/24**: 21 прежний тест и 3 privacy tests                                                                                                            |
| npm run test:integration      | **69/69** на PostgreSQL 18.6: 58 регрессий этапов 1–3/MFA fix и 11 новых HTTP workflows                                                                 |
| Миграции                      | Полная история 3 миграций с нуля и повторный no-op deploy, каталоги ограничений/FK indexes сохранены                                                    |
| HTTP 20-way distinct bookings | 1 HTTP 201, 19 HTTP 409 SLOT_UNAVAILABLE, 1 appointment                                                                                                 |
| HTTP 20-way same-key retry    | 1 HTTP 201, 19 HTTP 200, одно consent/appointment; changed payload → 409 без прежних контактов                                                          |
| Авторизация/CSRF/DTO          | Public/RECEPTIONIST/ADMIN права, отсутствие сессии 401, withdrawal 403 для reception, CSRF и unknown/PII fields запрещены                               |
| Записи/расписание             | Window CRUD и overlap, отказ сокращать занятое расписание, confirm/version/cancel, перенос, конфликт сохраняет исходную запись; отмена освобождает слот |
| Audit transaction             | Ошибка DB audit откатывает booking status; SQL/stack/private marker не выдаются клиенту или в logger                                                    |
| Privacy                       | Plaintext отсутствует в ciphertext/public/queue; контакты доступны только в staff detail с audit; nonce/fingerprint/key rotation/tamper проверены       |
| Consent                       | GET locale, новая публикация retirement, stale consent 409, verified withdrawal/version без удаления записи                                             |
| Старые гонки ядра             | Повторно проходят raw SQL 20-way exclusion, service concurrency, schedule race, idempotency/rollback/status/version/snapshots                           |
| Typecheck/lint                | Успешно, TypeScript strict, без lint warnings                                                                                                           |
| OpenAPI/format                | Проверена актуальность генератора и форматирование                                                                                                      |
| Build/smoke                   | contracts/API/web build, compiled Express + Vite proxy + реальная DB readiness, public catalogue, admin 401 — успешно                                   |

Первый HTTP-прогон выявил двойную валидацию даты: Zod преобразовывал ISO в Date, а core ожидает ISO. Исправлено преобразование в create/reschedule adapter; повторный полный прогон успешен. Fixture-операции выполняются только в собственных `clinic_test_<32hex>`, runner удаляет свою БД после каждого запуска. Рабочий DATABASE_URL не сбрасывался, не очищался; рабочие пациенты/учётные записи не создавались.

## Изменённые файлы этапа 4 относительно 1a71dc9

```text
.env.example
.github/workflows/ci.yml
AGENTS.md
README.md
TASKS.md
package.json
scripts/setup.mjs
apps/api/package.json
apps/api/scripts/openapi.ts
apps/api/src/app.ts
apps/api/src/server.ts
apps/api/src/modules/booking/service.ts
apps/api/src/modules/security/router.ts
apps/api/tests/security.integration.test.ts (форматирование нового regression test)
docs/AUTH.md
docs/DATABASE.md
docs/openapi.json
```

Новые:

```text
apps/api/scripts/booking-openapi.ts
apps/api/scripts/consent.ts
apps/api/src/modules/booking/http-service.ts
apps/api/src/modules/booking/privacy.ts
apps/api/src/modules/booking/router.ts
apps/api/tests/booking-http.integration.test.ts
apps/api/tests/booking-privacy.test.ts
docs/BOOKING-API.md
docs/STAGE-4-REPORT.md
```

Ignored .env дополнен случайными privacy keys без вывода; generated client/dist — артефакты. Новых зависимостей и изменений lockfile не требуется. UI, Stitch и оригинальные migration-файлы не менялись.

## Непроверенное и риски

1. Production TLS/browser/реальная TTY/Authenticator, hardened proxy/IP, отдельные DB roles/GRANT, безопасное secret storage и оперативное восстановление — не проверены здесь. Минимальные права расширены в BOOKING-API; synthetic owner не является production runtime.
2. Шифрование функционально проверено, но утверждение криптосредств/размещения в Казахстане, юридические тексты/цели/retention, удаление/backup/restore и регламент отзыва остаются этапу 7. Данных реальных пациентов использовать нельзя. Подтверждение личности при withdrawal — обязанность ADMIN, не автоматическая проверка boolean.
3. Есть key ring для чтения старых контактов; автоматического re-encryption/rotation job и production vault нет. HMAC key должен оставаться стабильным для существующих повторов; его несогласованная смена нарушит replay. Очистка TTL/audit retention ещё не реализована.
4. Для записей optimistic version проверяется; рабочие окна сериализованы doctor lock и сохраняют существующие приёмы, но отдельной optimistic version для окон нет (последняя допустимая замена). Это следует учесть при UI этапа 6.
5. Проверены конкурентность 20 запросов и прикладные ошибки, но не production capacity, distributed DoS/account lockout, failover/разрывы около commit и RPO/RTO. Отправка SMS/email, интерфейсы, deployment не выполнялись. Новая CLI consent успешно проверяется сервисными транзакциями, ручной запуск оператором/TTY не заявляется.
6. Удалённый GitHub CI не запускался; локальные проверки выполнены. Прежний независимый аудит Astra не был завершён пользователем и не выдаётся за полный security sign-off.

**Этап 4 завершён; этап 5 не начат. Ожидать подтверждения пользователя.**
