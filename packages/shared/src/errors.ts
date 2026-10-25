export class OpenEngineerError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = 'OpenEngineerError';
    this.code = code;
    this.details = details;
  }
}

export function isOpenEngineerError(error: unknown): error is OpenEngineerError {
  return error instanceof OpenEngineerError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string {
  if (isOpenEngineerError(error)) return error.code;
  return 'internal';
}
