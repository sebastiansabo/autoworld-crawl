import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { createOrUpdateProduct } from './shopify.js';

// Initialize an Express application. This server exposes a single POST
// endpoint, `/import`, that Apify will call after the crawler run
// succeeds. The handler reads the dataset items from Apify, then
// iterates over them and creates or updates products in Shopify.
const app = express();
app.use(express.json({ limit: '10mb' }));

/**
 * POST /import
 *
 * Accepts a webhook from Apify containing a dataset ID. It then
 * downloads all items from that dataset via the Apify API and
 * iterates through them to create or update products in Shopify.
 *
 * Security: The request must include an Authorization header with a
 * bearer token equal to IMPORT_AUTH_TOKEN defined in the .env file.
 */
app.post('/import', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || '';
    const expected = process.env.IMPORT_AUTH_TOKEN ? `Bearer ${process.env.IMPORT_AUTH_TOKEN}` : '';
    if (expected && authHeader !== expected) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const body: any = req.body || {};
    // datasetId can be passed directly or inside the resource object
    const datasetId = body.datasetId || body?.resource?.defaultDatasetId || body?.payload?.resource?.defaultDatasetId;
    if (!datasetId) {
      return res.status(400).json({ ok: false, error: 'Missing datasetId' });
    }
    // Build the URL to fetch items. The Apify API will paginate large
    // datasets; we request a JSON array and pass `clean=true` to
    // automatically remove internal fields.
    const apifyToken = process.env.APIFY_TOKEN;
    const url = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json`;
    const headers: Record<string, string> = {};
    if (apifyToken) headers['Authorization'] = `Bearer ${apifyToken}`;
    const { data: items } = await axios.get<any[]>(url, { headers, timeout: 30000 });
    let created = 0;
    let updated = 0;
    let failed = 0;
    for (const car of items) {
      try {
        const result = await createOrUpdateProduct(car);
        if (result.created) created++;
        else updated++;
      } catch (err: any) {
        console.error('Failed to upsert product', err?.message || err);
        failed++;
      }
    }
    return res.json({ ok: true, datasetId, total: items.length, created, updated, failed });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
app.listen(port, () => {
  console.log(`Importer listening on port ${port}`);
});