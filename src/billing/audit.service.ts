import { Types } from 'mongoose';
import { runWithTenant } from '../context/tenantContext.ts';
import { BillingAuditEntry, PlatformBillingAuditEntry } from './models/BillingAuditEntry.ts';
import type { IBillingAuditEntry, IPlatformBillingAuditEntry } from './models/BillingAuditEntry.ts';
import type { VendorBillingRef } from './vendorRates.service.ts';

// Read side of the billing audit log, newest first. Entries are written only
// by the services that make the changes, inside the same transaction.

export interface AuditPage {
  limit: number;
  // Return entries older than this entry id (the last id of the previous page).
  before?: string;
}

const olderThan = (before?: string) => (before ? { _id: { $lt: new Types.ObjectId(before) } } : {});

export const listPlatformBillingAudit = (page: AuditPage): Promise<IPlatformBillingAuditEntry[]> =>
  PlatformBillingAuditEntry.find(olderThan(page.before)).sort({ _id: -1 }).limit(page.limit);

export const listVendorBillingAudit = (
  vendor: VendorBillingRef,
  page: AuditPage,
): Promise<IBillingAuditEntry[]> =>
  runWithTenant(
    vendor.tenantId,
    () => BillingAuditEntry.find(olderThan(page.before)).sort({ _id: -1 }).limit(page.limit),
    vendor.slug,
  );
