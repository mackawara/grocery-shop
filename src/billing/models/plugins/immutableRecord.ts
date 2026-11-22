import type { HydratedDocument, Query, Schema } from 'mongoose';

// Billing records are append-only (issue #53, technical constraints): rate
// history, and later invoices and credit notes, are never edited after the
// fact, and the audit log can't be edited at all. This plugin makes that a
// property of the model rather than a convention callers must remember: every
// Mongoose path that could change or remove a saved record throws before it
// reaches the database.
//
// Rate versions additionally need ONE controlled change: withdrawing a version
// before it takes effect. With `cancellable: true`, updateOne/findOneAndUpdate
// are allowed only for exactly that: setting `cancelled: true` plus the
// `cancellation` details, on a record the filter pins by _id and requires to be
// not yet cancelled. That makes cancellation one-way and unrepeatable, and
// leaves every rate field immutable. Whether the version may still be
// cancelled (its month hasn't started) is the service's rule to check.
//
// Scope: this guards the ODM. Raw driver calls bypass it, which CLAUDE.md
// already forbids for tenant data; database-level protection (e.g. a role with
// no update/delete on these collections) would be a further, separate layer.

export class ImmutableRecordError extends Error {
  constructor(operation: string) {
    super(`immutableRecord: ${operation} is not allowed on an append-only billing record`);
    this.name = 'ImmutableRecordError';
  }
}

export interface ImmutableRecordOptions {
  cancellable?: boolean;
}

type AnyQuery = Query<unknown, unknown>;

const QUERY_WRITES = [
  'updateMany',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

const SINGLE_UPDATES = ['updateOne', 'findOneAndUpdate'] as const;

const CANCELLATION_PATHS = new Set(['cancelled', 'cancellation']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// True only for `{ $set: { cancelled: true, cancellation?: … } }` against
// `{ _id: …, cancelled: false }`, without upsert.
export const isCancellationUpdate = (query: AnyQuery): boolean => {
  if (query.getOptions().upsert) {
    return false;
  }
  const filter = query.getFilter();
  if (filter._id == null || filter.cancelled !== false) {
    return false;
  }
  const update = query.getUpdate();
  if (!isPlainObject(update)) {
    return false;
  }
  for (const [operator, value] of Object.entries(update)) {
    if (operator === '$set') {
      continue;
    }
    // Mongoose's timestamps option adds $setOnInsert.createdAt to every
    // update. Without upsert (refused above) it can never apply.
    if (operator === '$setOnInsert' && isPlainObject(value)) {
      if (Object.keys(value).every((path) => path === 'createdAt')) {
        continue;
      }
    }
    return false;
  }
  const set = update.$set;
  if (!isPlainObject(set) || set.cancelled !== true) {
    return false;
  }
  return Object.keys(set).every((path) => CANCELLATION_PATHS.has(path));
};

export function immutableRecord(schema: Schema, options: ImmutableRecordOptions = {}): void {
  // A save of an existing document is an edit; only inserts are allowed.
  schema.pre('save', function (this: HydratedDocument<unknown>) {
    if (!this.isNew) {
      throw new ImmutableRecordError('save of an existing document');
    }
  });

  schema.pre('deleteOne', { document: true, query: false }, function () {
    throw new ImmutableRecordError('deleteOne');
  });

  for (const operation of QUERY_WRITES) {
    schema.pre(operation, { document: false, query: true }, function () {
      throw new ImmutableRecordError(operation);
    });
  }

  for (const operation of SINGLE_UPDATES) {
    schema.pre(operation, { document: false, query: true }, function (this: AnyQuery) {
      if (options.cancellable && isCancellationUpdate(this)) {
        return;
      }
      throw new ImmutableRecordError(operation);
    });
  }

  // bulkWrite triggers no per-operation middleware, so it can't be checked.
  schema.pre('bulkWrite', function () {
    throw new ImmutableRecordError('bulkWrite');
  });
}
