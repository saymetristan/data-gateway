export type GatewayErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'validation_error'
  | 'unprocessable_entity'
  | 'conflict'
  | 'internal';

const HTTP_STATUS = {
  unauthorized: 401,
  not_found: 404,
  validation_error: 400,
  unprocessable_entity: 422,
  conflict: 409,
  internal: 500,
} as const;

export type GatewayHttpStatus = (typeof HTTP_STATUS)[GatewayErrorCode];

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: GatewayHttpStatus;
  readonly details?: unknown;

  constructor(code: GatewayErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    if (details !== undefined) {
      this.details = details;
    }
  }

  static unauthorized(message = 'Unauthorized'): GatewayError {
    return new GatewayError('unauthorized', message);
  }

  static notFound(message = 'Not found'): GatewayError {
    return new GatewayError('not_found', message);
  }

  static validation(message: string, details?: unknown): GatewayError {
    return new GatewayError('validation_error', message, details);
  }

  static unprocessable(message: string, details?: unknown): GatewayError {
    return new GatewayError('unprocessable_entity', message, details);
  }

  static conflict(message: string): GatewayError {
    return new GatewayError('conflict', message);
  }

  static internal(message = 'Internal server error'): GatewayError {
    return new GatewayError('internal', message);
  }
}

export function gatewayErrorToHttp(error: GatewayError): {
  status: GatewayHttpStatus;
  body: { error: { code: GatewayErrorCode; message: string; details?: unknown } };
} {
  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
  };
}
