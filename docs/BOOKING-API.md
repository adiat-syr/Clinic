# Этап 4: решения и критерии

Разрешены только API расписания/записи, privacy и согласия, без UI и production. Auth и защищённая booking-операция используют одну транзакцию: staff/session → doctor/service → appointment. Public create сохраняет прежний порядок advisory idempotency → doctor/service → consent. Ядро повторно не реализуется: получает transaction context от AuthService. Audit actor/requestId передаются в ядро.

Контакты: strict имя/телефон + согласие, телефон нормализуется к +7 и 10 цифрам. AES-256-GCM Node crypto, случайный nonce, AAD с purpose и версией ключа; ключи отдельно от БД, key ring для чтения старых версий, отдельный постоянный HMAC key для fingerprint/idempotency. Только synthetic mode; юридическая применимость криптосредств, secret storage, ротация и backup до production проходят отдельную приёмку. Контакты читаются только в защищённой карточке с аудитом; очередь без контактов.

POST /appointments требует Origin/CSRF и Idempotency-Key; возвращает только reference/status/время/offer без внутренних ключей и контактов. Availability принимает дату в зоне клиники, максимум один день; выборка очереди/расписания до 31 дня и pageSize≤100. Роли ADMIN/RECEPTIONIST работают с записями и расписанием; отзыв согласия — ADMIN, только confirmedIdentity=true и version. Отзыв фиксируется без автоматического удаления/отмены: дальнейшие действия по утверждённому регламенту, purge остаётся этапом 7.

Публикация согласия — offline CLI по локальному JSON-файлу с ru/kk/version; сериализована advisory lock, предыдущий документ снимается с публикации, опубликованное содержимое не изменяется. Нет HTTP-редактирования текста согласия.

Приёмка: старые тесты + реальные HTTP/PG race/replay, CSRF/RBAC/IDOR, отказ от запрещённых полей, отсутствие plaintext в БД/public/logs, version/status/перенос/отмена/перерывы/consent, атомарность auth и booking. После этапа 4 остановка перед этапом 5.

## Настройка и контракт

`npm run setup` добавляет только отсутствующие локальные privacy-настройки; имеющиеся значения не меняет и не выводит. `CONTACT_KEY_VERSION` выбирает активный ключ из `CONTACT_KEYS_JSON` (объект version→32-byte hex key). Старые версии оставляют в ring для чтения старых записей. `BOOKING_HMAC_KEY` — независимые 32 bytes, остаётся стабильным при смене encryption key, чтобы повторы имели прежний fingerprint. Ключи должны отличаться друг от друга и от AUTH_MFA_KEY/AUTH_CSRF_KEY. Сервер без корректной конфигурации не запускается. Удаление старого ключа делает старые контакты недоступными; автоматического re-encryption job здесь нет.

Публикация: `npm run consent:publish -- <absolute-path-to-synthetic-json>`. JSON strict: `version`, `textRu`, `textKk`, без данных заявителей. CLI выводит только id/version, не текст; отдельный offline operator DB account из AUTH.md расширить SELECT/INSERT/UPDATE consent_documents и SELECT/INSERT audit_events. Предыдущий current документ переводится в retired в той же транзакции. Не использовать клинический текст seed для реальных пациентов.

OpenAPI: `docs/openapi.json`, генератор `npm run openapi:generate`, проверка `npm run openapi:check`. Дополнены:

