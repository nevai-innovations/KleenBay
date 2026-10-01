export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function badRequest(message: string): never { throw new HttpError(400, 'BAD_REQUEST', message); }
export function forbidden(): never { throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this resource'); }
export function notFound(): never { throw new HttpError(404, 'NOT_FOUND', 'Resource not found'); }
