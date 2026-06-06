/**
 * Dev-only seed script: upserts a single local tenant so the WhatsApp webhook
 * resolver in src/controllers/middleware/whatsappTenantResolver.ts can find a
 * matching tenant for the developer's test WhatsApp number.
 *
 * Hard-gated on APP_ENV=LOCAL — refuses to run in any other environment so it
 * can never touch a production database by accident.
 *
 * Idempotent: upserts by `whatsappPhoneNumberId`. Safe to re-run.
 *
 * Usage:  yarn seed:local
 */
import mongoose from 'mongoose';
import { CONFIG } from '../config';
import { logger } from '../services/logger';
import { connectDb } from '../services/database';
import Tenant from '../models/Tenant';
import {
  TenantStatus,
  TenantPlan,
  PaymentMethod,
  DeliveryMethod,
} from '../constants/models';
import { DEFAULT_ORDER_FLOW_ID } from '../constants/orderFlow';
import { runWithoutTenant } from '../context/tenantContext';

const TAG = 'SEED_LOCAL_TENANT';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    logger.error(
      `[${TAG}] Missing required env var "${name}". Add it to your .env before running yarn seed:local.`,
    );
    process.exit(1);
  }
  return value.trim();
};

const run = async (): Promise<void> => {
  // Fail-closed: this script writes to whatever Mongo cluster CONFIG points at.
  // Refuse to run unless we're in LOCAL — never trust CLI flags or NODE_ENV.
  if (!CONFIG.IS_LOCAL_ENVIRONMENT) {
    logger.error(
      `[${TAG}] Refusing to run: APP_ENV is not LOCAL. This script only runs in local development.`,
    );
    process.exit(1);
  }

  // Read tenant fields from env. WHATSAPP_PHONE_NUMBER_ID is already mandatory
  // in config.ts; the rest are seed-only and validated here.
  const whatsappPhoneNumberId = required('WHATSAPP_PHONE_NUMBER_ID');
  const displayName = required('LOCAL_TENANT_DISPLAY_NAME');
  const email = required('LOCAL_TENANT_EMAIL');
  const country = required('LOCAL_TENANT_COUNTRY');
  const whatsappBusinessId = required('LOCAL_TENANT_WHATSAPP_BUSINESS_ID');
  const whatsappCatalogId = process.env.LOCAL_TENANT_WHATSAPP_CATALOG_ID?.trim();
  // Always give the local tenant an order flow id so the order handler can pull
  // it from the tenant; env overrides the shared default.
  const orderFlowId =
    process.env.LOCAL_TENANT_WHATSAPP_ORDER_FLOW_ID?.trim() ||
    DEFAULT_ORDER_FLOW_ID;

  // Paynow credentials are optional for seeding — only set them if all three
  // are present so a partially configured tenant can't reach the gateway with a
  // half-filled credential set. Absent = the tenant simply has no Paynow config.
  const paynowIntegrationId = process.env.LOCAL_TENANT_PAYNOW_INTEGRATION_ID?.trim();
  const paynowIntegrationKey = process.env.LOCAL_TENANT_PAYNOW_INTEGRATION_KEY?.trim();
  const paynowAuthEmail = process.env.LOCAL_TENANT_PAYNOW_AUTH_EMAIL?.trim();
  const paynowCredentials =
    paynowIntegrationId && paynowIntegrationKey && paynowAuthEmail
      ? {
          integrationId: paynowIntegrationId,
          integrationKey: paynowIntegrationKey,
          authEmail: paynowAuthEmail,
        }
      : undefined;

  await connectDb();

  try {
    await runWithoutTenant(
      'local tenant seed',
      `Tenant.findOneAndUpdate({ whatsappPhoneNumberId: ${whatsappPhoneNumberId} }, upsert)`,
      async () => {
        // Find-then-save (rather than findOneAndUpdate) so the pre-validate
        // slug hook runs on first insert. On subsequent runs we update in place
        // and the slug is preserved.
        const existing = await Tenant.findOne({ whatsappPhoneNumberId });

        if (existing) {
          existing.displayName = displayName;
          existing.email = email;
          existing.country = country;
          existing.whatsappBusinessId = whatsappBusinessId;
          existing.status = TenantStatus.TRIAL;
          existing.plan = TenantPlan.FREE;
          existing.paymentMethods = Object.values(PaymentMethod);
          existing.deliveryMethods = Object.values(DeliveryMethod);
          if (whatsappCatalogId) {
            existing.whatsappCatalogId = whatsappCatalogId;
          }
          if (orderFlowId) {
            existing.whatsappFlowIds = {
              ...existing.whatsappFlowIds,
              order: orderFlowId,
            };
          }
          if (paynowCredentials) {
            existing.paymentCredentials = {
              ...existing.paymentCredentials,
              paynow: paynowCredentials,
            };
          }
          await existing.save();
          logger.info(
            `[${TAG}] Updated existing local tenant slug="${existing.slug}" id=${existing._id?.toString()}`,
          );
          return;
        }

        const created = await Tenant.create({
          status: TenantStatus.TRIAL,
          plan: TenantPlan.FREE,
          displayName,
          email,
          country,
          whatsappPhoneNumberId,
          whatsappBusinessId,
          ...(whatsappCatalogId ? { whatsappCatalogId } : {}),
          whatsappFlowIds: orderFlowId ? { order: orderFlowId } : {},
          paymentMethods: Object.values(PaymentMethod),
          deliveryMethods: Object.values(DeliveryMethod),
          ...(paynowCredentials ? { paymentCredentials: { paynow: paynowCredentials } } : {}),
        });
        logger.info(
          `[${TAG}] Created local tenant slug="${created.slug}" id=${created._id?.toString()}`,
        );
      },
    );
  } catch (error) {
    logger.error(
      `[${TAG}] Seed failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  await mongoose.disconnect();
  logger.info(`[${TAG}] Done.`);
  process.exit(0);
};

run().catch(async (error) => {
  logger.error(
    `[${TAG}] Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
  );
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
