import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { CONFIG } from '../../config.ts';
import { runWithTenant, runWithoutTenant } from '../../context/tenantContext.ts';
import { ProductStatus, TenantStatus } from '../../constants/models.ts';
import ProductModel from '../../models/Product.ts';
import TenantModel from '../../models/Tenant.ts';
import { logger } from '../../services/logger.ts';
import { buildCatalogFeed, getPublicProductUrl } from '../../utils/catalogFeed.ts';
import { formatMoney } from '../../utils/metaProductFeed.ts';

const TAG = '[CATALOG_FEED]';
const ALLOWED_TENANT_STATUSES = new Set([TenantStatus.ACTIVE, TenantStatus.TRIAL]);
const SKIPPED_PRODUCT_LOG_LIMIT = 20;

const resolvePublicTenant = async (slug: string) =>
  runWithoutTenant('public catalog tenant resolution', 'Tenant.findOne by catalog slug', () =>
    TenantModel.findOne({ slug }).select('_id slug displayName status').lean(),
  );

const isFeedTenant = (
  tenant: Awaited<ReturnType<typeof resolvePublicTenant>>,
): tenant is NonNullable<Awaited<ReturnType<typeof resolvePublicTenant>>> =>
  Boolean(tenant && ALLOWED_TENANT_STATUSES.has(tenant.status));

/** Meta periodically fetches this complete-replacement CSV feed. */
export const catalogFeedHandler = async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);
  const tenant = await resolvePublicTenant(slug);
  if (!isFeedTenant(tenant)) {
    res.status(404).json({ error: 'Catalog not found.' });
    return;
  }

  await runWithTenant(
    tenant._id as Types.ObjectId,
    async () => {
      const products = await ProductModel.find({ status: ProductStatus.ACTIVE })
        .sort({ sku: 1 })
        .lean();
      const result = buildCatalogFeed(products, {
        publicBaseUrl: CONFIG.PUBLIC_BASE_URL,
        tenantSlug: tenant.slug,
        tenantDisplayName: tenant.displayName,
      });

      if (result.skipped.length > 0) {
        const skippedSample = result.skipped
          .slice(0, SKIPPED_PRODUCT_LOG_LIMIT)
          .map((product) => `${product.sku} (${product.reasons.join(', ')})`)
          .join('; ');
        const remaining = result.skipped.length - SKIPPED_PRODUCT_LOG_LIMIT;
        logger.warn(
          `${TAG} skipped ${result.skipped.length} invalid active product(s): ${skippedSample}${
            remaining > 0 ? `; ... ${remaining} more` : ''
          }`,
        );
      }
      logger.info(`${TAG} served ${result.included} active product(s)`);

      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `inline; filename="${tenant.slug}-products.csv"`,
        'Cache-Control': 'no-cache',
      });
      res.status(200).send(result.csv);
    },
    tenant.slug,
  );
};

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] as string,
  );

/** Public, exact product landing page required by Meta's `link` feed field. */
export const publicProductHandler = async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);
  const sku = String(req.params.sku);
  const tenant = await resolvePublicTenant(slug);
  if (!isFeedTenant(tenant)) {
    res.status(404).send('Product not found.');
    return;
  }

  await runWithTenant(
    tenant._id as Types.ObjectId,
    async () => {
      const product = await ProductModel.findOne({ sku, status: ProductStatus.ACTIVE }).lean();
      if (!product) {
        res.status(404).send('Product not found.');
        return;
      }

      const canonicalUrl = getPublicProductUrl(CONFIG.PUBLIC_BASE_URL, tenant.slug, product.sku);
      const title = escapeHtml(product.title);
      const description = escapeHtml(product.description);
      const image = product.imageLink ? escapeHtml(product.imageLink) : '';
      const availability = escapeHtml(product.availability.replace(/_/g, ' '));
      const tenantName = escapeHtml(tenant.displayName);
      const price = escapeHtml(formatMoney(product.price));

      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Content-Security-Policy':
          "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ${tenantName}</title>
  <meta name="description" content="${description}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  ${image ? `<meta property="og:image" content="${image}">` : ''}
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <style>
    body { color: #1d2939; font-family: system-ui, sans-serif; margin: 0; background: #f8fafc; }
    main { box-sizing: border-box; max-width: 760px; margin: 40px auto; padding: 24px; }
    article { background: white; border: 1px solid #e4e7ec; border-radius: 18px; overflow: hidden; }
    img { display: block; width: 100%; max-height: 520px; object-fit: contain; background: #f2f4f7; }
    section { padding: 28px; }
    h1 { margin: 6px 0 12px; font-size: clamp(1.75rem, 5vw, 2.5rem); }
    p { line-height: 1.6; white-space: pre-wrap; }
    .merchant, .availability { color: #667085; text-transform: capitalize; }
    .price { font-size: 1.35rem; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <article>
      ${image ? `<img src="${image}" alt="${title}">` : ''}
      <section>
        <div class="merchant">${tenantName}</div>
        <h1>${title}</h1>
        <div class="price">${price}</div>
        <div class="availability">${availability}</div>
        <p>${description}</p>
      </section>
    </article>
  </main>
</body>
</html>`);
    },
    tenant.slug,
  );
};
