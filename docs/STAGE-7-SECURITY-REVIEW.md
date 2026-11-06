# Security review: исходная база этапа 7

Дата проверки: 06.11.2026. Независимый анализ выполнен в режиме чтения; production-код, конфигурация, зависимости и БД этим проверяющим не изменялись. Единственный созданный артефакт — этот отчёт. Исходная база — `04becdb` на `codex/stage-7`; сопоставление изменений — `e0424ec..04becdb`. Разработка этапа 7 выполняется параллельно владельцем задачи, поэтому ссылки на строки ниже относятся именно к зафиксированной базе, а не к окончательному состоянию рабочего дерева.

## Итог

Таблица в этом разделе относится только к исходной базе `04becdb`. Находки при последующей реализации этапа 7 и актуальный remediation checkpoint находятся в конце отчёта; их нельзя суммировать с baseline без учёта исправлений.

| Уровень  | Подтверждённых замечаний в базе |
| -------- | ------------------------------- |
| Critical | 0                               |
| High     | 0                               |
| Medium   | 2                               |
| Low      | 1                               |

Общий результат: **CONDITIONAL**. Обнаружены две проблемы доступности из-за повторного получения соединения внутри уже открытой транзакции и один дефект отображения аудита. Подтверждённых обходов MFA/RBAC, SQL injection, DOM XSS, IDOR за пределами разрешённой общеклинической модели или выдачи секретов через рассмотренные DTO не найдено. Это вывод в пределах указанного анализа, а не сертификат безопасности и не одобрение всего будущего production-развёртывания.

Владелец задачи получил замечания до завершения отчёта и начал исправление. Прямые проверки маршрутизации запросов и schema на текущем дереве уже показывают устранение M-01 и L-01; полноценные PostgreSQL-регрессии и итоговая проверка этапа остаются за общим прогоном владельца задачи.

## Объём и методика

Рассмотрены фактические исходники: `AuthService`, security router/config/crypto/input/rate-limit/staff/audit/repository, booking router/service/http-service/input/privacy/repository/transaction/catalog-mutations, catalogue schemas/service, app/server/error handling, schema Prisma и четыре миграции; frontend transport, admin session/cache flow, публичные формы/рендеринг, SSR и prerender. Проверены определения и назначения существующих auth/booking тестов. История и blame рассмотрены для найденных проблем. Анализ диффа затрагивает 51 изменённый файл (+2502/-368 строк); глубокий анализ сосредоточен на путях auth, мутаций, персональных данных и согласия, UI-словарь/стили рассматривались поверхностно.

Модели нарушителя: анонимный HTTP-клиент; обладатель правильного пароля с ещё не завершённым MFA; авторизованный RECEPTIONIST; ADMIN, задающий недоверенный текст каталога. Оператор с доступом к серверным ключам/БД является отдельной доверенной границей CLI, а не публичным пользователем.

Протокол проверки: фактический код → baseline и blame → достижимый call graph → анализ атак/инвариантов → существующие тесты и пробелы → безопасные проверки без БД. Полные тесты/сканеры/нагрузка/HTTPS в этом подзадании **не запускались**. Это не повторный отчёт о ранее выполненных 82 integration/35 unit/26 browser: их результаты здесь не присваиваются проверяющему.

## M-01. Дополнительное соединение для предварительного чтения внутри booking transaction

**Уровень:** Medium, доступность. **Пути в `04becdb`:** `apps/api/src/modules/booking/service.ts:353`, `:407`, `:455`; передача транзакции — `service.ts:83`, `http-service.ts:333`, `router.ts:75`, `router.ts:82`.

`BookingService.inTransaction(tx, ...)` сохраняет готовую auth-транзакцию, но `changeWindow`, `reschedule` и `transition` выполняют предварительное чтение через `this.client`, а не через переданный transaction context. HTTP-операция в этот момент уже удерживает соединение внутри `AuthService.withSession`.

**Сценарий:** при пуле из одного соединения достаточно одной корректной авторизованной команды изменения окна, переноса либо статуса: auth-транзакция занимает соединение, затем её же callback ожидает ещё одно соединение для начального SELECT. При большем пуле аналогичная ситуация возникает при конкурентных транзакциях, занявших все соединения. Ожидание заканчивается timeout/ошибкой вместо законной операции, а до timeout соединения заняты. Права и ограничения двойной записи при этом не обходятся.

**Достижимость:** четыре команды — PATCH/DELETE рабочего интервала и два action варианта PATCH записи. Для них достаточно обычной роли RECEPTIONIST с MFA. Blast radius — три метода core, четыре защищённых команды. Это не нарушение всей атомарности commit, но нарушение инварианта «переданный transaction context не требует второго соединения».

**История:** предварительные чтения существовали в ядре этапа 2 (`4cdd99b`); проблема проявляется при последующем использовании этого ядра внутри auth transaction. В рассматриваемом диффе защита не была намеренно удалена; это пропущенная адаптация при композиции транзакций.

**Подтверждение без БД:** модуль `04becdb` загружен в памяти; fake outer client бросает маркер при `appointment.findUnique`, переданный `tx` имеет отдельный `appointment.findUnique`. Вызов `core.inTransaction(tx,...).transition(validCommand)` в базе использует outer client (`true`); тот же probe на текущем исправляемом дереве возвращает `false`. Проверка не создавала пользователей, соединений, записей или файлов с исходником.

