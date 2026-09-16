import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyMailDelivery } from '../src/scripts/authDoctorMailEvidence.ts';
import type { MailTask } from '../src/scripts/authDoctorMailEvidence.ts';

const task = (overrides: Partial<MailTask>): MailTask => ({
  message_id: 'task-1',
  actor_name: 'authentik.stages.email.tasks.send_mail',
  state: 'done',
  retries: 0,
  logs: [{ timestamp: '2026-09-16T00:00:00Z', event: 'Successfully sent mail' }],
  ...overrides,
});

describe('classifyMailDelivery', () => {
  it('warns when the queue is empty', () => {
    const result = classifyMailDelivery('Email delivery', []);

    assert.equal(result.status, 'warn');
    assert.match(result.detail, /not been proven/);
  });

  it('warns when the task list is incomplete or unreadable', () => {
    const result = classifyMailDelivery('Email delivery', [], 'could not read mail task page 1');

    assert.equal(result.status, 'warn');
    assert.match(result.detail, /could not read/);
  });

  it('reports visible failures even when later task pages are unreadable', () => {
    const result = classifyMailDelivery(
      'Email delivery',
      [task({ state: 'rejected', logs: [] })],
      'could not read mail task page 2',
    );

    assert.equal(result.status, 'fail');
    assert.match(result.detail, /rejected/);
  });

  it('passes only when a done task has a send-success log', () => {
    const result = classifyMailDelivery('Email delivery', [task({})]);

    assert.equal(result.status, 'pass');
  });

  it('passes a successful retry despite an archived SMTP error', () => {
    const result = classifyMailDelivery('Email delivery', [
      task({
        retries: 1,
        previous_logs: [
          { timestamp: '2026-09-15T00:00:00Z', event: 'SMTP rejected login', log_level: 'error' },
        ],
      }),
    ]);

    assert.equal(result.status, 'pass');
  });

  it('fails a current SMTP error despite an archived success', () => {
    const result = classifyMailDelivery('Email delivery', [
      task({
        state: 'rejected',
        logs: [
          { timestamp: '2026-09-16T00:00:00Z', event: 'SMTP rejected login', log_level: 'error' },
        ],
        previous_logs: [{ timestamp: '2026-09-15T00:00:00Z', event: 'Successfully sent mail' }],
      }),
    ]);

    assert.equal(result.status, 'fail');
  });

  it('does not pass a successful task when later pages were unreadable', () => {
    const result = classifyMailDelivery(
      'Email delivery',
      [task({})],
      'could not read mail task page 2',
    );

    assert.equal(result.status, 'warn');
    assert.match(result.detail, /page 2/);
  });

  it('warns when done has no send-success log', () => {
    const result = classifyMailDelivery('Email delivery', [task({ logs: [] })]);

    assert.equal(result.status, 'warn');
    assert.match(result.detail, /unverified/);
  });

  it('fails terminal failures even without worker error logs', () => {
    const result = classifyMailDelivery('Email delivery', [task({ state: 'rejected', logs: [] })]);

    assert.equal(result.status, 'fail');
    assert.match(result.detail, /rejected/);
  });

  it('fails tasks that carry SMTP errors', () => {
    const result = classifyMailDelivery('Email delivery', [
      task({
        state: 'retrying',
        retries: 2,
        logs: [
          {
            event: "SMTP error for user@example.test: (535, b'BadCredentials')",
            log_level: 'error',
          },
        ],
      }),
    ]);

    assert.equal(result.status, 'fail');
    assert.match(result.detail, /u\*\*\*@example\.test/);
    assert.match(result.fix ?? '', /SMTP/);
  });

  it('warns pending tasks instead of treating them as success', () => {
    const result = classifyMailDelivery('Email delivery', [task({ state: 'running', logs: [] })]);

    assert.equal(result.status, 'warn');
    assert.match(result.detail, /unverified/);
  });
});
