import { format } from 'date-fns';
import fs from 'fs';
import util from 'util';
import { createLogger, transports, format as winstonFormat } from 'winston';

const { colorize, combine, simple } = winstonFormat;

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';
const LEVELS: LogLevel[] = [
  'error',
  'warn',
  'info',
  'verbose',
  'debug',
  'silly',
];
const LEVEL: LogLevel = 'debug';

const winstonLogger = createLogger({
  format: combine(
    colorize(),
    simple(),
  ),
  transports: [
    new transports.Console({
      level: process.env.NODE_ENV === 'production' ? LEVEL : 'silly',
    }),
  ],
});

type TenantLabelProvider = () => string | undefined;
let tenantLabelProvider: TenantLabelProvider = () => undefined;

// Registered once at startup by tenantContext.ts. Kept as a callback (rather
// than a direct import) so the logger has no dependency on tenant code and
// can be used safely from any module — including tenantContext itself.
export const setTenantLabelProvider = (fn: TenantLabelProvider): void => {
  tenantLabelProvider = fn;
};

function tenantPrefix(): string {
  const label = tenantLabelProvider();
  return label ? `[tenant=${label}] ` : '';
}

const writeLogType = (logLevel: LogLevel, writeSync = false) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
   function (...theArguments: any[]) {
    const args = Array.from(theArguments);

    const loggerMessage = args
      .map((_) => (typeof _ === 'string' ? _ : _?.message || JSON.stringify(_)))
      .join(' ');
    const prefix = tenantPrefix();
    if (process.env.NODE_ENV === 'test') {
      const fileName = 'testing-errors.log';
      const entry = `${format(Date.now(), 'yyyy-MM-dd HH:mm:ss')} ${logLevel.toUpperCase()} ${prefix}${loggerMessage} \n`;
      const flag = { flag: 'a' };
      if (writeSync) {
        fs.writeFileSync(fileName, entry, flag);
        return;
      }
      fs.writeFile(fileName, entry, flag, (err) => {
        winstonLogger.error(err?.message);
      });
      return;
    }

    winstonLogger[logLevel](prefix + util.format(...args));

    if (
      process.env.NODE_ENV === 'production' ||
      process.env.NODE_ENV === 'staging'
    ) {
      if (LEVELS.indexOf(logLevel) >= LEVELS.indexOf(LEVEL)) {
        return;
      }
    }
  }
;

export const logger = {
  silly: writeLogType('silly'),
  debug: writeLogType('debug'),
  verbose: writeLogType('verbose'),
  info: writeLogType('info'),
  warn: writeLogType('warn'),
  error: writeLogType('error'),
  errorSync: writeLogType('error', true),
};