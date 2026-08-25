import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Currency,
  ProductAvailability,
  ProductCondition,
  ProductStatus,
} from '../src/constants/models.ts';
import type { ProductFields } from '../src/models/Product.ts';
import { applyInventoryState } from '../src/controllers/catalog/product.service.ts';
import { buildCatalogFeed, getPublicProductUrl } from '../src/utils/catalogFeed.ts';

const product = (overrides: Partial<ProductFields> = {}): ProductFields => ({
  sku: 'SKU-1',
  title: 'Tomatoes, fresh',
  description: 'A "market" box',
  availability: ProductAvailability.IN_STOCK,
  condition: ProductCondition.NEW,
  price: { amount: 250, currency: Currency.USD },
  imageLink: 'https://images.example.test/tomatoes.png',
  quantity: 4,
  status: ProductStatus.ACTIVE,
  ...overrides,
});

const context = {
  publicBaseUrl: 'https://api.example.test',
  tenantSlug: 'fresh foods',
  tenantDisplayName: 'Fresh Foods',
};

describe('catalog feed', () => {
  it('exports active products with exact product links and valid CSV escaping', () => {
    const result = buildCatalogFeed([product()], context);

    assert.equal(result.included, 1);
    assert.deepEqual(result.skipped, []);
    assert.match(
      result.csv,
      /"https:\/\/api\.example\.test\/catalogs\/fresh%20foods\/products\/SKU-1"/,
    );
    assert.match(result.csv, /"Tomatoes, fresh"/);
    assert.match(result.csv, /"A ""market"" box"/);
    assert.match(result.csv, /"2\.50 USD"/);
  });

  it('keeps out-of-stock products and omits draft, archived, and invalid active products', () => {
    const result = buildCatalogFeed(
      [
        product({ availability: ProductAvailability.OUT_OF_STOCK, quantity: 0 }),
        product({ sku: 'DRAFT', status: ProductStatus.DRAFT }),
        product({ sku: 'ARCHIVED', status: ProductStatus.ARCHIVED }),
        product({ sku: 'NO-IMAGE', imageLink: undefined }),
      ],
      context,
    );

    assert.equal(result.included, 1);
    assert.match(result.csv, /"out of stock"/);
    assert.doesNotMatch(result.csv, /"DRAFT"/);
    assert.doesNotMatch(result.csv, /"ARCHIVED"/);
    assert.deepEqual(result.skipped, [{ sku: 'NO-IMAGE', reasons: ['imageLink'] }]);
  });

  it('URL-encodes tenant slugs and SKUs', () => {
    assert.equal(
      getPublicProductUrl('https://api.example.test/', 'tenant one', 'fruit/veg #1'),
      'https://api.example.test/catalogs/tenant%20one/products/fruit%2Fveg%20%231',
    );
  });
});

describe('inventory state', () => {
  it('marks zero-quantity products out of stock', () => {
    const state = { quantity: 0, availability: ProductAvailability.IN_STOCK };
    applyInventoryState(state);
    assert.equal(state.availability, ProductAvailability.OUT_OF_STOCK);
  });

  it('does not automatically restock a deliberately unavailable product', () => {
    const state = { quantity: 5, availability: ProductAvailability.OUT_OF_STOCK };
    applyInventoryState(state);
    assert.equal(state.availability, ProductAvailability.OUT_OF_STOCK);
  });
});
