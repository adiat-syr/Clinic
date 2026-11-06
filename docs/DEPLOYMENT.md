# Развёртывание отдельного экземпляра

Стек и рабочие сценарии сохраняются. В этапе 7 проверялся только локальный synthetic staging в Linux-контейнерах Docker Desktop. Настоящий production-релиз не выполнялся. Внешняя приёмка — STAGE-7-BLOCKERS.md; все правовые вопросы — только LEGAL-REVIEW-REQUIRED.md.

## Подготовка сервера

Нужны поддерживаемый Linux x86_64, Docker Engine с Compose v2/BuildKit (поддержка `additional_contexts` нужна тестовому target), Node.js 24.x/npm 11.x для управляющих скриптов, git, openssl, curl, точное время/NTP. Приложение и PostgreSQL запускаются контейнерами; Node/npm на хосте нужны для prepare/deploy. Установка Docker/Node выполняется по официальным инструкциям выбранной ОС. Docker socket даёт административные права хоста: deployment user не должен быть обычным сотрудником клиники.

Создать отдельного непривилегированного deployment user, checkout в `/opt/clinic/app`, приватный каталог `/srv/clinic` с владельцем deployment user и mode 0700. Не размещать production secrets в OneDrive/общем checkout. На firewall открыть только 80/443 и ограниченный административный SSH; 5432 и 3001 не публикуются. Выбрать непересекающуюся Docker subnet. Ограничить доступ к Docker/backup/секретам. Зарезервировать место для БД, временного plaintext restore и двух encrypted копий; restore tmpfs по умолчанию 1 GiB, увеличить по фактическому размеру dump.

Для реального сервера заранее подключить независимые защищённые хранилища BACKUP_DIR/SECONDARY_BACKUP_DIR и LEDGER_DIR/LEDGER_CHECKPOINT_DIR. Разные каталоги на одном ноутбуке проверяют код, но не защищают от потери диска. Ключи хранить и резервировать отдельно; потерянный ключ делает архив невосстановимым. Требования к размещению см. единый юридический файл.

## Проверенный synthetic staging

Из корня checkout:

```sh
npm ci
node infra/prepare.mjs demo-clinic staging
node infra/deploy.mjs demo-clinic build staging
```

Prepare отказывается перезаписывать существующий экземпляр. Генерирует разные случайные пароли ролей и ключи в `.deploy/demo-clinic/secrets`, а не рабочие значения в Git. Секреты не выводятся. В приватном `.deploy/demo-clinic/compose.env` для демо установить `ALLOW_DEMO_SEED=yes`, затем:

```sh
node infra/deploy.mjs demo-clinic up staging
node infra/deploy.mjs demo-clinic staff staging bootstrap
node infra/deploy.mjs demo-clinic status staging
node infra/deploy.mjs demo-clinic monitor staging
```

Сайт `https://clinic.localhost:8443`, админка `/admin`; redirect с loopback8080. Internal CA экспортируется **только публичным сертификатом** в `.deploy/demo-clinic/tls/root.crt`. Приватный ключ CA не передаётся API/scheduler. Для интерактивного просмотра можно доверить этот CA только своей тестовой системе; не отключать TLS-проверку глобально. HTTPS runner самостоятельно проверяет chain/hostname/redirect, затем использует browser exception только для этого локального адреса. Не устанавливать тестовый CA на чужие компьютеры.

Seed создаёт вымышленный каталог, текст согласия и интервалы на актуальную следующую дату, без пароля сотрудника. После seed вернуть `ALLOW_DEMO_SEED=no`, чтобы update не менял демо-расписание. ADMIN создаётся в приватной TTY с уникальным паролем/собственным offline TOTP; после процедуры дождаться следующего кода. Пример демо: выбрать услугу/врача/дату, создать PENDING, войти с MFA, подтвердить, перенести/отменить, проверить изменение свободного времени. Все операции идут в настоящую PostgreSQL. Тестовые runner используют отдельные собственные БД.

## Конфигурация конкретной клиники

`node infra/prepare.mjs clinic-name production` **подготавливает файлы**, не выполняет релиз. На Linux корень `/srv/clinic`, переопределение `CLINIC_DEPLOY_ROOT`. В `compose.env`: домен, HTTPS origin без path, ACME email, IANA timeZone, непривилегированные UID/GID, subnet/proxy IP, image references, recovery paths, DATA_MODE. Заглушки домена/контакта, UID0 и одинаковые recovery paths отклоняются deploy. Домен должен указывать на сервер, 80/443 доступны ACME; Caddy получает и обновляет публичные сертификаты автоматически. Реальный ACME challenge не выполнялся без домена.

