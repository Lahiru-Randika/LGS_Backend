export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details)
export const unauthorized = (message = 'Authentication required.') => new AppError(401, 'UNAUTHORIZED', message)
export const forbidden = (message = 'You are not allowed to perform this action.') => new AppError(403, 'FORBIDDEN', message)
export const notFound = (message = 'Resource not found.') => new AppError(404, 'NOT_FOUND', message)
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message)
export const unprocessable = (message: string, details?: unknown) => new AppError(422, 'UNPROCESSABLE_ENTITY', message, details)
