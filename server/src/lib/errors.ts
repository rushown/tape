export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = 'error',
  ) {
    super(message)
  }
}

export const badRequest = (msg: string, code = 'bad_request') => new HttpError(400, msg, code)
export const notFound = (msg: string) => new HttpError(404, msg, 'not_found')
export const unavailable = (msg: string, code = 'unavailable') => new HttpError(503, msg, code)