`config/clinic.json` — строгий двуязычный профиль по `infra/clinic.demo.json`: название, адрес, часы, контакты, лицензия, краткое privacy-уведомление, IANA zone, synthetic. Локальный логотип положить в `apps/web/public/assets/clinic/`, задать `/assets/clinic/name.svg|png|webp`, затем пересобрать образ; SVG — только доверенный reviewed asset. Врачей/услуги/цены/назначения/расписание вести через админку; не через HTML Stitch. Согласие публикуется CLI, immutable версия и hash сохраняются.

Clinic mode требует `config/activation.json` с `approved:true`, совпадающим `clinicName` (RU), `decisionReference`, ISO `decidedAt`, `phoneConsentApproved`, `consentContentSha256` (64 hex), `catalogueReviewed`. Программа проверяет формат и привязку, но не удостоверяет полномочия автора файла. До готовности каталога оставить `catalogueReviewed:false`: админка работает, online/code/manual create сервером закрыты. После публикации утверждённого согласия и проверки каталога установить true, перезапустить API и обновить snapshot. Активные synthetic-slug сущности, synthetic consent и staff@example.invalid в clinic mode запрещены. Файл активации/phone flag не заменяет внешнее решение из юридического реестра.

Публикация документа: положить JSON `{version,textRu,textKk}` в приватный config и выполнить `node infra/deploy.mjs INSTANCE consent-publish MODE /run/config/consent.json`; использовать stdout hash для activation. Секреты/контакты в этот файл не добавлять. Технический запуск production требует явного `RELEASE_APPROVAL=I_APPROVE_PRODUCTION_RELEASE` в окружении управляющего процесса; в этом задании он не устанавливался.

## Обновление, миграции и откат

Сохранять release image digest всех четырёх targets (API/web/operator/tools), commit и проверенный backup. `build` собирает образы; `update` создаёт backup **до миграций**, применяет только migrate deploy, GRANT, публикует assets и ждёт readiness. Перед миграциями оценить совместимость со старым приложением; не менять применённые SQL. Для миграций при остановленном трафике есть отдельная команда `migrate`. Секреты и DB volumes не пересоздаются. Compose по умолчанию использует local tags; на сервере фиксировать уникальные release tags/digests в compose.env.

```sh
node infra/deploy.mjs INSTANCE build MODE
node infra/deploy.mjs INSTANCE update MODE
node infra/deploy.mjs INSTANCE status MODE
node infra/deploy.mjs INSTANCE logs MODE
```

Откат приложения: задать в окружении `API_IMAGE` и `WEB_IMAGE` прежними проверенными digest, выполнить `node infra/deploy.mjs INSTANCE rollback MODE`. Команда требует локально доступные образы с privacy protocol label2, публикует соответствующие assets и запускает API/web с `--no-build`. Автоматического downgrade БД нет. Не откатывать на Stage6/образ без durable journal: он может потерять требования об удалении/отзыве. Operator/tools должны оставаться совместимыми с текущей схемой и журналом. При несовместимой миграции нужен отдельный forward fix либо контролируемое восстановление по OPERATIONS.md.

Compose restart `unless-stopped`, API SIGTERM закрывает HTTP/Prisma за25сек, grace30сек. Health ready проверяетPG; startup проверяет18.6, exclusions, минимальные runtime privileges, profile/secrets/journal. Readiness не гарантирует актуальность backup: это отдельный monitor. После OS reboot Docker должен стартовать системной службой, mount recovery storage — до контейнеров. Не применять `down -v` и не удалять существующие базы/тома.

Deploy mutations и HTTPS fixture driver используют приватный `operation.lock` одного экземпляра: update/rollback/restore/тестовое переключение API нельзя запускать одновременно. При занятом lock команда отказывает до изменения контейнеров. После аварийного завершения проверить отсутствие управляющего процесса и запущенных им Docker operations, состояние instance и только затем снять конкретный stale operation.lock; автоматического снятия по возрасту нет. Status/logs/monitor/read-only backup не переключают API. Прямые команды Docker в обход управляющего скрипта остаются ответственностью оператора.
