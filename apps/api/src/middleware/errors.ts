import type { ErrorRequestHandler } from 'express';
import type { ApiErrorResponse } from '@clinic/contracts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function bodyErrorType(error: unknown): unknown {
  return error && typeof error === 'object' && 'type' in error ? error.type : undefined;
}

export function createErrorHandler(
  reportUnexpected: (requestId: string) => void,
): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestId = String(response.getHeader('x-request-id'));
    let safeError: HttpError;
    if (error instanceof HttpError) {
      safeError = error;
    } else if (bodyErrorType(error) === 'entity.parse.failed') {
      safeError = new HttpError(400, 'INVALID_JSON', 'Некорректный JSON');
    } else if (bodyErrorType(error) === 'entity.too.large') {
      safeError = new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Превышен размер запроса');
    } else {
      reportUnexpected(requestId);
      safeError = new HttpError(500, 'INTERNAL_ERROR', 'Не удалось обработать запрос');
    }

    const body: ApiErrorResponse = {
      error: { code: safeError.code, message: safeError.message, requestId },
    };
    response.status(safeError.status).json(body);
  };
}
