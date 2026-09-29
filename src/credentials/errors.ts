export type CredentialRefreshErrorCode =
  | 'INVALID_ARGUMENT'
  | 'OUTPUT_EXISTS'
  | 'PRIVATE_DIR_UNSAFE'
  | 'CDP_CONNECT_FAILED'
  | 'CDP_DISCONNECT_FAILED'
  | 'DOUYIN_PAGE_NOT_FOUND'
  | 'AMBIGUOUS_CONTEXT'
  | 'BROWSER_READ_FAILED'
  | 'ACCOUNT_SOURCE_MISSING'
  | 'ACCOUNT_SOURCE_CONFLICT'
  | 'SESSION_CHANGED'
  | 'REQUIRED_FIELD_MISSING'
  | 'COOKIE_CONFLICT'
  | 'TEMPLATE_INVALID'
  | 'ACCOUNT_MISMATCH'
  | 'PYTHON_DOTENV_UNAVAILABLE'
  | 'WRITE_FAILED'
  | 'INTERNAL_ERROR';

export class CredentialRefreshError extends Error {
  readonly code: CredentialRefreshErrorCode;

  constructor(code: CredentialRefreshErrorCode, message: string) {
    super(message);
    this.name = 'CredentialRefreshError';
    this.code = code;
  }

  toJSON(): { code: CredentialRefreshErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function toSafeError(error: unknown): CredentialRefreshError {
  if (error instanceof CredentialRefreshError) return error;
  return new CredentialRefreshError('INTERNAL_ERROR', 'Credential refresh failed');
}