**Исправление:** для предварительных чтений выбирать `options.transaction ?? client`; после doctor/service locks по-прежнему перечитывать и проверять version/identity под нужными блокировками. Не заменять уже переданную транзакцию вложенной независимой.

**Нужная регрессия:** настоящий PostgreSQL, небольшой пул (включая max=1), авторизованный вызов изменения статуса/переноса/окна внутри withSession; операции завершаются до timeout и сохраняют прежние проверки 409/rollback. Существующие тесты охватывали функции и гонки, но использовали стандартный пул без проверки повторного захвата соединения.

## M-02. MFA account quota получает отдельное соединение при удерживаемой auth transaction

**Уровень:** Medium, доступность. **Пути в `04becdb`:** `apps/api/src/modules/security/service.ts:158–164`, `apps/api/src/modules/security/rate-limit.ts:10–23`, `apps/api/src/infrastructure/prisma.ts:9`.

Внутри callback `withSession` метод `verifyMfa` вызывает `this.limiter.require('mfa-account', ...)`. Лимитер использует внешний PrismaClient, а не auth `tx`. При этом staff/session rows и соединение auth transaction уже удерживаются. Это тот же класс истощения пула, но отдельный критичный путь входа, требующий отдельной регрессии.

**Сценарий:** при max=1 один действующий password-verified CHALLENGE не может закончить MFA, поскольку account quota ждёт второе соединение из того же пула. При насыщении большего пула конкурентными challenge requests также возможно взаимное ожидание до timeout. Неавторизованный пользователь со случайным токеном по-прежнему не получает права расходовать quota сотрудника: проверка живого CHALLENGE находится перед account limiter. Обход TOTP или повышение роли здесь не подтверждены.

**Достижимость:** один endpoint `/auth/mfa/verify`, один внутренний caller account limiter. Предусловие — действующий CHALLENGE после правильного пароля; завершённый MFA ещё не требуется. История — `1a71dc9`, где quota корректно перемещена после проверки live challenge, но оставлена отдельным committed запросом.

**Исправление:** tx-aware account limiter либо отдельный доказанно изолированный резервный limiter pool. Предпочтительный вариант — upsert в текущем `tx`: неправильный TOTP уже возвращает `false` из callback и тем самым позволяет закоммитить попытку/failed audit. При отказе выше threshold попытка не должна обнуляться или разрешаться повторно; `require` и ветвления нужно проверить под concurrency. Нельзя ради устранения ожидания перенести account quota обратно до проверки действительности сессии.

**Нужные регрессии:** валидный MFA при max=1; пять неправильных кодов с сохранением quota и последующий 429; revoked/expired CHALLENGE не расходует account bucket; параллельное использование одного TOTP допускает только одно подтверждение. Последние две проверки уже есть в suite и должны сохраняться.

**Доказательство:** подтверждено по источнику и call graph. Runtime-воспроизведение PostgreSQL этим проверяющим не выполнялось. Владелец задачи уведомлён и добавляет regression.

## L-01. API аудита скрывает имя изменённого email-поля

**Уровень:** Low, наблюдаемость. **Пути в `04becdb`:** `apps/api/src/modules/security/service.ts:285–287`, `apps/api/src/modules/security/audit.ts:12–34`, `:56–69`.

`changeStaffEmail` корректно атомарно записывает `STAFF_EMAIL_CHANGED` с `metadata.fields=['email']` без значений. Но `auditMetadataSchema` не содержит идентификатор `email`; при чтении события safeParse не проходит, и DTO заменяет metadata на `{}`. Само событие/UUID не исчезают, значения адресов не раскрываются; пропадает полезная информация об изменённом поле.

**Сценарий:** оператор меняет email, ADMIN читает `/admin/audit-events` и получает событие с пустыми metadata вместо допустимого имени поля. Никаких вредоносных прав для воспроизведения не требуется; это обычная разрешённая процедура. Blast radius — один producer, один audit DTO filter. Новая запись metadata появилась в `04becdb`; whitelist остался прежним.

**Подтверждение без БД:** `auditMetadataSchema.safeParse({fields:['email']}).success` у базы — `false`, у текущего исправляемого дерева — `true`.

**Исправление и регрессия:** добавить только литерал `email` в allowlist имён полей; не разрешать arbitrary values. После смены адреса проверять HTTP audit metadata `['email']`, отсутствие старого/нового адреса/секретов в DTO и сохранение фильтрации посторонних metadata.

## Рассмотренные защитные границы