- GET `/api/v1/availability?doctorId=UUID&serviceId=UUID&date=YYYY-MM-DD`: IANA-зона CLINIC_TIME_ZONE, конкретный день, горизонт 60 дней, интервалы в ISO UTC; занятость посетителей не раскрывается. Лимит 60/IP/минуту.
- GET `/api/v1/consent-documents/current?locale=ru|kk`: id/version/text/hash выбранного языка, текущий опубликованный документ.
- POST `/api/v1/appointments`: JSON `{doctorId,serviceId,startsAt,expectedPriceKzt,expectedDurationMinutes,contacts:{name,phone},consent:{documentId,accepted:true,locale}}`; Origin + CSRF из `/auth/csrf`, header `Idempotency-Key` 32–128 hex. 201 при создании, 200 при идентичном повторе, 409 при конфликте/изменившемся предложении. 20/IP/15 минут, в том числе повторы. Ключ повтора только в header, контакты только в body.
- GET/POST `/api/v1/admin/availability-windows`, PATCH/DELETE `/:id`: обе роли; замена полного интервала и запрет удаления/сокращения, оставляющего существующие приёмы вне работы. PATCH/DELETE возвращают 204. Интервалы имеют minute precision, до 24 часов; перерыв — разрыв между ними.
- GET `/api/v1/admin/appointments`: `from`, `to`, optional doctorId/status/page/pageSize; список без контактов. GET `/:id`: расшифрованные контакты только обеим авторизованным ролям, с аудитом чтения.
- PATCH `/api/v1/admin/appointments/:id`: `{action:"status",version,status}` либо `{action:"reschedule",version,doctorId,serviceId,startsAt,expectedPriceKzt,expectedDurationMinutes}`. Разрешённые переходы и snapshots прежнего ядра; конфликт версии/слота — 409. Контакты, id, роль, заметки и ciphertext менять нельзя.
- POST `/api/v1/admin/appointments/:id/consent-withdrawal`: ADMIN-only `{version,confirmedIdentity:true}`, фиксирует время сервера и увеличивает version. Сотрудник обязан действительно проверить личность вне системы; boolean — аттестация оператора, не автоматическое доказательство личности.

Все защищённые HTTP-операции повторно проверяют сессию и роль, мутации — Origin/CSRF. Ответы no-store; неизвестные query/body поля отклоняются. Runtime этапа 4 дополнительно нужны SELECT/INSERT/UPDATE appointments, appointment_consents, idempotency_keys; SELECT/INSERT/UPDATE/DELETE availability_windows; SELECT consent_documents. Никаких DELETE appointments/audit, TRUNCATE/DDL/owner. Реальные GRANT и их отрицательные тесты — этап 7. Каталог с историей по-прежнему архивируется.

## Эксплуатационные границы

Окна расписания редактируются под общей блокировкой врача; optimistic version реализован для записей, а окна пока используют последовательное применение команд (последняя допустимая замена). UI этапа 6 должен учитывать это либо добавить явный version для окон отдельной миграцией. Безопасность существующих приёмов при этом сохраняется.

Шифрование прикладное: envelope v1 (`version byte / nonce / tag / ciphertext`), purpose+key version в AAD, nonce случайный для каждого поля. Проверяются подмена purpose, повреждение и отсутствие ключа. В public ответах нет контактов/внутреннего appointment id; технический reference не предоставляет прав чтения. Анонимизированная историческая запись в staff-карточке имеет contacts=null.

Физическая очистка, утверждённый retention/регламент отзыва, KZ-инфраструктура, применимость криптосредств, operator identity recovery, TLS/proxy, нагрузка/backup/restore остаются обязательными до production. Здесь только локальные синтетические сценарии; интерфейс этапа 5 не реализован.

## Дополнение этапа 6: названия в защищённой очереди

GET /admin/appointments и GET /admin/appointments/:id дополнительно возвращают doctorNameRu, doctorNameKk, serviceNameRu, serviceNameKk через существующую связь doctorService. Это текущие названия каталога, доступные после архивации; они не являются историческими snapshots имени. В OpenAPI поля optional для совместимости общего summary с ответами изменения статуса. Список не получает контакты; расшифровка и audit чтения остаются только в карточке. Роли и транзакции не изменены. Public API и ограничения PostgreSQL остаются прежними.

## Согласованное дополнение MVP

Добавлены POST /patient-consent-codes и защищённый POST /admin/appointments: самостоятельное согласие посетителя с одноразовым кодом на 5 минут и дополнительное создание сотрудником без передачи contacts/accepted. Контракты — openapi.json; точная процедура, транзакции, retry и ограничения идентификации — PHONE-BOOKING.md. Основной public POST /appointments сохранён. Только synthetic; это не юридически утверждённая телефонная запись.
