/**
 * Dev-only seed script: upserts a single local TRIAL tenant so vendor
 * tenant-scoped features (delivery config, catalog, dashboard) can be
 * exercised locally. WhatsApp ids are attached only when the corresponding env
 * vars are set — a WhatsApp-less tenant is fully usable for delivery testing;
 * it just never receives webhook traffic (the resolver matches by
 * phone-number id) and cannot be activated (the ACTIVE gate requires them).
 *
 * Hard-gated on APP_ENV=LOCAL — refuses to run in any other environment so it
 * can never touch a production database by accident.
 *
 * Idempotent: upserts by `email`. Safe to re-run.
 *
 * Usage:  yarn seed:local
 */
import mongoose from 'mongoose';
import { CONFIG } from '../config.ts';
import { logger } from '../services/logger.ts';
import { connectDb } from '../services/database.ts';
import Tenant from '../models/Tenant.ts';
import { TenantStatus, TenantPlan, PaymentMethod, DeliveryMethod } from '../constants/models.ts';
import { DEFAULT_ORDER_FLOW_ID } from '../constants/orderFlow.ts';
import { runWithoutTenant } from '../context/tenantContext.ts';

const TAG = 'SEED_LOCAL_TENANT';

// Dummy ids written by older versions of this script; cleared on re-seed when
// the corresponding env vars are absent so the tenant is truly WhatsApp-less.
const LEGACY_DUMMY_PHONE_NUMBER_ID = 'local-dummy-phone-number-id';
const LEGACY_DUMMY_WABA_ID = 'local-dummy-waba-id';

// Local-dev seeding is deliberately permissive: use the env var when set, else
// a dummy default. The WhatsApp side is not needed to exercise vendor/delivery
// features, so nothing here should block on missing WhatsApp config.
const orDefault = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    logger.info(`[${TAG}] ${name} not set — using default "${fallback}"`);
    return fallback;
  }
  return value;
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

  // Read tenant fields from env with local-friendly fallbacks. The WhatsApp ids
  // are strictly optional — set only when the developer's real local WhatsApp
  // config is present (so the webhook/catalog paths work). No dummies: the
  // seeded tenant should genuinely lack WhatsApp credentials otherwise, so the
  // activation gate can be tested honestly.
  const whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || undefined;
  const whatsappBusinessId =
    process.env.LOCAL_TENANT_WHATSAPP_BUSINESS_ID?.trim() || undefined;
  const displayName = orDefault('LOCAL_TENANT_DISPLAY_NAME', 'Local Test Vendor');
  const email = orDefault('LOCAL_TENANT_EMAIL', 'local-vendor@example.com');
  const country = orDefault('LOCAL_TENANT_COUNTRY', 'Zimbabwe');
  const whatsappCatalogId = process.env.LOCAL_TENANT_WHATSAPP_CATALOG_ID?.trim();
  // Shop origin — required by ring delivery zones. Defaults to Harare CBD.
  const shopLat = Number(orDefault('LOCAL_TENANT_SHOP_LAT', '-17.8292'));
  const shopLng = Number(orDefault('LOCAL_TENANT_SHOP_LNG', '31.0522'));
  // Used as the Meta catalog `link` for every product.
  const facebookPageUrl = orDefault(
    'LOCAL_TENANT_FACEBOOK_PAGE_URL',
    'https://www.facebook.com/local-test-vendor',
  );
  // Always give the local tenant an order flow id so the order handler can pull
  // it from the tenant; env overrides the shared default.
  const orderFlowId =
    process.env.LOCAL_TENANT_WHATSAPP_ORDER_FLOW_ID?.trim() || DEFAULT_ORDER_FLOW_ID;

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
      `Tenant.findOne({ email: ${email} }) + save (upsert by email)`,
      async () => {
        // Find-then-save (rather than findOneAndUpdate) so the pre-validate
        // slug hook runs on first insert. On subsequent runs we update in place
        // and the slug is preserved. Keyed by email — always present, unlike
        // the WhatsApp ids.
        const existing = await Tenant.findOne({ email });

        if (existing) {
          existing.displayName = displayName;
          existing.country = country;
          // WhatsApp ids: set only when provided; when absent, clear the dummy
          // values older versions of this script wrote (real ids are never
          // clobbered) so the tenant is genuinely WhatsApp-less.
          if (whatsappPhoneNumberId) {
            existing.whatsappPhoneNumberId = whatsappPhoneNumberId;
          } else if (existing.whatsappPhoneNumberId === LEGACY_DUMMY_PHONE_NUMBER_ID) {
            existing.whatsappPhoneNumberId = undefined;
          }
          if (whatsappBusinessId) {
            existing.whatsappBusinessId = whatsappBusinessId;
          } else if (existing.whatsappBusinessId === LEGACY_DUMMY_WABA_ID) {
            existing.whatsappBusinessId = undefined;
          }
          existing.status = TenantStatus.TRIAL;
          existing.plan = TenantPlan.FREE;
          existing.paymentMethods = Object.values(PaymentMethod);
          existing.deliveryMethods = Object.values(DeliveryMethod);
          existing.location_gps = { latitude: shopLat, longitude: shopLng };
          existing.facebookPageUrl = facebookPageUrl;
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
          ...(whatsappPhoneNumberId ? { whatsappPhoneNumberId } : {}),
          ...(whatsappBusinessId ? { whatsappBusinessId } : {}),
          ...(whatsappCatalogId ? { whatsappCatalogId } : {}),
          whatsappFlowIds: orderFlowId ? { order: orderFlowId } : {},
          paymentMethods: Object.values(PaymentMethod),
          deliveryMethods: Object.values(DeliveryMethod),
          location_gps: { latitude: shopLat, longitude: shopLng },
          facebookPageUrl,
          ...(paynowCredentials ? { paymentCredentials: { paynow: paynowCredentials } } : {}),
        });
        logger.info(
          `[${TAG}] Created local tenant slug="${created.slug}" id=${created._id?.toString()}`,
        );
      },
    );
  } catch (error) {
    logger.error(`[${TAG}] Seed failed: ${error instanceof Error ? error.message : String(error)}`);
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
