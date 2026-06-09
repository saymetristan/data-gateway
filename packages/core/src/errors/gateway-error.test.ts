import { describe, it, expect } from 'vitest';
import { GatewayError, gatewayErrorToHttp } from '../errors/gateway-error.js';

describe('GatewayError', () => {
  it('maps codes to HTTP status', () => {
    expect(GatewayError.unauthorized().status).toBe(401);
    expect(GatewayError.notFound().status).toBe(404);
    expect(GatewayError.validation('bad').status).toBe(400);
    expect(GatewayError.conflict('dup').status).toBe(409);
    expect(GatewayError.internal().status).toBe(500);
  });

  it('serialises to HTTP body', () => {
    const error = GatewayError.validation('Invalid input', { field: 'slug' });
    const http = gatewayErrorToHttp(error);

    expect(http.status).toBe(400);
    expect(http.body.error.code).toBe('validation_error');
    expect(http.body.error.details).toEqual({ field: 'slug' });
  });
});
