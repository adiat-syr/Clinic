import { useLoad } from './useLoad';
import { useState } from 'react';
import { adminRequest, staffSchema, pageSchema, message, type Identity } from './api';
import { LoadState, Pager, Confirm } from './ui';
export function Staff({ me }: { me: Identity }) {
  const [page, setPage] = useState(1),
    [email, setEmail] = useState(''),
    [role, setRole] = useState('RECEPTIONIST'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [command, setCommand] = useState<{
      id: string;
      action: string;
      value?: string | boolean;
    } | null>(null);
  const rows = useLoad(
    (signal) =>
      adminRequest(`/admin/staff?page=${page}&pageSize=20`, 'GET', undefined, signal).then((v) =>
        pageSchema(staffSchema).parse(v),
      ),
    ['staff', page],
  );
  return (
    <>
      <h1>Сотрудники и доступ</h1>
      <p>
        Новый аккаунт неактивен. Пароль и MFA выдаёт оператор через staff:credentials. HTTP не
        передаёт секреты.
      </p>
      <LoadState {...rows} retry={rows.refresh} />
      <section className="panel">
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Роль</th>
                <th>Доступ</th>
                <th>MFA</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.data?.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.email}
                    {s.id === me.id ? ' (вы)' : ''}
                  </td>
                  <td>
                    {s.role}
                    <button
                      onClick={() =>
                        setCommand({
                          id: s.id,
                          action: 'role',
                          value: s.role === 'ADMIN' ? 'RECEPTIONIST' : 'ADMIN',
                        })
                      }
                    >
                      Изменить роль
                    </button>
                  </td>
                  <td>{s.isActive ? 'Активен' : 'Заблокирован'}</td>
                  <td>{s.mfaEnabled ? 'Подключён' : 'Не выдан'}</td>
                  <td>
                    <button
                      onClick={() =>
                        setCommand({ id: s.id, action: 'isActive', value: !s.isActive })
                      }
                    >
                      {s.isActive ? 'Заблокировать' : 'Включить доступ'}
                    </button>
                    <button onClick={() => setCommand({ id: s.id, action: 'revoke' })}>
                      Отозвать сессии
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.data && <Pager page={page} total={rows.data.pagination.total} setPage={setPage} />}
      </section>
      <form
        className="panel admin-editor"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void adminRequest('/admin/staff', 'POST', { email, role })
            .then(() => {
              setEmail('');
              rows.refresh();
            })
            .catch((e) => setError(message(e)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Создать неактивного сотрудника</h2>
        <label>
          Email нового сотрудника
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Роль нового сотрудника
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="RECEPTIONIST">RECEPTIONIST</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="button" disabled={busy}>
          Создать аккаунт
        </button>
      </form>
      {command && (
        <Confirm
          title="Изменить доступ сотрудника?"
          onClose={() => setCommand(null)}
          onConfirm={async () => {
            await adminRequest(
              '/admin/staff/' +
                command.id +
                (command.action === 'revoke' ? '/revoke-sessions' : ''),
              command.action === 'revoke' ? 'POST' : 'PATCH',
              command.action === 'revoke' ? {} : { [command.action]: command.value },
            );
            if (command.id === me.id) window.dispatchEvent(new Event('clinic-session-expired'));
            setCommand(null);
            rows.refresh();
          }}
        >
          <p>
            Изменение роли, блокировка и отзыв немедленно закрывают текущие сессии. Последний ADMIN
            защищён сервером. Убедитесь, что выбран правильный аккаунт.
          </p>
        </Confirm>
      )}
    </>
  );
}
