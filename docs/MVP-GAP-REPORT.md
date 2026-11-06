# Результаты согласованного дополнения MVP перед этапом 7

База — этап 6 (`e0424ec`). Выполнено согласованное пользователем дополнение: gap-analysis, самостоятельное цифровое согласие с одноразовым кодом, дополнительная запись сотрудником, KK staff UI и регрессии доступа. **Коммерческая готовность не заявляется. Этап 7/production и реальные пациенты не запускались.**

## Выявленные разрывы и решения

1. Ручная запись действительно отсутствовала в коде/OpenAPI и была явно отложена в TASKS. Пользователь разрешил новый ограниченный процесс; README/AGENTS/TASKS приведены в соответствие. Предварительное сопоставление — [MVP-GAP-ANALYSIS.md](MVP-GAP-ANALYSIS.md).
2. Согласие сотрудника нельзя считать действием посетителя. Пользователь выбрал отдельную самостоятельную RU/KK страницу, код на 5 минут, конкретную версию и одноразовое потребление. Согласованный процесс — [PHONE-BOOKING.md](PHONE-BOOKING.md). Сама законность такого способа не подтверждена.
3. RU-only admin противоречил общей двуязычной приёмке. Закрыта техническая локализация: словарь, переключатель, сохранение языка в native navigation, формы/ошибки/статусы/диалоги, названия KK из каталога, Intl даты. Профессиональная языковая вычитка остаётся открытой.
4. При проверке смены пароля обнаружен UI defect: LOGIN_FAILED из-за неверного текущего пароля ошибочно трактовался как истёкшая сессия. Теперь форма показывает ошибку и позволяет исправить ввод; настоящий UNAUTHORIZED продолжает очищать приватный экран. Backend-контроль не изменён.
5. Сохранялись незакоммиченные изменения предыдущих обращений: валидация CLI с безопасными подсказками, preflight email, восстановление первоначального ADMIN, смена email с аудитом/отзывом сессий и тестами. Они сохранены и включены в проверки; пользовательские аккаунты не переустанавливались этим заданием.

## Реализованный сценарий

Самостоятельная онлайн-запись `/ru/booking`, `/kk/booking` остаётся основной: публичные CTA и старый API сохранены, контакты и галочка не передаются от имени сотрудника. Дополнительные `/ru/phone-consent`, `/kk/phone-consent` доступны по ссылке в footer и инструкции сотрудника. Пациент читает опубликованный документ, вводит только синтетические имя/телефон, подтверждает отдельную непредустановленную галочку. До этого запись не создаётся.

Сервер выдаёт случайный 128-битный код один раз в no-store response. В PG только доменный SHA-256 хеш, версия документа/язык/время и зашифрованные контакты. Открытый код — только в памяти страницы/формы, без URL, localStorage/sessionStorage, audit или новых логов. Точный срок — 5 минут по серверным часам. Истечение и повторное потребление отклоняются сервером; изменение опубликованного документа требует нового согласия.

Сотрудник ADMIN/RECEPTIONIST выбирает услугу, врача, дату/свободный слот и вводит код. POST admin DTO не принимает contacts, accepted, acceptedAt, locale/document overrides или snapshots. Общий BookingService проверяет offer/полные интервалы/перерывы, блокирует doctor/service, проверяет и потребляет receipt под row lock. Приём PENDING, AppointmentConsent с исходным временем действия пациента, idempotency и audit сотрудника атомарны. Online и staff используют одну таблицу appointments и прежний exclusion constraint. Конфликт/rollback не расходует код.

Идентичный key+payload после потери ответа возвращает ранее закоммиченный результат, не создавая второй приём и не потребляя код повторно. Другой key для использованного кода отклоняется. Существующая public idempotency HMAC-структура сохранена для старых попыток. Перенос/отмена/версии и транзакционный протокол не заменены.

Миграция `20261105000200_patient_consent_receipts` добавляет четырнадцатую модель, FK/индексы/unique appointment, exact lifetime/consumption CHECK и immutable UPDATE trigger. Старые миграции не редактировались. В собственных test DB вся история применена с нуля и повторный deploy проверен; локальная `clinic_local` получила только `migrate deploy` без reset/truncate/seed. Рабочие записи и сотрудники не удалялись.

## Фактические проверки

