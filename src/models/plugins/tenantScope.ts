import type {
  Aggregate,
  HydratedDocument,
  MongooseQueryMiddleware,
  Query,
  Schema,
} from 'mongoose';
import { Types } from 'mongoose';
import {
  isBypassing,
  requireTenantId,
} from '../../context/tenantContext';

const QUERY_HOOKS: MongooseQueryMiddleware[] = [
  'countDocuments',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'distinct',
  'replaceOne',
];

type QueryThis = Query<unknown, unknown>;
type AggregateThis = Aggregate<unknown>;
type TenantDoc = HydratedDocument<{ tenantId?: Types.ObjectId }>;
type InsertManyDoc = { tenantId?: Types.ObjectId | string };

// Update hooks carry an update payload (operators like $set); replace hooks
// carry a full replacement document. Both can smuggle a tenantId past the
// filter scoping, so they need payload sanitizing on top of filter injection.
const UPDATE_HOOKS = new Set<MongooseQueryMiddleware>([
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
]);
const REPLACE_HOOKS = new Set<MongooseQueryMiddleware>([
  'replaceOne',
  'findOneAndReplace',
]);

const toObjectId = (id: string) => new Types.ObjectId(id);

// Aggregation stages that reach into (or write out to) a *foreign* collection.
// The tenant $match we prepend only scopes the pipeline's source collection, so
// these stages join/union/write across tenant boundaries with no scoping the
// plugin can inject. There is no safe automatic rewrite, so we refuse to run
// them implicitly and force the caller to opt out via runWithoutTenant.
const CROSS_COLLECTION_STAGES = [
  '$lookup',
  '$graphLookup',
  '$unionWith',
  '$merge',
  '$out',
] as const;

const assertTenantMatch = (
  value: unknown,
  tenantId: string,
  where: string,
): void => {
  if (value != null && String(value) !== tenantId) {
    throw new Error(
      `tenantScope: ${where} sets tenantId ${String(value)} but context is ${tenantId}`,
    );
  }
};

// Strip any caller-supplied tenantId from an update operator payload. The filter
// already pins the tenant for matching, and on upsert MongoDB copies tenantId
// into the new doc from the filter's equality condition — so a tenantId write
// here is at best redundant and at worst a cross-tenant move. Reject mismatches,
// then drop the (validated) writes, cleaning up any operator left empty.
const scopeUpdate = (query: QueryThis, tenantId: string): void => {
  const update = query.getUpdate();
  if (!update || Array.isArray(update)) {
    // Aggregation-pipeline updates are not sanitized here; the filter still
    // pins the tenant for matching, but a $set stage touching tenantId is the
    // caller's responsibility.
    return;
  }
  const updateDoc = update as Record<string, unknown>;
  const setOp = updateDoc.$set as Record<string, unknown> | undefined;
  const setOnInsertOp = updateDoc.$setOnInsert as
    | Record<string, unknown>
    | undefined;
  const unsetOp = updateDoc.$unset as Record<string, unknown> | undefined;

  // $unset would clear tenantId, orphaning the doc: it stops matching any
  // tenant's scoped queries but lingers as dark data exposed by raw access or
  // future bugs. There is no valid reason to drop a doc's tenant, so reject it
  // outright rather than silently dropping the operator.
  if (unsetOp && 'tenantId' in unsetOp) {
    throw new Error('tenantScope: update may not $unset tenantId');
  }

  assertTenantMatch(updateDoc.tenantId, tenantId, 'update');
  assertTenantMatch(setOp?.tenantId, tenantId, 'update $set');
  assertTenantMatch(setOnInsertOp?.tenantId, tenantId, 'update $setOnInsert');

  delete updateDoc.tenantId;
  if (setOp) {
    delete setOp.tenantId;
    if (Object.keys(setOp).length === 0) {delete updateDoc.$set;}
  }
  if (setOnInsertOp) {
    delete setOnInsertOp.tenantId;
    if (Object.keys(setOnInsertOp).length === 0) {delete updateDoc.$setOnInsert;}
  }
  query.setUpdate(updateDoc);
};

// A replace swaps the whole document, so an omitted tenantId would drop a
// required field and a different one would move the doc across tenants. Reject
// mismatches, then force the context tenant onto the replacement.
const scopeReplacement = (query: QueryThis, tenantId: string): void => {
  const doc = query.getUpdate();
  if (!doc || Array.isArray(doc)) {
    return;
  }
  const replacementDoc = doc as Record<string, unknown>;
  assertTenantMatch(replacementDoc.tenantId, tenantId, 'replacement');
  replacementDoc.tenantId = toObjectId(tenantId);
  query.setUpdate(replacementDoc);
};

