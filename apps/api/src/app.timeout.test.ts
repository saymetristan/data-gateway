import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import { createApp, type AppBindings } from './app.js';

const fixture = vi.hoisted(() => ({ delay: 30_000 }));

vi.mock('./middleware/auth.js', () => ({
  workspaceAuth: () => async (_c: Context, next: Next) => next(),
  adminAuth: () => async (_c: Context, next: Next) => next(),
  requireScope: () => async (_c: Context, next: Next) => next(),
}));
vi.mock('./middleware/rls.js', () => ({
  rlsContext: () => async (_c: Context, next: Next) => next(),
}));
vi.mock('./routes/sources.js', async () => {
  const { Hono } = await import('hono');
  return {
    sourceRoutes: () =>
      new Hono().all('*', async (c) => {
        await new Promise((resolve) => setTimeout(resolve, fixture.delay));
        return c.json({ imported: 1 }, 202);
      }),
  };
});

describe('request timeout routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fixture.delay = 30_000;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function buildApp() {
    // No providers or database are used; only the route's work is substituted.
    return createApp({ env: { RATE_LIMIT_MAX: 0, RATE_LIMIT_WINDOW_MS: 60_000 } } as AppBindings);
  }

  it('lets a synchronous upload return its receipt after the normal 25 second limit', async () => {
    fixture.delay = 253_000;
    let settled = false;
    const pending = buildApp().request('/sources/source-id/upload', { method: 'POST' });
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(228_000);
    const response = await pending;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ imported: 1 });
  });

  it('still bounds uploads at 540 seconds', async () => {
    fixture.delay = 541_000;
    let settled = false;
    const pending = buildApp().request('/sources/source-id/upload', { method: 'POST' });
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(539_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.text()).toBe('Request timeout');
  });

  it.each([
    ['GET', '/sources/source-id/upload'],
    ['PUT', '/sources/source-id/upload'],
    ['POST', '/sources/source-id/index'],
    ['POST', '/sources/source-id/upload/extra'],
    ['POST', '/sources/source-id/upload/'],
  ])('keeps 25 seconds for %s %s', async (method, path) => {
    const pending = buildApp().request(path, { method });
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await pending).status).toBe(504);
  });
});