| Проверка                                              | Итог                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run test:integration`                            | **82/82** на реальном PostgreSQL 18.6: 74 предшествующих теста плюс 8 новых сценариев согласия/ручной записи |
| `npx vitest run`                                      | **35/35** unit/HTTP/config/privacy/CLI + полнота и поведение RU/KK словаря                                   |
| `node --env-file-if-exists=.env scripts/test-web.mjs` | **26/26** Chromium: 17 staff и 9 public; реальный API/PG, без mock успехов                                   |
| `npm run typecheck`, `npm run lint`                   | Успешно; strict TS, без отключения правил                                                                    |
| `npm run db:validate`, `npm run db:check`             | Schema valid; PostgreSQL 18.6, btree_gist доступен                                                           |
| `npm run openapi:generate`, `npm run openapi:check`   | Новые strict DTO/endpoints отражены; контракт актуален                                                       |
| `npm run build`                                       | Contracts/API/web/SSR и 22 прежних public prerender маршрута из PostgreSQL — успешно                         |

Финальные format/smoke проверки выполнены перед фиксацией результата. Первая integration попытка дала 81 pass и падение исторического assertion «13 таблиц»; после актуализации на 14 весь набор прошёл. В первом browser прогоне 23/26 прошли: два падения из-за неоднозначного тестового status selector (успех и loading), третье выявило реальную ошибку обработки неверного текущего пароля. Все исправлены, полный повтор 26/26 успешен. Не выдаём эти первоначальные падения за успешные прогоны.

Новые PG-проверки: encrypted/bound proof, отсутствие согласия, CSRF/анонимный доступ, запрет выдачи из staff session и изменения контактов сотрудником, точная граница 5 минут, unknown/used code, устаревший документ, idempotent commit retry после expiry, rollback на занятом слоте, **20 одновременных ручных попыток + 1 online** с одним созданием, raw PG lifetime/FK/immutability/catalog assertions. Прежние 20 raw SQL race/exclusion тесты сохранены.

Проверка доступа охватывает ADMIN/RECEPTIONIST, password-only запрет, MFA/TOTP replay, cookie rotation/fixation, idle/absolute сроки, CSRF/Origin, 401/403, RBAC/mass assignment, пароль/роль/блокировку/отзыв сессий. Новый browser сценарий проверяет неверный текущий пароль, успешную смену и последующий 401. Наличие этих тестов не означает проведения полного security audit.

Новые browser проверки: самостоятельный RU код → RECEPTIONIST запись → запрет повторного кода; retry после реального commit/потери ответа; KK согласие → ADMIN каталог/диалог/календарь/сохранение языка, mobile 390 px; смена пароля. Сохранены 9 public тестов RU/KK, validation/consent/version/conflict/idempotency и 360/768/1440 px. Просмотрен `.tmp/admin-kk-mobile.png`; артефакты только синтетические и игнорируются Git. Safari/Firefox/физические устройства/полная ручная screen reader-приёмка не выполнялись.

## Изменённые файлы

- Backend: `apps/api/prisma/schema.prisma`, новая миграция; `modules/booking/input.ts`, `service.ts`, `http-service.ts`, `router.ts`; `middleware/errors.ts`; `scripts/booking-openapi.ts`; `docs/openapi.json`.
- Frontend: `apps/web/src/features/PatientConsent.tsx`, `app/App.tsx`, `app/StaffEntry.tsx`, `main.tsx`; `admin/i18n.ts`, `i18n.test.ts`, `Admin.tsx`, `Entry.tsx`, `Appointments.tsx`, `Catalog.tsx`, `Schedule.tsx`, `Staff.tsx`, `Audit.tsx`, `ui.tsx`, `api.ts`, `admin.css`.
- Проверки: `apps/api/tests/booking-http.integration.test.ts`, `booking.integration.test.ts`, `security.integration.test.ts`, `tests/web/admin.spec.ts`, `booking.spec.ts`, `vitest.config.ts`. Fixture truncation только в runner-owned DB учитывает новый FK.
- Сохранённые ранее CLI исправления: `apps/api/scripts/staff.ts`, `staff-input.ts`, `apps/api/src/modules/security/input.ts`, `service.ts`, `apps/api/tests/staff-input.test.ts`; scripts в root/API `package.json`.
- Документы: `README.md`, `AGENTS.md`, `TASKS.md`, `docs/ADMIN-GUIDE.md`, `AUTH.md`, `BOOKING-API.md`, `DATABASE.md`, `DESIGN-INTEGRATION.md`, примечание к историческому `STAGE-6-REPORT.md`; новые gap-analysis/report, `PHONE-BOOKING.md`, `STAGE-7-BLOCKERS.md`.

## Что не проверено и не закрыто

- Код подтверждает отдельное действие в анонимном интерфейсе, **не личность**. Staff API не позволяет подменить данные/согласие, а выдача из staff session блокируется. Сотрудника, использующего другой анонимный браузер, технически нельзя отличить от пациента. Это существенное ограничение доказательств и основание не допускать реальные данные без юридической/организационной приёмки. Подтверждение телефона, ЭЦП и внешние сервисы не подключены.
- Код на 5 минут не равен сроку хранения подтверждения. Автоматический purge receipts не реализован; нужны утверждённые сроки, jobs и согласованное удаление связанных строк/backups. Новые контакты в receipt шифруются, но это дополнительная копия PII, которую нельзя забыть в retention.
- Минимальные production GRANT, TLS/Secure cookie/proxy, keys rotation/storage, RPO/RTO и backup restore, incident response, нагрузка/DoS, зависимостный/security review и полный правовой анализ остаются незакрытыми. Тесты выполнялись под владельцем временной БД.
- Прочие прежние ограничения сохраняются: optimistic version есть у записей, не у окон расписания; зона согласована как Asia/Almaty; публичный chunk ~530 kB/gzip ~160 kB вызывает прежнее Vite предупреждение. Admin со словарём вынесен целиком в lazy entry ~93 kB/gzip ~21 kB, чтобы KK словарь не загружался посетителям. Phone-consent — React route с hosting fallback; не добавлен в публичный SEO prerender/sitemap, нет приватного содержимого в SEO.
- Полная профессиональная вычитка RU/KK, TTY и HTTPS приёмка и целевая инфраструктура в Казахстане не проверены.

Отдельный список обязательных условий — [STAGE-7-BLOCKERS.md](STAGE-7-BLOCKERS.md). **После этого дополнения работа останавливается. Production и использование с реальными пациентами не разрешены.**
