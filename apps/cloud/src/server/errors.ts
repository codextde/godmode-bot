/** An error with a message that is safe (and written) to show to the person, and an HTTP status for API routes. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string = "error",
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, code = "bad_request") => new AppError(message, code, 400);
export const unauthorized = (message = "Sign in to continue.", code = "unauthorized") => new AppError(message, code, 401);
export const forbidden = (message = "You don't have permission to do that.", code = "forbidden") => new AppError(message, code, 403);
export const notFound = (message = "Not found.", code = "not_found") => new AppError(message, code, 404);
export const conflict = (message: string, code = "conflict") => new AppError(message, code, 409);
export const tooMany = (message = "Too many attempts. Try again in a few minutes.", code = "rate_limited") => new AppError(message, code, 429);

/** JSON body of an API error, the same shape the Godmode core uses: `{ error, code }`. */
export function errorBody(err: unknown): { status: number; body: { error: string; code: string } } {
  if (err instanceof AppError) return { status: err.status, body: { error: err.message, code: err.code } };
  console.error("[api] unexpected error:", err);
  return { status: 500, body: { error: "Something went wrong on our side.", code: "internal" } };
}