export function tenantScope(schema: Schema): void {
  // The field itself is owned by each model's schema (declared next to its
  // TypeScript type); the plugin owns only the runtime scoping behavior. Assert
  // the field exists so a model that applies the plugin but forgets to declare
  // tenantId fails at boot rather than silently skipping tenant isolation.
  if (!schema.path('tenantId')) {
    throw new Error(
      'tenantScope requires a `tenantId` ObjectId path on the schema',
    );
  }

  for (const hook of QUERY_HOOKS) {
    schema.pre<QueryThis>(hook, function (this: QueryThis) {
      if (isBypassing()) {
        return;
      }
      const tenantId = requireTenantId(hook);
      const filter = this.getFilter();
      this.setQuery({ ...filter, tenantId: toObjectId(tenantId) });
      if (UPDATE_HOOKS.has(hook)) {
        scopeUpdate(this, tenantId);
      } else if (REPLACE_HOOKS.has(hook)) {
        scopeReplacement(this, tenantId);
      }
    });
  }

  // bulkWrite bundles arbitrary insert/update/replace/delete ops and triggers no
  // per-op middleware, so it can neither be filter-scoped nor payload-sanitized.
  // Reject it unless the caller has explicitly opted out (runWithoutTenant).
  schema.pre('bulkWrite', function () {
    if (isBypassing()) {
      return;
    }
    throw new Error(
      'tenantScope: bulkWrite is not tenant-aware; use scoped updateMany/insertMany, or wrap in runWithoutTenant if cross-tenant is intended',
    );
  });

  // estimatedDocumentCount ignores query filters, so it can never be
  // tenant-scoped and would leak a cross-tenant total. Reject it unless the
  // caller has explicitly opted out of tenant scoping (runWithoutTenant).
  schema.pre<QueryThis>('estimatedDocumentCount', function () {
    if (isBypassing()) {
      return;
    }
    throw new Error(
      'tenantScope: estimatedDocumentCount is not tenant-aware; use countDocuments instead',
    );
  });

  schema.pre<AggregateThis>('aggregate', function (this: AggregateThis) {
    if (isBypassing()) {
      return;
    }
    const tenantId = requireTenantId('aggregate');
    const pipeline = this.pipeline() as unknown as Record<string, unknown>[];
    // Reject pipelines that touch foreign collections: the $match below only
    // scopes the source collection, leaving these stages unscoped. Make the
    // cross-tenant intent explicit by requiring runWithoutTenant.
    for (const stage of pipeline) {
      const offending = CROSS_COLLECTION_STAGES.find((s) => s in stage);
      if (offending) {
        throw new Error(
          `tenantScope: aggregation stage ${offending} crosses collections and cannot be tenant-scoped; wrap in runWithoutTenant (and scope the joined collection yourself) if cross-tenant access is intended`,
        );
      }
    }
    pipeline.unshift({ $match: { tenantId: toObjectId(tenantId) } });
  });

  schema.pre<TenantDoc>('save', function (this: TenantDoc) {
    if (isBypassing()) {
      return;
    }
    const tenantId = requireTenantId('save');
    if (this.isNew) {
      if (!this.tenantId) {
        this.tenantId = toObjectId(tenantId);
      } else if (this.tenantId.toString() !== tenantId) {
        throw new Error(
          `tenantScope: doc.tenantId ${this.tenantId} does not match context ${tenantId}`,
        );
      }
    } else if (this.tenantId && this.tenantId.toString() !== tenantId) {
      throw new Error(
        `tenantScope: cannot modify doc from tenant ${this.tenantId} under context ${tenantId}`,
      );
    }
  });

  schema.pre('insertMany', function (
    this: unknown,
    docs: InsertManyDoc | InsertManyDoc[],
  ) {
    if (isBypassing()) {
      return;
    }
    const tenantId = requireTenantId('insertMany');
    const tid = toObjectId(tenantId);
    const list = Array.isArray(docs) ? docs : [docs];
    for (const doc of list) {
      if (!doc.tenantId) {
        doc.tenantId = tid;
      } else if (doc.tenantId.toString() !== tenantId) {
        throw new Error(
          `tenantScope: insertMany doc has tenantId ${doc.tenantId} but context is ${tenantId}`,
        );
      }
    }
  });
}
