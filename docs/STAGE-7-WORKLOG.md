# Этап 7 — техническое завершение (результаты в STAGE-7-REPORT.md)

Разрешение пользователя 06.11.2026: реализовать техническую часть полностью; реальный production-релиз и реальные пациенты не разрешены. Исходное рабочее дерево сохранено коммитом `04becdb` на `codex/stage-7` (этап 6: `e0424ec`). Юридические вопросы ведутся только в LEGAL-REVIEW-REQUIRED.md.

- [x] Проверить Git и сохранить предшествующее дополнение MVP/CLI.
- [x] Проверить фактические пробелы: нет production Compose, ролей PG, jobs cleanup/rotation/backup/restore.
- [x] Установить lockfile dependencies, исследовать advisory и выполнить security review.
- [x] Production/staging Docker, TLS proxy, secrets, fail-closed конфигурация и startup checks.
- [x] Реальные роли PostgreSQL и отрицательные тесты runtime privileges.
- [x] Конфигурация конкретной клиники, отдельный synthetic demo, без мультитенантности.
- [x] Ротация MFA/контактных ключей, cleanup, разрешённое policy-based обезличивание, deletion ledger и восстановление.
- [x] Зашифрованный backup/планировщик/rotation/restore с реальным синтетическим drill.
- [x] Мониторинг и runbooks: availability/PG/backup/pending/auth/certificates, без внешней PII telemetry.
- [x] UI/actions RU/KK, production HTTPS browser smoke, desktop/mobile, concurrency и regressions.
- [x] Официальные НПА/даты/incident deadlines в едином юридическом файле.
- [x] Финальные проверки, фактический отчёт и фиксация результата; без production release.

Первый npm ci получил EPERM при запущенном Vite; процессы только этого checkout остановлены, повторные npm ci прошли. Итоговые фактические результаты и внешние границы — STAGE-7-REPORT.md и STAGE-7-BLOCKERS.md. Настоящий production не запускался.
