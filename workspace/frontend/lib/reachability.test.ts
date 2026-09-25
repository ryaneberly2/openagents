import { describe, expect, it } from 'vitest';
import { classifyProbe } from './reachability';

describe('classifyProbe', () => {
  it('reads a redirect (Cloudflare Access login) as needing a sign-in', () => {
    expect(classifyProbe({ type: 'opaqueredirect', status: 0, ok: false })).toBe('login');
  });

  it('reads 401/403 as needing a sign-in', () => {
    expect(classifyProbe({ type: 'basic', status: 401, ok: false })).toBe('login');
    expect(classifyProbe({ type: 'cors', status: 403, ok: false })).toBe('login');
  });

  it('reads a healthy response as ok', () => {
    expect(classifyProbe({ type: 'basic', status: 200, ok: true })).toBe('ok');
  });

  it('reads a network failure or a 5xx as offline', () => {
    expect(classifyProbe(null)).toBe('offline');
    expect(classifyProbe({ type: 'basic', status: 502, ok: false })).toBe('offline');
  });
});
