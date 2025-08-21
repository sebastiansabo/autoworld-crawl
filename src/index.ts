import 'dotenv/config';
import axios from 'axios';
import { createOrUpdateProduct } from './shopify.js';

// Simple CLI tool to import cars from an Apify dataset. You can run
// `npm run build && node dist/index.js <DATASET_ID>` to import a
// dataset manually without going through the webhook. This is useful
// for testing or one-off imports.

async function run() {
  const datasetId = process.argv[2];
  if (!datasetId) {
    console.error('Usage: node dist/index.js <DATASET_ID>');
    process.exit(1);
  }
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
  console.log(`Import completed. Total: ${items.length}, created: ${created}, updated: ${updated}, failed: ${failed}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});