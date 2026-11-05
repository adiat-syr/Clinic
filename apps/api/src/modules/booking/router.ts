import type { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { AuthService } from '../security/service.js';
import { validated } from '../security/errors.js';
import type { BookingHttpService } from './http-service.js';
import type { Transaction } from './transaction.js';
export function registerBookingRoutes(
  router: Router,
  auth: AuthService,
  booking: BookingHttpService,
  csrf: (req: Request) => void,
  session: (req: Request) => string | null,
  requestId: (res: Response) => string,
) {
  const empty = (input: unknown) => validated(z.strictObject({}), input);
  const work = <T>(
    req: Request,
    res: Response,
    fn: (tx: Transaction, actor: string) => Promise<T>,
    adminOnly = false,
  ) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      csrf(req);
      empty(req.query);
    }
    return auth.withSession(
      session(req),
      { requestId: requestId(res), roles: adminOnly ? ['ADMIN'] : ['ADMIN', 'RECEPTIONIST'] },
      (tx, actor) => fn(tx, actor.id),
    );
  };
  router.get('/availability', async (req, res) => {
    await auth.limiter.require('availability-ip', req.ip ?? 'unknown', 60, 60000);
    res.json(await booking.availability(req.query));
  });
  router.get('/consent-documents/current', async (req, res) =>
    res.json(await booking.consent(req.query)),
  );
  router.post('/appointments', async (req, res) => {
    csrf(req);
    empty(req.query);
    await auth.limiter.require('booking-ip', req.ip ?? 'unknown', 20, 15 * 60000);
    const result = await booking.create(req.body, req.get('idempotency-key'));
    res.status(result.replayed ? 200 : 201).json(result.body);
  });
  router.get('/admin/availability-windows', async (req, res) =>
    res.json(await work(req, res, (tx) => booking.windows(tx, req.query))),
  );
  router.post('/admin/availability-windows', async (req, res) =>
    res
      .status(201)
      .json(
        await work(req, res, (tx, actor) =>
          booking.createWindow(tx, req.body, actor, requestId(res)),
        ),
      ),
  );
  router.patch('/admin/availability-windows/:id', async (req, res) => {
    await work(req, res, (tx, actor) =>
      booking.core.inTransaction(tx, actor, requestId(res)).replaceWindow(req.params.id, req.body),
    );
    res.status(204).end();
  });
  router.delete('/admin/availability-windows/:id', async (req, res) => {
    empty(req.body ?? {});
    await work(req, res, (tx, actor) =>
      booking.core.inTransaction(tx, actor, requestId(res)).deleteWindow(req.params.id),
    );
    res.status(204).end();
  });
  router.get('/admin/appointments', async (req, res) =>
    res.json(
      await work(req, res, (tx, actor) =>
        booking.appointments(tx, req.query, actor, requestId(res)),
      ),
    ),
  );
  router.get('/admin/appointments/:id', async (req, res) => {
    empty(req.query);
    res.json(
      await work(req, res, (tx, actor) =>
        booking.appointment(tx, req.params.id, actor, requestId(res)),
      ),
    );
  });
  router.patch('/admin/appointments/:id', async (req, res) =>
    res.json(
      await work(req, res, (tx, actor) =>
        booking.change(tx, req.params.id, req.body, actor, requestId(res)),
      ),
    ),
  );
  router.post('/admin/appointments/:id/consent-withdrawal', async (req, res) =>
    res.json(
      await work(
        req,
        res,
        (tx, actor) => booking.withdraw(tx, req.params.id, req.body, actor, requestId(res)),
        true,
      ),
    ),
  );
}
