import { translate as t, adminHref, adminLocale } from './i18n';
import { useEffect, useState, useRef, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { adminRequest, identitySchema, message, type Identity } from './api';
import { Appointments } from './Appointments';
import { Schedule } from './Schedule';
import { Catalog } from './Catalog';
import { Staff } from './Staff';
import { Audit } from './Audit';
import './admin.css';
function Login({ onLogin }: { onLogin: (me: Identity) => void }) {
  const [challenge, setChallenge] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!challenge) {
        await adminRequest('/auth/login', 'POST', { email, password });
        setPassword('');
        setChallenge(true);
      } else {
        await adminRequest('/auth/mfa/verify', 'POST', { code });
        setCode('');
        onLogin(identitySchema.parse(await adminRequest('/auth/me')));
      }
    } catch (e) {
      setError(message(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-login">
      <a className="brand" href={'/' + adminLocale()}>
        ✚ ALATAU CLINIC
      </a>
      <form className="panel" onSubmit={submit}>
        <span className="badge">{t('Рабочее пространство')}</span>
        <h1>{challenge ? t('Подтверждение MFA') : t('Вход сотрудника')}</h1>
        <p>{t('Только уполномоченные сотрудники. Синтетическая среда.')}</p>
        {challenge ? (
          <>
            <label>
              {t('Код MFA')}
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <p>
              {t(
                'Введите новый 6-значный код из Authenticator. Уже использованный код не принимается.',
              )}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setChallenge(false);
                setCode('');
                setError('');
              }}
            >
              {t('Начать вход заново')}
            </button>
          </>
        ) : (
          <>
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              {t('Пароль')}
              <input
                type="password"
                autoComplete="current-password"
                maxLength={128}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="button wide" disabled={busy}>
          {busy ? t('Проверяем…') : challenge ? t('Подтвердить MFA') : t('Войти')}
        </button>
        <p>
          {t(
            'Первый ADMIN и восстановление пароля/MFA — через защищённую CLI оператора, без стандартных паролей.',
          )}
        </p>
      </form>
    </main>
  );
}
function Profile({ expire }: { expire: () => void }) {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      className="panel admin-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void adminRequest('/auth/password', 'POST', { currentPassword: current, newPassword: next })
          .then(expire)
          .catch((e) => setError(message(e)))
          .finally(() => {
            setCurrent('');
            setNext('');
            setBusy(false);
          });
      }}
    >
      <h1>{t('Смена пароля')}</h1>
      <p>{t('Все ваши сессии будут отозваны. Новый пароль: 16–128 символов.')}</p>
      <label>
        {t('Текущий пароль')}
        <input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label>
        {t('Новый пароль')}
        <input
          type="password"
          autoComplete="new-password"
          minLength={16}
          maxLength={128}
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="button" disabled={busy}>
        {t('Сменить пароль и выйти')}
      </button>
    </form>
  );
}
export default function Admin() {
  const authRevision = useRef(0);
  const [client] = useState(
      () =>
        new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } }),
    ),
    [me, setMe] = useState<Identity | null>(null),
    [checking, setChecking] = useState(true),
    [notice, setNotice] = useState(''),
    [visible, setVisible] = useState(true);
  const section = location.pathname.split('/')[2] || 'appointments';
  function expire() {
    authRevision.current++;
    client.clear();
    setMe(null);
    setChecking(false);
    setNotice(t('Сессия завершена. Войдите заново.'));
  }
  useEffect(() => {
    let active = true;
    async function check() {
      const revision = authRevision.current;
      try {
        const identity = identitySchema.parse(await adminRequest('/auth/me'));
        if (active && revision === authRevision.current) {
          setMe(identity);
          setNotice('');
        }
      } catch {
        if (active && revision === authRevision.current) {
          client.clear();
          setMe(null);
        }
      } finally {
        if (active) setChecking(false);
      }
    }
    void check();
    const expired = () => {
      authRevision.current++;
      client.clear();
      setMe(null);
      setChecking(false);
      setNotice(t('Сессия истекла или доступ изменён. Войдите заново.'));
    };
    const visibility = () => {
      setVisible(!document.hidden);
      client.clear();
      if (!document.hidden) {
        setChecking(true);
        void check();
      }
    };
    const timer = setInterval(() => void check(), 60000);
    const hide = () => {
      authRevision.current++;
      client.clear();
      setMe(null);
      setChecking(true);
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setChecking(true);
        void check();
      }
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    window.addEventListener('clinic-session-expired', expired);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('clinic-session-expired', expired);
      document.removeEventListener('visibilitychange', visibility);
      client.clear();
    };
  }, [client]);
  if (checking)
    return (
      <main className="admin-login">
        <p role="status">{t('Проверяем сессию…')}</p>
      </main>
    );
  if (!me)
    return (
      <>
        {notice && (
          <p role="status" className="admin-notice">
            {notice}
          </p>
        )}
        <Login
          onLogin={(identity) => {
            authRevision.current++;
            client.clear();
            setMe(identity);
            setNotice('');
          }}
        />
      </>
    );
  const admin = me.role === 'ADMIN',
    restricted = ['doctors', 'services', 'staff', 'audit'].includes(section),
    allowed = [
      'appointments',
      'schedule',
      'profile',
      ...(admin ? ['doctors', 'services', 'staff', 'audit'] : []),
    ];
  const menu = [
    ['appointments', t('Записи на приём')],
    ['schedule', t('Календарь врачей')],
    ...(admin
      ? [
          ['doctors', t('Врачи клиники')],
          ['services', t('Услуги и цены')],
          ['staff', t('Сотрудники')],
          ['audit', t('Аудит')],
        ]
      : []),
    ['profile', t('Мой пароль')],
  ];
  return (
    <QueryClientProvider client={client}>
      <div className="admin-shell">
        <header className="admin-header">
          <a className="brand" href={adminHref('/admin')}>
            ✚ Alatau Clinic <small>{t('Регистратура')}</small>
          </a>
          <span className="badge">{t('Синтетическая среда · Asia/Almaty')}</span>
          <span>
            {me.email} · {me.role}
          </span>
          <button
            onClick={() => {
              void adminRequest('/auth/logout', 'POST', {})
                .then(() => expire())
                .catch(() => {
                  expire();
                  setNotice(
                    t(
                      'Не удалось подтвердить выход на сервере. Повторите выход после восстановления связи.',
                    ),
                  );
                });
            }}
          >
            {t('Выйти')}
          </button>
        </header>
        <aside className="admin-nav">
          <p>{t('МЕНЮ КЛИНИКИ')}</p>
          <nav>
            {menu.map(([path, label]) => (
              <a
                key={path}
                href={adminHref('/admin/' + path)}
                aria-current={section === path ? 'page' : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
          <a href={'/' + adminLocale()}>{t('Открыть клиентский сайт')}</a>
        </aside>
        <main className="admin-content">
          {!visible ? (
            <p>{t('Экран скрыт до повторной проверки сессии.')}</p>
          ) : restricted && !admin ? (
            <section className="panel">
              <h1>{t('Недостаточно прав')}</h1>
              <p>{t('Эта операция доступна только ADMIN.')}</p>
            </section>
          ) : !allowed.includes(section) ? (
            <h1>{t('Страница не найдена')}</h1>
          ) : section === 'appointments' ? (
            <Appointments admin={admin} />
          ) : section === 'schedule' ? (
            <Schedule />
          ) : section === 'profile' ? (
            <Profile expire={expire} />
          ) : section === 'staff' ? (
            <Staff me={me} />
          ) : section === 'audit' ? (
            <Audit />
          ) : (
            <Catalog kind={section === 'doctors' ? 'doctors' : 'services'} />
          )}
        </main>
      </div>
    </QueryClientProvider>
  );
}
