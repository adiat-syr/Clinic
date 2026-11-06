# Приёмка перед реальным запуском

07.11.2026. Техническая реализация и synthetic проверки — STAGE-7-REPORT.md. Настоящий production-релиз не выполнялся. Здесь внешние эксплуатационные условия. Правовые вопросы не дублируются: **единственный реестр — LEGAL-REVIEW-REQUIRED.md**.

| Область          | Реализовано и проверено локально                                                                        | Что принять на целевой площадке                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Секреты          | *_FILE, keyrings, startup validation, private mounts                                                    | Права Linux файлов, escrow/доступ, защита хоста и смена ключей ответственными                                                 |
| PostgreSQL18.6   | Private network, отдельные роли/GRANT, startup rejects superuser/owner/membership; семь negative checks | Firewall/host access, диск/патчи; app не superuser                                                                            |
| HTTPS            | Caddy, точный proxyIP, headers, Secure HttpOnly cookie, CSRF; realTLS browser                           | Реальный домен/DNS/ACME renewal, firewall80/443, trusted topology, NTP                                                        |
| Backup/restore   | Две encrypted копии, MAC manifest+checkpoint, tested restore/cutover/privacy replay/quarantine          | Независимые носители/площадки, off-host mounts, escrow keys, rollback protection checkpoint, RPO/RTO и регулярный drill       |
| Retention        | Disabled-by-default policy, cleanup/contact erasure, durable withdrawal/deletion replay                 | Внести утверждённые сроки/holds, проверить связь restore и последующих privacy events; основания только в юридическом реестре |
| Сотрудники       | MFA обеих ролей, реальный Linux privatePTY без эха, revocation/rotation/quarantine                      | Проверка людей/полномочий, физический Authenticator и custody, onboarding/offboarding, разделение operator/staff              |
| Мониторинг       | API/PG/TLS/backup/ledger/privacy/PENDING/auth, status+exit2, heartbeat, systemd templates               | Доставка тревог, независимый host availability/disk monitor, установленный supervisor; отказ хоста не заметит процесс на нём  |
| Нагрузка         | Ограниченные pools/SSR/rate,20concurrentbooking PG tests                                                | Реальный профиль клиники/capacity/SLO; малый drill не доказывает DDoS устойчивость                                            |
| Контент          | RU/KK, бренд/зона, booking gate доcatalogueReviewed, synthetic default                                  | Каталог/цены/расписание/мобильная приёмка, trusted assets, отсутствие synthetic в clinic instance                             |
| Правовая приёмка | Технические механизмы не названы сертификацией                                                          | Решения LEGAL-REVIEW-REQUIRED.md и явная activation; программа не принимает их за клинику                                     |
| Релиз            | Build/update/migrate/совместимый rollback, runbooks/CI                                                  | Отдельное разрешение, pin всех image digests, remoteCI, передача доступа ответственным                                        |

До приёмки использовать synthetic demo/tests. Продукт не объявляется автоматически допущенным к реальным данным.