- MFA: authenticated stage нужен до protected work; monotonic TOTP counter проверяется под staff/session lock; token меняется после MFA; случайный/просроченный/отозванный challenge не даёт account quota. Обход не подтверждён.
- RBAC и IDOR: все admin catalogue/staff/audit операции проходят ADMIN role check. Расписание/записи разрешены ADMIN и RECEPTIONIST в одной общеклинической модели; отсутствие персонального кабинета врача не является IDOR само по себе. Public чтения записи нет.
- Session fixation/revoke: opaque random token, hash в БД, fresh session/user state на запросе, абсолютный/idle срок, DB trigger для password/role/active/MFA; email CLI явно отзывает сессии. Сам токен остаётся bearer credential до истечения/отзыва, что не равно обходу контроля.
- CSRF: точный Origin, signed nonce + token binding, HttpOnly cookies, SameSite, защита login/MFA/mutations; старый CSRF после token rotation не подходит.
- Mass assignment: Zod strict DTO и explicit allowlists. Staff patch не принимает email/credential material; public/manual booking DTO не принимает произвольные ORM fields. Raw HTTP ciphertext/fingerprint/receiptHash отвергаются.
- Consent code: 128 бит случайности, domain-separated SHA-256, five-minute server check, immutable evidence, document binding, row lock и single consumption в одном booking commit. Identical idempotent replay возвращает существующий результат и не создаёт новый приём. Это описание технического поведения; вопросы вне технических свойств вынесены владельцем задачи отдельно.
- SQL injection: рассмотренные raw queries — tagged/parameterized Prisma templates; UUID/range/pagination проверяются. Unsafe raw SQL APIs в runtime-путях не обнаружены.
- XSS: каталог/согласия выводятся как React text, `dangerouslySetInnerHTML`/eval не обнаружены; prerender escaping `<` в JSON исключает закрывающий script payload. Asset key ограничен локальным шаблоном. Новую clinic конфигурацию этапа 7 ещё нужно проверять отдельно.
- Ошибки/PII: transport не выводит upstream body; error middleware возвращает codes/requestId; staff contacts только отдельной защищённой карточкой с audit. В source review не найдено логирования submitted password/TOTP/consentCode/body. Public query cache не хранит контакты, staff cache отдельный и не персистируется.
- Транзакции: общие doctor/service locks, optimistic appointment version, PG exclusion constraints и transactional rollback остаются в пути создания/переноса/отмены; подтверждённая проблема относится к выбору соединения, а не к замене exclusion обычным SELECT.

## Тестовая матрица и ограничения заключения

Источники тестов прочитаны: auth success/failure, MFA replay/concurrency/expiry, CSRF, 401/403, strict DTO, staff revoke/last ADMIN, audit rollback, encrypted contacts, conflict/version/consent/grant expiry, public/manual concurrency. Их наличие подтверждено, но результаты запусков должен предоставлять общий stage-7 runner. Выявленные пробелы — малый connection pool и whitelist audit email.

Фактически выполнены только read-only git/history/source searches и прямые модульные probes без БД. Первая попытка загрузки baseline data-URL не разрешила bare imports и не дала результата; повтор с абсолютным разрешением imports выполнил before/after probes. Никаких секретов или значений пациентских данных probe не использовал.

Не проверены в этом подзадании: фактический Docker/Linux runtime, TLS/reverse proxy/client IP, GRANT под минимальными ролями, restore и повторное применение удалений, key rotation на живой нагрузке, distributed DoS, dependency/SAST/secrets scanners, физические устройства, browser/TTY ручная приёмка и изменения root, внесённые после данного чтения. Это отдельные результаты общего этапа 7, а не автоматически пройденные проверки. До выпуска требуется сопоставить итоговый diff с этим отчётом и приложить фактические регрессии исправленных M-01/M-02/L-01.

## Продолжение: adversarial review новых инструментов этапа 7

Раздел добавлен по отдельному поручению владельца задачи. Проверены создаваемые `infra/ops/*`, Dockerfile/Compose/Caddy, prepare/deploy, secret/clinic/runtime guards и MFA v2 keyring. Это **промежуточный снимок незакоммиченного кода**: замечания направлялись владельцу сразу; часть уже исправляется. Номера строк обозначают состояние в момент обнаружения. Этот раздел не является подтверждением, что замечания остаются в финальном коде, либо что их исправления проверены интеграционным прогоном.

### H-04. Manifest резервной копии не аутентифицирует требования к deletion ledger

**Уровень:** High, целостность восстановления/удалений. **Места при обнаружении:** `infra/ops/backup.mjs:49–57`, `:96–101`; `infra/ops/ledger.mjs:15–52`.

Архив защищён AES-GCM, но `.gcm.json` содержал обычные `sha256`, `ledgerId`, `ledgerCount` без MAC. Restore сравнивал hash с тем же изменяемым manifest и проверял только совпадение ledger ID/минимальное число entries. Содержимое metadata не было связано с аутентифицированным ciphertext, а только валидная подпись старого registry не запрещает его rollback.

**Конкретный сценарий:** имеется старый валидный зашифрованный backup с PII и более поздняя зарегистрированная операция удаления. При восстановлении старой валидной копии registry или при потере/reinitialization registry злоумышленник с записью в backup metadata меняет ledgerId/count, не зная ключа AES. Проверка manifest проходит, GCM архив остаётся исходным валидным, поздние удаления отсутствуют в принятом registry. Восстановление может вернуть ранее удалённые контакты. Предусловие — доступ к backup metadata и возможность подмены/rollback ledger storage либо ошибочно восстановленная старая ledger-копия; это не атака публичным HTTP и не способ расшифровать GCM без ключа.

**Исправление:** HMAC всего canonical manifest отдельным purpose BACKUP_KEY, включая digest архива и ledger ID/count/prefix digest; проверять MAC и совпадение текущего prefix до CREATE DATABASE. Дополнительно нужен независимый актуальный checkpoint registry и fail-closed при отсутствии/расхождении. Полный rollback всех независимых доверенных checkpoint-хранилищ нельзя обнаружить одной подписью старого файла: эксплуатационный контроль свежести и отдельная защищённая копия обязательны.

