import { AsyncLocalStorage } from 'node:async_hooks';
import type { Types } from 'mongoose';
import { logger, setTenantLabelProvider } from '../services/logger.js';

export interface TenantContext {
  tenantId: string;
  tenantSlug?: string;
  bypass?: boolean;
}

const storage = new AsyncLocalStorage<TenantContext>();

export class TenantContextMissingError extends Error {
  constructor(operation: string) {
    super(
      `Tenant context missing for operation: ${operation}. Wrap the call in runWithTenant() or runWithoutTenant().`,
    );
    this.name = 'TenantContextMissingError';
  }
}

export const runWithTenant = <T>(
  tenantId: Types.ObjectId | string,
  fn: () => T,
  slug?: string,
): T => storage.run({ tenantId: tenantId.toString(), tenantSlug: slug }, fn);

export const runWithoutTenant = <T>(reason: string, queryDescription: string, fn: () => T): T => {
  logger.warn(`[tenantContext] BYPASS reason="${reason}" query="${queryDescription}"`);
  return storage.run({ tenantId: '', bypass: true }, fn);
};

export const getTenantContext = (): TenantContext | undefined => storage.getStore();

export const getTenantId = (): string | undefined => {
  const ctx = storage.getStore();
  if (!ctx || ctx.bypass) {
    return undefined;
  }
  return ctx.tenantId;
};

export const requireTenantId = (operation: string): string => {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new TenantContextMissingError(operation);
  }
  if (ctx.bypass) {
    throw new TenantContextMissingError(
      `${operation} (called inside runWithoutTenant — wrap in runWithTenant first)`,
    );
  }
  return ctx.tenantId;
};

export const isBypassing = (): boolean => storage.getStore()?.bypass === true;

export const getTenantSlug = (): string | undefined => {
  const ctx = storage.getStore();
  if (!ctx || ctx.bypass) {
    return undefined;
  }
  return ctx.tenantSlug;
};

// Human-readable label for logs: slug when known, otherwise the raw ObjectId,
// or a sentinel for missing/bypass contexts. Never throws — safe to call from
// any logger statement.
export const getTenantLogLabel = (): string => {
  const ctx = storage.getStore();
  if (!ctx) {
    return 'no-tenant';
  }
  if (ctx.bypass) {
    return 'bypass';
  }
  return ctx.tenantSlug ?? ctx.tenantId;
};

// Register with the logger so every log line is auto-prefixed with the
// current tenant's label. Returning undefined when there's no context keeps
// non-tenanted logs (e.g. startup, cron) clean.
setTenantLabelProvider(() => {
  const ctx = storage.getStore();
  if (!ctx) {
    return undefined;
  }
  if (ctx.bypass) {
    return 'bypass';
  }
  return ctx.tenantSlug ?? ctx.tenantId;
});
