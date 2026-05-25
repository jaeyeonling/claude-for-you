import { describe, expect, test } from 'bun:test';
import { createBillingMonitor } from '../src/usage/billing-monitor.js';
import type { AlertSink } from '../src/alerts.js';

const collectingSink = (): { sink: AlertSink; messages: string[] } => {
  const messages: string[] = [];
  return {
    sink: async (m) => {
      messages.push(m);
    },
    messages,
  };
};

const headers = (init: Record<string, string> = {}): Headers => new Headers(init);

describe('createBillingMonitor', () => {
  test('standard tier + allowed status = silence', () => {
    const { sink, messages } = collectingSink();
    const monitor = createBillingMonitor({ sink });
    monitor.observe('standard', headers({ 'anthropic-ratelimit-unified-status': 'allowed' }));
    expect(messages).toHaveLength(0);
    expect(monitor.snapshot().nonStandardCount).toBe(0);
  });

  test('non-standard tier triggers an alarm with service_tier in message', () => {
    const { sink, messages } = collectingSink();
    const monitor = createBillingMonitor({ sink });
    monitor.observe('priority', headers());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('service_tier=priority');
    expect(monitor.snapshot().nonStandardCount).toBe(1);
  });

  test('non-allowed unified-status header also triggers an alarm', () => {
    const { sink, messages } = collectingSink();
    const monitor = createBillingMonitor({ sink });
    monitor.observe('standard', headers({ 'anthropic-ratelimit-unified-status': 'denied' }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('unified-status=denied');
  });

  test('allowed_warning is treated as OK (within the OK_STATUS set)', () => {
    const { sink, messages } = collectingSink();
    const monitor = createBillingMonitor({ sink });
    monitor.observe(
      'standard',
      headers({ 'anthropic-ratelimit-unified-status': 'allowed_warning' }),
    );
    expect(messages).toHaveLength(0);
  });

  test('alarm cooldown prevents flooding under repeated non-standard responses', () => {
    const { sink, messages } = collectingSink();
    const monitor = createBillingMonitor({ sink, cooldownMs: 60_000 });
    monitor.observe('priority', headers());
    monitor.observe('priority', headers());
    monitor.observe('priority', headers());
    expect(messages).toHaveLength(1); // 3 events → 1 alarm
    expect(monitor.snapshot().nonStandardCount).toBe(3); // but the count tracks all events
  });

  test('representative-claim header is included in the alarm body when present', () => {
    const { sink, messages } = collectingSink();
    const monitor = createBillingMonitor({ sink });
    monitor.observe(
      'priority',
      headers({ 'anthropic-ratelimit-unified-representative-claim': 'free-user' }),
    );
    expect(messages[0]).toContain('representative-claim=free-user');
  });

  test('snapshot exposes the latest observation', () => {
    const { sink } = collectingSink();
    const monitor = createBillingMonitor({ sink });
    monitor.observe('standard', headers({ 'anthropic-ratelimit-unified-status': 'allowed' }));
    const snap = monitor.snapshot();
    expect(snap.lastObservation?.serviceTier).toBe('standard');
    expect(snap.lastObservation?.unifiedStatus).toBe('allowed');
  });
});