**Регрессии:** backup до anonymize → anonymize → restore старого backup с актуальным ledger удаляет PII; изменение ledgerId/count/digest/MAC в manifest отклоняется до создания БД; старый валидный registry при актуальном checkpoint отклоняется; отсутствующий/повреждённый ledger/entry/checkpoint не разрешает restore. Владелец подтвердил внедрение HMAC/prefix/checkpoint; тесты должен приложить общий stage-7 прогон.

### H-05. Named volume сохраняет старый frontend bundle при update/rollback

**Уровень:** High, корректность выпуска и возможность фактического применения исправлений безопасности. **Места:** `infra/compose.production.yaml` mounts `web_assets` в `/app/apps/web/dist` и `/srv`; `infra/ops/assets.mjs:1–4`; `infra/deploy.mjs` ветви update/rollback.

При первом mount Docker заполняет пустой named volume из image. При следующем image update существующий volume перекрывает новый `dist`. Assets job только вызывает prerender, не копируя новые JS/CSS из независимого immutable image-пути. В результате шаблон/hashed JS могут остаться от предыдущего выпуска, а SSR уже выполняется новым серверным bundle. Публично видимая версия и исправления клиента не гарантированно обновляются. Rollback перезапускает API/web, но также оставляет содержимое volume от другой версии.

**Исправление:** хранить исходный новый dist вне перекрываемого mount; публиковать новые hashed assets до атомарной замены HTML/template, сохраняя старые hashes для уже открытых страниц. При rollback публиковать matching assets предыдущего image либо атомарно переключать versioned asset root. Не удалять произвольный volume и не считать restart доказательством обновления клиента.

**Регрессия:** отдельные v1/v2 artifact sentinel/bundle hashes: первый запуск → v2 update → rollback; через настоящий proxy проверить, какая HTML/JS версия фактически обслуживается, отсутствие потерянных hashes/частичного HTML и совместимость API. First-install smoke этот дефект не обнаруживает. Сообщено владельцу немедленно.

### M-06. Недостаточные GRANT для реальных row-lock операций

**Уровень:** Medium, доступность под минимальными ролями. **Места:** `infra/ops/database.mjs:65–92`; `booking/service.ts` и `http-service.ts` consent document FOR SHARE; `infra/ops/maintenance.mjs`/`rotation.mjs` doctor/service FOR UPDATE.

Runtime получил только SELECT consent_documents, но PostgreSQL требует UPDATE privilege хотя бы одной колонки для SELECT с locking clause. Поэтому code issue/booking, работающие под тестовым owner, откажут при clinic_runtime. Maintenance аналогично выполняет FOR UPDATE на doctors/services, имея там лишь SELECT.

**Исправление:** узкие права для locking. Для consent_documents возможен UPDATE(id): существующий immutable trigger запрещает фактическую смену ID. Для doctor/service locks — ограниченный helper или column grants с сохранением неизменяемости идентификаторов. Нельзя выдавать full UPDATE/owner только ради прохождения теста.

**Регрессии:** реальные runtime-role успешные code/public/staff booking, maintenance-role successful anonymization и rotation с appointments/receipts/MFA; одновременно отрицательные tests UPDATE документа, DDL/TRUNCATE/audit modification. Startup privilege flags без положительного business flow недостаточны.

### M-07. Rotation CLI использует роль, не имеющую прав обслуживания

**Уровень:** Medium, отказ ключевой операции. **Места при обнаружении:** `infra/deploy.mjs:54–55`, operator environment `DATABASE_URL_FILE=operator_url`, grants в `infra/ops/database.mjs`, `infra/ops/rotation.mjs`.

Ветка rotate-keys запускала operator service с clinic_operator. У неё нет SELECT/UPDATE appointments/receipts, а receipt rotation trigger отдельно требует membership clinic_maintenance. Команда отказывает до ротации, независимо от корректности ключей.

**Исправление:** отдельный rotation service с maintenance URL и только необходимыми key mounts. При повторном чтении владелец уже перенаправил команду на `rotation`; требуется проверить service wiring и actual permissions в общем прогоне.

**Регрессия:** запустить штатную deploy/CLI-команду под maintenance ролью, проверить контакты/receipt/MFA и отзыв сессий, затем повторить без ненужного logout уже ротированных факторов.

### M-08. Смена CLI mode не связана с подготовленным instance mode

**Уровень:** Medium, защита от ошибочного выпуска. **Места:** `infra/prepare.mjs` формирование compose.env, `infra/deploy.mjs:4–16`.

Production approval gate зависел только от переданного аргумента mode. Выбор staging для production-prepared instance использует те же DB/secrets/ports/volumes, но обходит RELEASE_APPROVAL. Даже если API позже отклонит профиль, bootstrap/migrate/grants уже могут выполниться. Staging override не фиксировал все bind значения независимо от env.

**Исправление:** сохранять DEPLOYMENT_MODE в instance config и отклонять несовпадение перед Docker/DB действиями; staging должен явно оставаться loopback/отдельным instance. Проверка: production-prepared config + CLI staging mode отклоняется без вызова Docker.

### M-09. Host UID/GID не согласован с владельцем приватных mounts

**Уровень:** Medium, Linux deployment correctness. **Места при обнаружении:** `infra/prepare.mjs:18–19`, `:51`, `:76`; USER в Dockerfile и Dockerfile.tools; bind mount definitions.

