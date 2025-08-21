import axios from 'axios';
import Bottleneck from 'bottleneck';
import sqlite3 from 'sqlite3';

/*
 * Shopify Admin API version to use. Default to the most recent stable
 * release that supports our needs. You can override this via
 * SHOPIFY_API_VERSION in your environment.
 */
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

/*
 * Initialize a SQLite database to persist mappings between our internal
 * stock IDs and Shopify product/variant IDs. This allows the importer
 * to update existing products without having to search Shopify each
 * time. The database file is stored in the project directory under
 * `db.sqlite`.
 */
const db = new sqlite3.Database('db.sqlite');
db.serialize(() => {
  db.run(
    'CREATE TABLE IF NOT EXISTS cars (stock_id TEXT PRIMARY KEY, product_id INTEGER, variant_id INTEGER)',
  );
});

/**
 * Helper to get the Shopify mapping for a given stock ID. Returns
 * nulls if no mapping exists.
 */
function getMapping(stockId: string): Promise<{ productId: number | null; variantId: number | null }> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT product_id, variant_id FROM cars WHERE stock_id = ?',
      [stockId],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve({ productId: null, variantId: null });
        resolve({ productId: row.product_id as number, variantId: row.variant_id as number });
      },
    );
  });
}

/**
 * Helper to persist the mapping between stock ID and Shopify IDs. If a
 * mapping already exists, it is replaced. This function is idempotent.
 */
function setMapping(stockId: string, productId: number, variantId: number) {
  return new Promise<void>((resolve, reject) => {
    db.run(
      'INSERT OR REPLACE INTO cars (stock_id, product_id, variant_id) VALUES (?, ?, ?)',
      [stockId, productId, variantId],
      (err) => {
        if (err) return reject(err);
        resolve();
      },
    );
  });
}

/**
 * Throttle Shopify API requests to avoid hitting the rate limit. Shopify
 * allows 2 requests per second on basic plans. We configure Bottleneck
 * to allow up to 2 concurrent requests with a 500ms minimum time
 * between them.
 */
const limiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: 500,
});

/**
 * Generic wrapper around axios to call the Shopify REST Admin API.
 * Automatically appends the shop domain, API version and sets
 * authentication headers.
 */
async function shopifyApi(method: 'get' | 'post' | 'put' | 'delete', endpoint: string, data?: any) {
  const shopDomain = process.env.SHOPIFY_SHOP || '';
  if (!shopDomain) throw new Error('SHOPIFY_SHOP is not defined');
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error('SHOPIFY_ADMIN_TOKEN is not defined');
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;
  return axios({
    method,
    url,
    data,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

/**
 * Convert a number (e.g. price or compareAtPrice) into a Shopify
 * formatted string with two decimal places. Shopify expects strings
 * instead of numbers for prices.
 */
function formatMoney(value: number | undefined): string | undefined {
  if (value === undefined || value === null || isNaN(value)) return undefined;
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * Build a list of metafields describing the car. Shopify uses
 * namespaces and keys to organize metafields. All car metadata is
 * stored under the "specs" namespace. We set each key's type
 * appropriately. The API will update existing metafields when they
 * share the same namespace and key.
 */
function buildMetafields(car: any) {
  const fields: any[] = [];
  const push = (key: string, value: any, type: string) => {
    if (value === undefined || value === null || value === '') return;
    fields.push({ namespace: 'specs', key, value: String(value), type });
  };
  push('stock_id', car.stockId, 'single_line_text_field');
  push('vat', car.vatType, 'single_line_text_field');
  push('year', car.year, 'number_integer');
  push('mileage_km', car.mileageKm, 'number_integer');
  push('horsepower', car.horsepower, 'number_integer');
  push('displacement_cc', car.displacementCc, 'number_integer');
  push('fuel', car.fuel, 'single_line_text_field');
  push('transmission', car.transmission, 'single_line_text_field');
  push('drivetrain', car.drivetrain, 'single_line_text_field');
  push('body', car.body, 'single_line_text_field');
  // Save the normalized URL for traceability
  push('url', car.url, 'url');
  return fields;
}

/**
 * Creates a new product or updates an existing one based on the stock
 * ID. Returns an object describing whether the product was created or
 * updated along with the product and variant IDs.
 */
export async function createOrUpdateProduct(car: any): Promise<{ created: boolean; productId: number; variantId: number }> {
  const mapping = await getMapping(car.stockId);
  // Compose the product body HTML using car features. We join features
  // with commas and wrap in a paragraph tag.
  const bodyHtml = car.features && car.features.length > 0 ? `<p>${car.features.join(', ')}</p>` : '';
  // Compose tags. Tags should be comma-separated strings. We include
  // features and high-level specs such as fuel and transmission.
  const tags = Array.from(
    new Set(
      ([] as string[])
        .concat(car.features || [])
        .concat(car.fuel || [])
        .concat(car.transmission || [])
        .concat(car.drivetrain || []),
    ),
  )
    .filter(Boolean)
    .join(', ');
  // Map images array into Shopify's expected format. Shopify will fetch
  // remote images from their external source when the product is
  // created or updated.
  const images = (car.images || []).map((img: any) => ({ src: img.src, alt: img.alt ?? car.title }));
  // Build the metafields array.
  const metafields = buildMetafields(car);
  // Determine whether to create or update the product
  if (!mapping.productId) {
    // Create new product
    const payload = {
      product: {
        title: car.title,
        vendor: car.brand ?? '',
        product_type: car.body ?? '',
        body_html: bodyHtml,
        tags,
        variants: [
          {
            sku: `AWG-${car.stockId}`,
            price: formatMoney(car.priceEur) ?? undefined,
            compare_at_price: formatMoney(car.compareAtPriceEur) ?? undefined,
            inventory_quantity: 1,
            inventory_management: 'shopify',
          },
        ],
        images,
        metafields,
      },
    };
    const res = await limiter.schedule(() => shopifyApi('post', 'products.json', payload));
    const product = res.data.product;
    const variant = product.variants && product.variants[0];
    const productId = product.id;
    const variantId = variant ? variant.id : null;
    if (productId && variantId) {
      await setMapping(car.stockId, productId, variantId);
    }
    return { created: true, productId, variantId: variantId || 0 };
  } else {
    // Update existing product
    const { productId, variantId } = mapping;
    if (!productId) throw new Error('Product ID missing in mapping');
    // Update product metadata
    const productPayload = {
      product: {
        id: productId,
        title: car.title,
        vendor: car.brand ?? '',
        product_type: car.body ?? '',
        body_html: bodyHtml,
        tags,
        images,
        metafields,
      },
    };
    await limiter.schedule(() => shopifyApi('put', `products/${productId}.json`, productPayload));
    // Update variant pricing and SKU if variant ID is known
    if (variantId) {
      const variantPayload = {
        variant: {
          id: variantId,
          price: formatMoney(car.priceEur) ?? undefined,
          compare_at_price: formatMoney(car.compareAtPriceEur) ?? undefined,
          sku: `AWG-${car.stockId}`,
        },
      };
      await limiter.schedule(() => shopifyApi('put', `variants/${variantId}.json`, variantPayload));
    }
    return { created: false, productId, variantId: variantId || 0 };
  }
}