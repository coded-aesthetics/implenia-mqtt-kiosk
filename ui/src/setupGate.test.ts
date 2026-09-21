import { describe, it, expect } from 'vitest';
import { resolveScreen, needsSetupRedirect, type GateInput } from './setupGate';

const base: GateInput = {
  onSetupRoute: false,
  settled: true,
  hasError: false,
  verfahren: 'injektionsbohren',
};

describe('resolveScreen', () => {
  it('shows the app on a configured kiosk', () => {
    expect(resolveScreen(base)).toBe('app');
  });

  it('shows setup on an unconfigured kiosk', () => {
    expect(resolveScreen({ ...base, verfahren: null })).toBe('setup');
  });

  it('waits rather than guessing before the first answer', () => {
    expect(resolveScreen({ ...base, settled: false, verfahren: null })).toBe('checking');
  });

  it('reports an unreachable server instead of assuming "not set up"', () => {
    expect(resolveScreen({ ...base, hasError: true, verfahren: null })).toBe('error');
  });

  // ── The two regressions this module exists for ──────────────────────────

  it('keeps the wizard on screen after the Verfahren is set mid-flow', () => {
    // Regression 1: confirming step 1 made the kiosk "configured", which
    // unmounted the wizard and dropped the user into the app.
    expect(resolveScreen({ ...base, onSetupRoute: true, verfahren: 'injektionsbohren' }))
      .toBe('setup');
  });

  it('keeps the wizard on screen while a refetch is in flight', () => {
    // Regression 2: refetch set loading=true, the loading branch came first,
    // and the wizard remounted at step 1.
    expect(resolveScreen({ ...base, onSetupRoute: true, settled: false, verfahren: null }))
      .toBe('setup');
  });

  it('keeps the wizard on screen even if the setup state errors', () => {
    expect(resolveScreen({ ...base, onSetupRoute: true, hasError: true })).toBe('setup');
  });
});

describe('needsSetupRedirect', () => {
  it('redirects an unconfigured kiosk that is not already in the wizard', () => {
    expect(needsSetupRedirect({ ...base, verfahren: null })).toBe(true);
  });

  it('does not redirect once configured', () => {
    expect(needsSetupRedirect(base)).toBe(false);
  });

  it('does not redirect while already in the wizard — that would fight the URL', () => {
    expect(needsSetupRedirect({ ...base, onSetupRoute: true, verfahren: null })).toBe(false);
  });

  it('does not redirect before the state is known, or when it is unknown', () => {
    expect(needsSetupRedirect({ ...base, settled: false, verfahren: null })).toBe(false);
    expect(needsSetupRedirect({ ...base, hasError: true, verfahren: null })).toBe(false);
  });
});