Prepare создаёт secrets/config 0600 и directories 0700 под UID запускающего host-пользователя. Контейнеры запускались UID1000. Подготовка root или пользователем UID1001 делает private mounts недоступными приложению/backup. Ослаблять mode до 0777 недопустимо.

**Исправление:** явный UID/GID contract и проверка прав; matching unprivileged APP_UID/GID либо контролируемая provisioning ownership-процедура. При повторном чтении owner уже добавлял compose user override; нужно учесть также владельца assets named volume и автоматический выбор/проверку UID на Linux, а не только Docker Desktop.

**Регрессии:** проверка настроек и реальный Linux UID, отличный от 1000; секреты читаются только нужным UID, backup/ledger writable, API остаётся non-root. Root preparation должно быть отклонено либо корректно провизионировать ownership.

### M-10. Подтверждение успешного backup до directory fsync

**Уровень:** Medium, долговечность. **Места:** `infra/ops/lib.mjs` encryptFile/atomicJson, `infra/ops/backup.mjs:49–74`.

Данные архива и временные JSON fsync выполнялись, но BACKUP_DIR не синхронизировался после создания archive и rename manifest/status перед success. При потере питания новые directory entries не гарантированно устойчивы. Ledger registerIntent уже содержит directory.sync; такую же границу долговечности нужно провести для backup до success.

**Исправление/проверка:** fsync directory после публикации archive/manifest и status, publish failure без success при ошибке; documented filesystem/storage guarantees. Аппаратный power-loss в этом чтении не моделировался. Дополнительно manifest.integrity измерялся после pg_dump и не сравнивался при restore: нельзя называть это проверкой идентичности исходного snapshot. Либо использовать один exported snapshot/fingerprint, либо точно ограничить гарантию pg_restore + проверкой инвариантов и известной синтетической restore fixture.

### Дополнительные замечания к границам новых инструментов

- Staff operator service первоначально монтировал также bootstrap/migrator URLs и все role passwords. Разделённые DB role names не изолируют скомпрометированный контейнер, если он может прочитать superuser credential. Нужны отдельные provisioning и staff operator mounts.
- Activation guard должен предотвращать перевод seed/demo каталога и синтетического текущего согласия в clinic mode одной сменой profile.synthetic/approved. Требуется технический instance/fixture guard и согласованное решение о текущем consent hash/version; demo данные нельзя автоматически удалять.
- MFA v2 envelope включает проверенный ASCII key ID в AAD и сохраняет v1 decoding. Подтверждённого bypass в криптографическом формате не обнаружено. Повторная rotation не должна заново шифровать уже активную v2 версию и без необходимости отзывать сессии. Старые encryption keys нужны для старых backups даже после отсутствия старых версий в текущей БД; единственный BACKUP_KEY требует отдельного escrow/версии.
- Новые backup/restore/cleanup проверки выполняются владельцем задачи. Reviewer не запускал destructive ops, не создавал/удалял БД, не читал secret files и не объявляет эти scenarios passed по одному анализу source.

### H-11. Reconcile registry мог откатить параллельно добавленное намерение удаления

**Уровень:** High, конкурентная целостность deletion ledger. **Место:** `infra/ops/ledger.mjs`, новая функция `reconcileLedger` (проверена сразу после добавления mirror checkpoint).

`registerIntent` держит `registry.lock`, но reconcile первоначально не захватывал тот же lock. Конкретное чередование: reconcile читает валидные registries на N entries → anonymize регистрирует N+1 в обеих копиях и коммитит удаление → reconcile публикует свой старый, но валидно подписанный N snapshot обратно в обе копии. Последняя операция удаления становится orphan entry-файлом, не входящим в registry; последующее восстановление старого backup может вернуть её PII. Все действия доступны обычным доверенным operational jobs без компрометации ключа, поэтому одного HMAC/checkpoint недостаточно.

**Исправление:** единая exclusive writer lock для register, reconcile и initialize, получаемая **до чтения** и удерживаемая до публикации/fsync обеих копий. Нельзя захватывать её вложенно через snapshot helper. Fail-closed при незавершённом старом lock допустим, но recovery stale-lock должна быть контролируемой и не обходить активного writer.

**Регрессия:** barrier после чтения reconcile, конкурентный register N+1 и commit erasure, затем продолжение reconcile; итоговый registry не должен уменьшаться или терять entry. Проверить также конкурентный initialize, безопасное согласование primary/mirror после прерывания и отказ при настоящем fork. Сценарий и исправление немедленно переданы владельцу; PostgreSQL/файловые мутации reviewer не выполнял.

### M-12. PostgreSQL error logging выходит за границу redaction приложения

**Уровень:** Medium, конфиденциальность эксплуатационных журналов. **Места при обнаружении:** `infra/compose.production.yaml:4–10` (PostgreSQL без явной logging policy), `infra/ops/database.mjs:19–22` (сформированный CREATE ROLE с literal PASSWORD).

Редактирование application logs не управляет PostgreSQL stderr. При стандартной verbosity ошибка уникальности email сотрудника может содержать DETAIL со значением email. Bootstrap сначала проверяет отсутствие роли, затем отдельным запросом создаёт её: параллельная provisioning-команда может создать роль между этими запросами. Ошибка второго CREATE ROLE записывает statement; сформированный statement содержит пароль роли в открытом виде. SQL quoting здесь корректен, замечание относится к логированию, а не injection. Динамический container-log PoC reviewer не выполнял, поэтому точный вывод конкретного image требуется подтвердить негативным тестом.

