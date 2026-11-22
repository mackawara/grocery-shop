import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { BillingAuditAction, BillingAuditSubject } from '../../constants/billing.ts';
import { tenantScope } from '../../models/plugins/tenantScope.ts';
import { immutableRecord } from './plugins/immutableRecord.ts';
import type { StoredActor } from './fields.ts';
import { ActorSchema, reasonField } from './fields.ts';

// The billing audit log (decisions E4, G1): who did what, when and why. Written
// in the same transaction as the change it records, so there is never a change
// without its entry or an entry without its change. Append-only: no update or
// delete path exists (immutableRecord).
//
// Two collections, not one with an optional tenantId:
//  - BillingAuditEntry is tenant-owned (tenantScope) and records changes to a
//    vendor's own billing (overrides; later waivers, credit notes). A vendor-
//    facing read can then never see another vendor's entries.
//  - PlatformBillingAuditEntry records changes to genuinely global billing
//    data (plan rate cards; later platform promos). It has no tenantId to fake.
// An admin "everything" view reads both.

interface AuditFields {
  action: BillingAuditAction;
  actor: StoredActor;
  reason: string;
  // The record the entry is about.
  subject: { kind: BillingAuditSubject; id: Types.ObjectId };
  // Snapshot of what changed (the version's rates, the months affected).
  // Never secrets: billing records hold prices, not credentials.
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface IBillingAuditEntry extends AuditFields, Document {
  tenantId: Types.ObjectId;
}

export interface IPlatformBillingAuditEntry extends AuditFields, Document {}

const SubjectSchema = new Schema(
  {
    kind: { type: String, enum: Object.values(BillingAuditSubject), required: true },
    id: { type: Schema.Types.ObjectId, required: true },
  },
  { _id: false },
);

const auditFields = {
  action: { type: String, enum: Object.values(BillingAuditAction), required: true },
  actor: { type: ActorSchema, required: true },
  reason: reasonField,
  subject: { type: SubjectSchema, required: true },
  details: { type: Schema.Types.Mixed, required: true },
};

// minimize:false keeps an intentionally empty object in `details` (e.g. an
// override version that sets no fields) instead of dropping it.
const auditOptions = { timestamps: { createdAt: true, updatedAt: false }, minimize: false };

const BillingAuditEntrySchema = new Schema<IBillingAuditEntry>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    ...auditFields,
  },
  auditOptions,
);
BillingAuditEntrySchema.index({ tenantId: 1, _id: -1 });
BillingAuditEntrySchema.plugin(tenantScope);
BillingAuditEntrySchema.plugin(immutableRecord);

const PlatformBillingAuditEntrySchema = new Schema<IPlatformBillingAuditEntry>(
  auditFields,
  auditOptions,
);
PlatformBillingAuditEntrySchema.plugin(immutableRecord);

export const BillingAuditEntry = mongoose.model<IBillingAuditEntry>(
  'BillingAuditEntry',
  BillingAuditEntrySchema,
);

export const PlatformBillingAuditEntry = mongoose.model<IPlatformBillingAuditEntry>(
  'PlatformBillingAuditEntry',
  PlatformBillingAuditEntrySchema,
);
