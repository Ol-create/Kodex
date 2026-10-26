// An error that is safe to show to API callers. Anything else becomes a 500.
export class AppError extends Error {
  constructor(status, message, code = "error") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}