**Исправление:** явная privacy policy PostgreSQL, например terse errors, отключение error statement/parameter logging при сохранении error event/SQLSTATE и метрик; выделенное bootstrap connection с транзакцией/advisory lock и безопасными session logging settings. Не включать SQL debug в окружении с секретами/контактами.

**Регрессии:** синтетический duplicate staff email и конкурентный повтор bootstrap/ошибка создания роли; проверить реальные PostgreSQL container logs на отсутствие synthetic email marker и role-password marker. Проверять и upstream DB logging, и generic application response. Передано владельцу немедленно.

### Промежуточная проверка исправлений новых инструментов

Повторное чтение source подтвердило добавление HMAC полного backup manifest, prefix digest и mirrored registry; directory fsync backup и экспортированного snapshot для pg_dump; общей writer lock для initialize/reconcile/register; mode/identity guard перед Docker; отдельного rotation service и узких column GRANT для row locks. Это **source evidence**, а не результат Linux/PG/failure-injection тестов. Реальные прогон и итоговые статусы должен приложить владелец общего этапа.

Дополнительная граница restore: свежий target остаётся закрытым для runtime до завершения replay. Перед переключением на восстановленную БД нужно остановить erasure writers и повторно сверить/применить актуальный ledger под координацией: удаление, закоммиченное в live БД после snapshot replay, иначе может отсутствовать в восстановленной копии. Сам `restore_completed` не разрешает автоматическое переключение трафика.

### H-13. Восстановление backup может вернуть отозванные сессии и старые полномочия

**Уровень:** High при активации восстановленной БД; текущая изоляция target предотвращает непосредственную внешнюю эксплуатацию. **Места при обнаружении:** `infra/ops/backup.mjs:197–202` (replay только deletion ledger перед restore_completed), таблицы staff_users/staff_sessions в полном dump.

Конкретный сценарий: создать backup с действующей staff session → отозвать session и заблокировать/понизить сотрудника либо сменить его пароль → восстановить backup → выдать приложению доступ к восстановленной БД. Старый cookie снова совпадёт с восстановленным session hash; состояние роли/active/credentials также вернётся к моменту backup. Даже удаление session rows не устраняет откат полномочий и credentials в staff_users. Это обычное свойство rollback, которое требует явной защитной политики восстановления. На момент обнаружения runtime не имеет CONNECT к target; замечание касается безопасного завершения/cutover, а не обхода имеющейся изоляции.

**Исправление:** безусловно удалить все восстановленные staff_sessions, карантинировать восстановленные staff identities (например, isActive=false) и требовать offline operator восстановления проверенного доступа перед включением приложения. Альтернатива — аутентифицированное актуальное согласование staff state из доверенного источника с сохранением всех revocations. Нельзя считать backup старых credentials источником актуальных полномочий.

**Регрессии:** backup до revoke/block/demotion/password change → restore/finalize → прежний cookie даёт 401, прежняя учётная запись остаётся недоступной до offline восстановления. Положительный вход восстановленного оператором ADMIN с новым MFA проходит. Test fixture, ротирующий MFA до backup и потому уже имеющий ноль sessions, не воспроизводит исходный риск. Передано владельцу немедленно.

### L-14. Сохранившиеся HTML-маршруты публикуют снятый каталог

**Уровень:** Low, корректность публичного каталога/цен. **Места:** `infra/ops/assets.mjs`, `apps/web/scripts/prerender.mjs:63–134`, `infra/Caddyfile.site` try_files.

Новый immutable asset source устраняет сохранение старого bundle, но named volume продолжает содержать HTML routes старых докторов/услуг. Prerender публикует текущие маршруты, не удаляя прежние slug directories. После деактивации или смены slug прямой URL/поисковик может получать старые SSR имя/цену; последующая клиентская hydration не устраняет ошибку отдаваемого документа.

**Исправление/регрессия:** сохранять старые hashed assets для открытых страниц, но управлять HTML по текущему route manifest: убрать либо заменить 404 для более не существующих routes; проверить активный slug → деактивация/rename → update → прямой старый URL не содержит прежнего SSR, новый работает. Замечание передано владельцу, runtime browser сценарий reviewer не запускал.

### Read-only checkpoint исправлений и restore/cutover

Следующее чтение source подтвердило разделение provisioner/restore от staff operator/backup по superuser mounts, PostgreSQL terse/no-statement/no-parameter configuration, dedicated bootstrap transaction + advisory, immutable `/opt/clinic-web` source и вызов assets при rollback, пропуск уже активной MFA v2, clinic activation с consent hash и runtime проверкой известных demo catalogue/staff. Новые `infra/tests/ops-fixture.mjs` и `ops-restore.mjs` содержат положительные проверки реальных least-role business paths и негативные сценарии восстановления; их выполнение относится к общему прогону root.

Конкретная безопасная граница cutover предложена владельцу: единая registry lock для полного anonymize (повторная проверка eligibility → durable register → erase COMMIT), отдельный явный finalize-restore, блокирующий новые и завершающий старые подключения source, финальный replay актуального ledger и проверка целостности target, карантин staff/удаление sessions, узкие target GRANT и durable authenticated checkpoint. Target остаётся закрытым при любой ошибке. После release старый anonymize обязан заново проверять source до регистрации intent; только lock вокруг replay без source fencing и без полной координации writers недостаточен. Это предложение инструмента, а не утверждение, что cutover уже реализован или выполнен.

