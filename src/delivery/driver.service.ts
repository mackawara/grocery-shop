import { runWithTenant } from '../context/tenantContext.ts';
import DriverModel from './models/Driver.ts';
import type { IDriver } from './models/Driver.ts';

export interface DriverInput {
  name: string;
  // Callers normalize before handing it over (the HTTP adapter does this in its
  // zod schema) — the service stores what it is given.
  phoneNumber: string;
  active?: boolean;
  notes?: string;
}

// --- Driver roster CRUD. Each takes tenantId and scopes itself, like the rest
// of the module, so the service owns its tenant boundary. ---

export const createDriver = (tenantId: string, input: DriverInput): Promise<IDriver> =>
  runWithTenant(tenantId, () => DriverModel.create(input));

export const listDrivers = (tenantId: string): Promise<IDriver[]> =>
  runWithTenant(tenantId, () => DriverModel.find().sort({ active: -1, name: 1 }));

export const getDriver = (tenantId: string, id: string): Promise<IDriver | null> =>
  runWithTenant(tenantId, () => DriverModel.findById(id));

export const updateDriver = (
  tenantId: string,
  id: string,
  patch: Partial<DriverInput>,
): Promise<IDriver | null> =>
  runWithTenant(tenantId, async () => {
    const driver = await DriverModel.findById(id);
    if (!driver) {
      return null;
    }
    driver.set(patch);
    await driver.save();
    return driver;
  });

export const deleteDriver = (tenantId: string, id: string): Promise<boolean> =>
  runWithTenant(tenantId, async () => {
    const result = await DriverModel.deleteOne({ _id: id });
    return result.deletedCount > 0;
  });
