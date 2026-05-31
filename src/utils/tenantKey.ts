import { requireTenantId } from '../context/tenantContext';

const TENANT_PREFIX = 't';
const GLOBAL_PREFIX = 'global';

export const tenantKey = (rawKey: string): string => {
  if (!rawKey) {
    throw new Error('tenantKey: rawKey is required');
  }
  const tenantId = requireTenantId(`redis:${rawKey}`);
  return `${TENANT_PREFIX}:${tenantId}:${rawKey}`;
};

export const globalKey = (rawKey: string): string => {
  if (!rawKey) {
    throw new Error('globalKey: rawKey is required');
  }
  return `${GLOBAL_PREFIX}:${rawKey}`;
};