### H-15. Restore не сохраняет отзыв согласия, не дошедший до anonymize

**Уровень:** High для privacy state при активации восстановленной БД. **Места при обнаружении:** `apps/api/src/modules/booking/http-service.ts:355–379` (withdrawal сохраняется в БД), `infra/ops/maintenance.mjs:84–144` (durable ledger создаётся только при одобренном anonymize), `infra/ops/backup.mjs` replay/finalize.

Воспроизводимое чередование: backup активной записи → staff регистрирует проверенный отзыв согласия → erasure ещё не разрешена политикой и anonymize не выполняется → restore/finalize backup. Внешний ledger не содержит withdrawal; восстановленный appointment_consent вновь имеет withdrawn_at=NULL. Положительный erasure drill не покрывает этот случай, потому что в нём запись уже включена в журнал удаления.

**Исправление:** отдельный durable authenticated withdrawal intent с идемпотентным replay либо явное privacy quarantine восстановленных данных до согласования актуального withdrawal state. Не подменять неизвестный статус фиктивным утверждением, что пациент отозвал согласие, и не выполнять неразрешённую erasure. При восстановлении после полного отказа источником актуального состояния должен быть независимый журнал; только чтение live БД перед cutover не решает disaster recovery.

**Регрессия:** backup → withdraw при withdrawalErasureApproved=false → restore/finalize → прежний статус согласия не становится действующим автоматически; соответствующее ограничение доступа/withdrawal сохраняется. Передано владельцу, динамический PoC reviewer не выполнял.

### M-16. Новый public SSR обходит лимиты API и занимает общий pool

**Уровень:** Medium, доступность. **Места при обнаружении:** `apps/api/src/app.ts:71–74`, `apps/api/src/modules/site/service.ts` pagination/render, `infra/Caddyfile.site` public reverse_proxy.

Каждый известный публичный HTML-маршрут загружает весь каталог докторов и услуг (до 100 страниц по 100 строк каждого типа) и синхронно рендерит React. HTML-route находится за пределами securityRouter/catalog read rate limits. Анонимный поток обычных GET /ru или /kk может расходовать общий PostgreSQL pool и CPU, задерживая auth/booking; static asset cache этот путь не защищает.

**Исправление:** HTML limiter до catalog reads, ограничение числа concurrent SSR, bounded public snapshot/page cache с корректной инвалидизацией изменений каталога. Неизвестные slug не должны создавать бесконтрольный дорогостоящий scan. Backend остаётся окончательным источником доступности и цены.

**Регрессии:** превышение HTML quota даёт 429 до вызова catalogue; параллельные SSR ограничены, сервис восстанавливается после завершения/ошибки; изменение каталога/деактивация по-прежнему немедленно видимы; auth/readiness не голодают при ограниченном HTML потоке. Нагрузочный тест этим reviewer не запускался.

### Финальный read-only remediation checkpoint

В последнем прочитанном дереве подтверждены source-исправления M-01/M-02/L-01, H-04, H-05, M-06–M-10, H-11, M-12, H-13 и L-14. Для L-14 вместо сохранения статических HTML бизнес-страниц proxy теперь использует React SSR с актуальными public DTO; это привело к отдельно указанному M-16. Registry signing key rotation сохраняет immutable entries/prefix; backup manifest содержит key version и позволяет чтение старого архива при новой active key. Старые ledger entry keys намеренно необходимы до окончания срока существования соответствующих записей/backup; signing rotation не означает возможность их удаления.

Теперь `finalizeRestore` фактически держит общий registry lock, блокирует подключения source, завершает существующие source sessions, повторно применяет актуальный ledger, очищает restored sessions и отключает credentials всех восстановленных сотрудников, применяет узкие права, сохраняет подписанный receipt и только затем выдаёт CONNECT target. `anonymize` держит тот же lock через eligibility/register/erase. Ранее описанная гонка между erasure и cutover этим протоколом закрыта по source review. Source не возвращается автоматически в работу при ошибке; это fail-closed с отдельной процедурой восстановления, а не обещание отсутствия простоя.

По сообщению владельца этапа выполнены 84 PostgreSQL integration, 47 unit, 26 existing E2E, 4 HTTPS E2E, ops restore drill с 27 assertions. Reviewer прочитал новые тесты и реализацию, но сам эти прогоны не запускал и не присваивает их результат независимому запуску. Источник окончательных stdout/artifacts и результатов последующих исправлений — общий stage-7 отчёт. На момент этого checkpoint H-15 и M-16 переданы владельцу и требуют решения/регрессий; изменения, появившиеся после чтения, автоматически проверенными не считаются.

### H-17. Privacy cursor не аутентифицирует идентичность БД

**Уровень:** High в модели нарушения целостности operational storage без знания signing key. **Место при обнаружении:** `infra/ops/reconcile-privacy.mjs`, построение имени applied-файла и валидация signed cursor.

Имя файла содержит hash имени/OID текущей БД, но подписанный payload содержит только keyVersion, ledgerId, count и prefix. Владелец записи в primary ledger directory может скопировать валидный cursor другой БД, где все entries уже применены, в вычисленный applied-путь БД, где операции ещё не применялись. Подпись и prefix останутся корректными; reconciler пропустит соответствующие withdrawal/erasure. Для атаки не требуется изменение registry, checkpoint или знание MAC key: имя файла не является аутентифицированной частью состояния.

