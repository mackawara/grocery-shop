export type Status = 'pass' | 'fail' | 'warn';

export interface Result {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

export interface MailTaskLog {
  timestamp?: string;
  log_level?: string;
  event?: string;
  attributes?: Record<string, unknown>;
}

export interface MailTask {
  message_id: string;
  actor_name: string;
  state: string;
  retries: number;
  logs?: MailTaskLog[];
  previous_logs?: MailTaskLog[];
}

const currentLogs = (t: MailTask): MailTaskLog[] => t.logs ?? [];

export const latestTs = (t: MailTask): number =>
  Math.max(
    0,
    ...currentLogs(t).map((l) => {
      const timestamp = l.timestamp ? Date.parse(l.timestamp) : 0;
      return Number.isFinite(timestamp) ? timestamp : 0;
    }),
  );

export const maskEmails = (text: string): string =>
  text.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)/g, '$1***@$2');

export const lastMailError = (t: MailTask): string | undefined => {
  const errors = currentLogs(t).filter(
    (l) =>
      ['error', 'exception', 'critical'].includes(String(l.log_level)) ||
      Boolean(l.attributes && 'exception' in l.attributes),
  );
  const last = errors[errors.length - 1];
  return last?.event
    ? maskEmails(String(last.event)).replace(/\s+/g, ' ').slice(0, 220)
    : undefined;
};

export const hasMailSuccess = (t: MailTask): boolean =>
  currentLogs(t).some((l) =>
    /successfully sent mail|message sent|sent mail/i.test(String(l.event)),
  );

export const smtpHint = (error: string): string => {
  if (/\b535\b/.test(error)) {
    return /gsmtp|google/i.test(error)
      ? 'Gmail rejected the login. Gmail SMTP needs a Google App Password (requires 2-Step Verification), not the account password. Put it in AUTHENTIK_EMAIL__PASSWORD on the authentik host, then recreate the containers with `docker compose up -d` — a plain restart keeps the old password.'
      : 'The SMTP server rejected the username/password. Fix AUTHENTIK_EMAIL__USERNAME / AUTHENTIK_EMAIL__PASSWORD on the authentik host, then recreate the containers with `docker compose up -d` — a plain restart keeps the old values.';
  }
  if (/timed out|timeout|refused|unreachable|Errno/i.test(error)) {
    return 'The worker could not reach the SMTP server — check AUTHENTIK_EMAIL__HOST/PORT and whether your host blocks outbound SMTP.';
  }
  return 'Check the authentik worker logs and the AUTHENTIK_EMAIL__* settings; `docker compose exec worker ak test_email <address>` reproduces it directly.';
};

export const classifyMailDelivery = (name: string, tasks: MailTask[], warning?: string): Result => {
  const ambiguousOrder = tasks.length > 1 && tasks.some((task) => latestTs(task) === 0);
  const newest = [...tasks].sort((a, b) => latestTs(b) - latestTs(a))[0];
  if (!newest) {
    if (warning) {
      return { name, status: 'warn', detail: warning };
    }
    return {
      name,
      status: 'warn',
      detail: 'no email tasks found — delivery has not been proven (--send-test-email queues one)',
    };
  }

  const error = lastMailError(newest);
  if (error) {
    const failing = tasks.filter((t) => t.state !== 'done' && lastMailError(t)).length || 1;
    return {
      name,
      status: 'fail',
      detail: `${failing} email task(s) failing (${newest.state}, ${newest.retries} retries) — ${error}`,
      fix: smtpHint(error),
    };
  }
  if (['rejected', 'revoked', 'failed', 'failure', 'error'].includes(newest.state)) {
    return {
      name,
      status: 'fail',
      detail: `most recent email task is ${newest.state} with no worker error log`,
      fix: 'Check the authentik worker logs and the AUTHENTIK_EMAIL__* settings.',
    };
  }
  if (warning || ambiguousOrder) {
    return {
      name,
      status: 'warn',
      detail: warning ?? 'mail task order is unclear; delivery status is unverified',
    };
  }
  if (newest.state === 'done') {
    return hasMailSuccess(newest)
      ? { name, status: 'pass', detail: 'most recent email task was delivered to the SMTP server' }
      : {
          name,
          status: 'warn',
          detail:
            'most recent email task is done but has no send-success log; delivery is unverified',
        };
  }
  return {
    name,
    status: 'warn',
    detail: `most recent email task is ${newest.state}; delivery is still unverified`,
  };
};
