import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import Tenant from '../src/models/Tenant.ts';
import VendorUser from '../src/models/VendorUser.ts';
import {
  billingAuthResolver,
  dashboardAuthResolver,
} from '../src/controllers/middleware/dashboardAuthResolver.ts';
import { requireTenantId } from '../src/context/tenantContext.ts';
import { TenantStatus, UserRole, VendorUserStatus } from '../src/constants/models.ts';

afterEach(() => mock.restoreAll());
describe('billing-only access for suspended vendors', () => {
  const fixture = (status: TenantStatus) => {
    const id = new mongoose.Types.ObjectId();
    mock.method(Tenant.collection, 'findOne', async () => ({ _id: id, slug: 'vendor', status }));
    mock.method(
      VendorUser.collection,
      'findOne',
      async (filter: { tenantId: mongoose.Types.ObjectId }) => {
        assert.equal(String(filter.tenantId), String(id));
        return {
          _id: new mongoose.Types.ObjectId(),
          tenantId: id,
          email: 'vendor@example.test',
          phoneNumber: '263771234567',
          authSubject: 'vendor-sub',
          role: UserRole.VENDOR,
          status: VendorUserStatus.ACTIVE,
          phoneVerified: true,
        };
      },
    );
    mock.method(VendorUser.collection, 'updateOne', async () => ({
      matchedCount: 1,
      modifiedCount: 1,
    }));
    const req = {
      session: {
        auth: {
          sub: 'vendor-sub',
          email: 'vendor@example.test',
          emailVerified: true,
          tenantId: String(id),
        },
      },
    } as unknown as Request;
    const output = { code: 200, body: undefined as unknown, locals: {} as Record<string, unknown> };
    const res = {
      locals: output.locals,
      status: (code: number) => {
        output.code = code;
        return res;
      },
      json: (body: unknown) => {
        output.body = body;
        return res;
      },
    } as unknown as Response;
    return { req, res, output, id };
  };
  it('lets a suspended owner reach billing with their tenant and verified DB role', async () => {
    const { req, res, output, id } = fixture(TenantStatus.SUSPENDED);
    let admitted = false;
    await billingAuthResolver(req, res, () => {
      admitted = true;
      assert.equal(requireTenantId('billing access test'), String(id));
    });
    assert.equal(admitted, true);
    assert.equal(output.code, 200);
    assert.equal((output.locals.actor as { role: string }).role, UserRole.VENDOR);
  });
  it('continues to deny suspended vendors access to ordinary dashboard operations', async () => {
    const { req, res, output } = fixture(TenantStatus.SUSPENDED);
    let admitted = false;
    await dashboardAuthResolver(req, res, () => {
      admitted = true;
    });
    assert.equal(admitted, false);
    assert.equal(output.code, 403);
  });
  it('does not admit pending or rejected tenants to billing', async () => {
    for (const status of [TenantStatus.PENDING, TenantStatus.REJECTED]) {
      const { req, res, output } = fixture(status);
      let admitted = false;
      await billingAuthResolver(req, res, () => {
        admitted = true;
      });
      assert.equal(admitted, false);
      assert.equal(output.code, 403);
      mock.restoreAll();
    }
  });
});