**Исправление:** включить databaseName/databaseOid (при необходимости instance/cluster identity) в подписанный payload и сравнивать с фактическим identity перед использованием count. При несовпадении отклонять cursor либо выполнять полный идемпотентный replay. Предполагается поддерживаемый restore в новую БД с новым OID; физический rollback с сохранением имени/OID требует отдельной epoch/reset процедуры.

**Регрессия:** две собственные synthetic БД с одним ledger: A уже reconciled, B ещё нет; копировать signed cursor A в путь B, затем B не должна пропустить операции. Передано владельцу немедленно. Reviewer не выполнял файловые/SQL мутации для эксплуатации.

### Дополнительный checkpoint H-15/M-16

Новый withdrawal journal рассмотрен по реальному коду: production startup требует adapter и проверку ledger; router проверяет CSRF/текущего ADMIN до получения file lock, затем под lock повторно проверяет session/ADMIN в auth-транзакции. Durable intent записывается только после проверки версии, doctor/service/appointment locks и существующего consent, до SQL/audit commit. AsyncLocalStorage требует контекста lock. Replay отличает WITHDRAWAL от approved erasure и сохраняет контакты при простом отзыве; этим исходный H-15 исправлен по source. Атомарность DB+файла намеренно fail-closed: одобренное намерение остаётся для replay при последующем SQL rollback. Право, подтверждение идентификации и неизменность documentId проверяются до этого намерения.

Граф блокировок не обнаружил нового цикла: withdrawal/reconcile/anonymize идут file lock → DB; HTTP preflight завершает транзакцию до ожидания file lock; остальные mutating DB-пути file lock не запрашивают. Maintenance сохраняет doctor → service → appointment/consent order. Финальный cutover использует ту же file lock. Вывод относится к рассмотренным call sites, а не к будущим расширениям.

M-16 также исправлен по source: максимум четыре HTML render до запроса к БД, отдельная IP quota, короткий coalesced public snapshot cache; успешные mutations каталога инвалидируют cache. Ошибка освобождает render counter в finally. Кеш содержит только public DTO. Межпроцессная рассинхронизация ограничена коротким TTL; это не замена проверки цены/слота backend. Результаты новых негативных PG/HTTP/restore тестов остаются за общим runner. Открытым в этом чтении остаётся H-17 до подтверждения исправления; повторная source-проверка последующих изменений обязательна.

### Завершение read-only проверки, 07.11.2026

H-17 исправлен: payload cursor содержит identity, подпись покрывает name/OID, а reconciler сверяет обе величины с PostgreSQL до применения count. В `infra/tests/ops-restore.mjs` проверяется перенос подписанного cursor между двумя собственными synthetic БД и отказ до пропуска операций. В withdrawal intent добавлены проверенные actorId/requestId и explicit field allowlist; replay сохраняет доступную атрибуцию. `reconcileLedger` теперь fsync выполняет и для восстановленных encrypted entry-файлов до публикации registry.

Файл `.tmp/ops-last-result.json` непосредственно прочитан reviewer: completedAt `2026-11-06T18:58:54.377Z`, 34 restore assertions, 7 отрицательных проверок прав, ротация 5 contact ciphertext / 1 MFA, postgresLogsRedacted=true. Это сохранённый результат общего runner, не повторный независимый запуск. Source проверок содержит durable withdrawal → принудительный SQL rollback → maintenance reconciliation без erasure approval → restore/finalize с сохранением withdrawnAt и контактов, quarantine credentials, пустые sessions, закрытый target до finalize и source fencing. Владелец также сообщил о 86 integration и 50 unit; итоговый stage-7 отчёт должен сохранять фактические полные результаты и результаты последующих изменений.

Новый onboarding guard рассмотрен отдельно: catalogueReviewed=false разрешает запуск admin setup с пустым каталогом, но сервер запрещает online create, issue consent code и manual create до потребления кода/записи; публичный bookingEnabled передаётся UI. Успешное закрытие этого изменения требует отдельной регрессии gate и итоговых typecheck/contract checks владельца: незавершённые правки после чтения reviewer автоматически проверенными не считаются.

**Актуальный результат в рассмотренном дереве:** прежние подтверждённые Critical/High не остаются открытыми; подтверждённого нового Critical/High в проверенных withdrawal/restore/ledger/cursor/keyring/runtime-role путях не выявлено. Это условное техническое заключение по source и указанным artifacts, а не разрешение production-релиза или заявление об отсутствии любых уязвимостей.

Остаточные технические ограничения: доверенная независимость checkpoint/backup storage и ключевой escrow проверяются на конкретном сервере; одновременный rollback всех доверенных копий без внешнего anchor не обнаруживается одной MAC; старые entry/backup keys нельзя удалять только по факту переключения active signing key. Поддерживаемый restore создаёт новую БД; физический rollback с сохранением DB name/OID требует reset/epoch процедуры для cursor. После аварии stale registry.lock восстанавливается контролируемо. Cutover сохраняет finalized receipt до GRANT CONNECT: авария между этими шагами остаётся fail-closed и требует проверенной resume-процедуры либо нового restore target с повторным replay/проверками; нельзя просто вручную открыть доступ, минуя replay/quarantine. Указанные операционные границы переданы владельцу для runbook и приёмки.
