# AutoWorld Car Importer - Claude Instructions

## Project Overview
This is a Node.js/TypeScript application that imports car data from Apify datasets into Shopify. It serves as a bridge between an Apify web crawler and a Shopify store, automatically creating and updating product listings.

## Architecture
- **Express server** (`src/server.ts`) - Webhook endpoint for Apify integration
- **CLI tool** (`src/index.ts`) - Manual dataset import utility  
- **Shopify integration** (`src/shopify.ts`) - Product creation/update logic with rate limiting
- **SQLite database** (`db.sqlite`) - Maps stock IDs to Shopify product/variant IDs

## Key Commands

### Development
```bash
npm run dev          # Start development server with ts-node
npm run build        # Compile TypeScript to JavaScript
npm start            # Run production server from dist/
```

### Manual Import
```bash
npm run build && node dist/index.js <DATASET_ID>
```

### Docker
```bash
docker build -t autoworld-importer .
docker run -p 8080:8080 autoworld-importer
```

## Environment Variables
Required for operation:
- `SHOPIFY_SHOP` - Shopify store domain (e.g., "mystore.myshopify.com")
- `SHOPIFY_ADMIN_TOKEN` - Admin API access token
- `IMPORT_AUTH_TOKEN` - Bearer token for webhook authentication
- `APIFY_TOKEN` - Optional, for authenticated Apify API access
- `SHOPIFY_API_VERSION` - Optional, defaults to "2024-04"
- `PORT` - Optional, defaults to 8080

## API Endpoints
- `POST /import` - Webhook endpoint for Apify dataset imports
- `GET /healthz` - Health check endpoint

## Database Schema
SQLite table `cars`:
- `stock_id` (TEXT PRIMARY KEY) - Unique car identifier
- `product_id` (INTEGER) - Shopify product ID
- `variant_id` (INTEGER) - Shopify variant ID

## Rate Limiting
Shopify API calls are throttled to 2 requests/second (500ms minimum between calls) using Bottleneck library.

## Data Flow
1. Apify webhook triggers `/import` endpoint with dataset ID
2. Server fetches car data from Apify API
3. For each car:
   - Check SQLite for existing Shopify mapping
   - Create new product or update existing one
   - Store/update mapping in database
4. Return summary of created/updated/failed items

## File Structure
```
├── src/
│   ├── index.ts     # CLI import tool
│   ├── server.ts    # Express webhook server
│   └── shopify.ts   # Shopify API integration
├── Dockerfile       # Apify-compatible container
├── package.json     # Dependencies and scripts
└── tsconfig.json    # TypeScript configuration
```

## Development Notes
- Uses ES modules (`"type": "module"` in package.json)
- TypeScript compiled to ES2022 target
- Apify Docker base image includes Playwright for browser automation
- Images are handled remotely (Shopify fetches from external URLs)
- Metafields store car specifications under "specs" namespace

## Troubleshooting
- Check environment variables are properly set
- Verify Shopify Admin API permissions include products read/write
- Monitor rate limiting if seeing 429 errors
- Check SQLite database for mapping consistency
- Validate Apify dataset format matches expected car schema