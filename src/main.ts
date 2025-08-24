import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';
import * as cheerio from 'cheerio';

/**
 * This crawler scrapes the Autoworld vehicle catalog. It scrolls each listing
 * page to load all cars, extracts every product link, and follows the
 * pagination links dynamically. On detail pages it extracts a rich set of
 * attributes (stock ID, VIN, price, compare price, year, mileage, engine
 * displacement and horsepower, drivetrain, fuel, transmission, body type,
 * colour, VAT status, feature list and an additional description). To avoid
 * endless loops through similar car suggestions, the crawler deduplicates
 * vehicles by their stock ID and limits listing pages to a configurable
 * maximum. Colour strings are cleaned to remove the trailing “An fabricare”
 * label. Features are filtered through whitelists and reject lists to
 * minimise noise.
 */

// How many listing pages to crawl. The Autoworld site currently has ~3 pages,
// but this can be increased if more pages are added. Set to a generous
// number to future‑proof the crawler without risking infinite loops.
const MAX_PAGES = 20;

// Regular expression used to identify detail pages. Links matching this
// pattern are treated as vehicle detail pages. The pattern captures any
// ``/stoc/<slug>-ID<number>`` path, optionally with query parameters.
const DETAIL_HREF = /\/stoc\/[^?#]*-ID\d+/i;

// A set to track processed stock IDs. If a detail page shares the same
// ``stockId`` value as a previously scraped vehicle, it will be skipped.
const seenStockIds = new Set<string>();

// A set to track listing pages we have already visited. This prevents the
// crawler from revisiting pages when pagination links appear in unexpected
// places (e.g. footer, similar vehicles section) and helps avoid loops.
const visitedListingUrls = new Set<string>();

// Helper to pause execution for a given number of milliseconds.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scrolls down the page in increments to ensure all lazy‑loaded elements are
 * rendered. The Autoworld listing uses infinite scroll on some pages.
 *
 * @param page Playwright page object
 * @param maxRounds maximum scroll iterations
 */
async function autoScroll(page: any, maxRounds = 50) {
    let lastCount = 0;
    for (let i = 0; i < maxRounds; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await sleep(700);
        const count = await page.locator('a').count().catch(() => 0);
        if (count === lastCount) break;
        lastCount = count;
    }
}

// Whitelist of feature keywords. Only items containing one of these terms
// (case‑insensitive) will be considered a valid feature.
const FEATURE_KEYWORDS = new RegExp(
    [
        'Carplay', 'Android', 'Bluetooth', 'Naviga', 'Cruise', 'Senzori?', 'Sensor',
        'Camera', 'ABS', 'ESP', 'Jante', 'Airbag', 'Isofix', 'Keyless', 'Lane',
        'LED', 'Volan', 'Scaun', 'Lumini', 'Climat', 'Tracti', 'Port', 'Monitor',
        'Radio', 'Adaptive', 'Start', 'Stop', 'Park', 'Privacy', 'Pre\s*coliz',
        'Asisten', 'Sistem', 'USB', 'Servo', 'Geamuri', 'Cotiera', 'Audio',
        'ESP', 'Pilot', 'Suport', 'Head\s*up', 'Blind\s*Spot', 'ACC'
    ].join('|'),
    'i'
);

// Reject patterns for text that should not be recorded as a feature. This
// includes navigation labels, legal notices and form fields.
const FEATURE_REJECT = new RegExp(
    [
        'Despre', 'Politic', 'Servicii', 'Platform', 'Solicit', 'Finan',
        'Contact', 'Nume', 'Telefon', 'E[- ]?mail', 'Mesaj', 'Comand',
        'Consult', 'Plata', 'Credit', 'Rezultate', 'Proprietar', 'Vinde',
        'Termen', 'Conditions', 'Copyright', 'Cookies', 'Utilizare'
    ].join('|'),
    'i'
);

/**
 * Parses and normalises the colour string. The source HTML sometimes
 * concatenates the colour and the next table label (“An fabricare”). This
 * helper trims the trailing label and returns a clean colour name.
 *
 * @param rawColour the raw colour text extracted from the body
 */
function cleanColour(rawColour: string): string {
    if (!rawColour) return '';
    // Remove everything after the word “An” (e.g. “Alb Metalizat An fabricare”).
    return rawColour.replace(/\bAn\s*fabricare.*$/i, '').trim();
}

// Main crawler logic. We create and run the PlaywrightCrawler inside an
// asynchronous context so that we can await its completion.
await Actor.init();

// Read actor input. Casting to any avoids TypeScript complaining about
// unknown properties such as ``baseUrl`` when no schema is defined.
const input: any = (await Actor.getInput()) || {};
const baseUrl: string = input.baseUrl || 'https://www.autoworldgrup.ro/stoc';

const crawler = new PlaywrightCrawler({
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 120,
    // We run headless; set ``headless: false`` for debugging.
    headless: true,
    async requestHandler({ page, request, addRequests }) {
        // If this request is not labelled, treat it as a listing page.
        if (!request.label) {
            const currentUrl = request.url;
            if (visitedListingUrls.has(currentUrl)) {
                return;
            }
            visitedListingUrls.add(currentUrl);
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
            await autoScroll(page, 60);

            const html = await page.content();
            const $ = cheerio.load(html);
            // Extract product detail links
            const detailLinks: any[] = [];
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                if (DETAIL_HREF.test(href)) {
                    // Build absolute URL relative to current listing page
                    const absUrl = href.startsWith('http') ? href : new URL(href, currentUrl).toString();
                    detailLinks.push({ url: absUrl, label: 'DETAIL' });
                }
            });
            if (detailLinks.length) {
                await addRequests(detailLinks);
            }
            // Determine and enqueue next listing page
            try {
                const urlObj = new URL(currentUrl);
                const pageParam = urlObj.searchParams.get('p');
                const typeParam = urlObj.searchParams.get('type');
                const currentPageNum = pageParam ? parseInt(pageParam, 10) : 1;
                const nextPageNum = currentPageNum + 1;
                if (nextPageNum <= MAX_PAGES) {
                    urlObj.searchParams.set('p', String(nextPageNum));
                    // Preserve the ``type`` query parameter if present
                    if (typeParam) {
                        urlObj.searchParams.set('type', typeParam);
                    }
                    const nextUrl = urlObj.toString();
                    if (!visitedListingUrls.has(nextUrl)) {
                        await addRequests([{ url: nextUrl }]);
                    }
                }
            } catch (err) {
                log.warning(`Failed to compute next page from ${currentUrl}: ${err}`);
            }
            return;
        }
        // Detail page handler
        await page.goto(request.url, { waitUntil: 'domcontentloaded' });
        const html = await page.content();
        const $ = cheerio.load(html);
        const bodyText = $('body').text();
        const title = $('h1,h2,h3,h4,h5').first().text().trim();
        // Extract stock ID from page text or URL
        let stockId = bodyText.match(/ID\s*stoc\s*[:\-]?\s*(\d+)/i)?.[1] || '';
        if (!stockId) {
            const urlMatch = request.url.match(/-ID(\d+)/i);
            if (urlMatch) stockId = urlMatch[1];
        }
        if (!stockId) {
            log.warning(`No stock ID found for ${request.url}`);
            return;
        }
        if (seenStockIds.has(stockId)) return;
        seenStockIds.add(stockId);
        // Extract VIN (17 chars typical)
        const vinMatch = bodyText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
        const vin = vinMatch ? vinMatch[1] : undefined;
        // Parse prices
        const priceTxt = bodyText.match(/(\d{1,3}(?:\.\d{3})*)\s*EUR/i)?.[1];
        const priceEur = priceTxt ? parseInt(priceTxt.replace(/\./g, ''), 10) : undefined;
        const compareTxt = bodyText.match(/Preț\s*de\s*listă\s*(\d{1,3}(?:\.\d{3})*)\s*EUR/i)?.[1];
        const compareAtPriceEur = compareTxt ? parseInt(compareTxt.replace(/\./g, ''), 10) : undefined;
        // Parse year, mileage and specs
        const year = parseInt(bodyText.match(/\b(20\d{2})\b/)?.[1] || '') || undefined;
        const horsepower = parseInt(bodyText.match(/(\d+)\s*CP/i)?.[1] || '') || undefined;
        const displacementMatch = bodyText.match(/(\d{1,2})\.(\d{3})\s*cm/i);
        const displacementCc = displacementMatch ? parseInt(displacementMatch[0].replace(/[^0-9]/g, ''), 10) : undefined;
        const kmMatch = bodyText.match(/(\d{1,3}(?:\.\d{3})*)\s*km/i)?.[1];
        const mileageKm = kmMatch ? parseInt(kmMatch.replace(/\./g, ''), 10) : undefined;
        const fuel = (bodyText.match(/Benzina|Diesel|Electric|Hibrid\s*Plug\-In|Hibrid/i)?.[0] || '').trim();
        const transmission = (bodyText.match(/Automata|Manuala|CVT|dublu\s+ambreiaj/i)?.[0] || '').trim();
        const drivetrain = (bodyText.match(/4x4|Fata|Spate/i)?.[0] || '').trim();
        const bodyType = (bodyText.match(/SUV|Sedan|Combi|Cabrio|Compacta|Coupe|Monovolum/i)?.[0] || '').trim();
        // Colour: find table row labelled Culoare
        let rawColour = '';
        $('th').each((_, th) => {
            const header = $(th).text().trim();
            if (/Culoare/i.test(header)) {
                const val = $(th).next('td').text().trim();
                if (val) rawColour = val;
            }
        });
        if (!rawColour) {
            rawColour = bodyText.match(/Culoare\s*([A-Za-zĂÂÎȘȚăâîșț ]+)/i)?.[1] || '';
        }
        const color = cleanColour(rawColour);
        // VAT status
        let vatType = '';
        if (/TVA\s+deductibil/i.test(bodyText)) vatType = 'deductibil';
        else if (/TVA\s+nedeductibil/i.test(bodyText)) vatType = 'nedeductibil';
        else if (/TVA/i.test(bodyText)) vatType = 'necunoscut';
        // Extract features from bullets and spans
        const featuresSet = new Set<string>();
        const collectFeature = (txt: string) => {
            const trimmed = txt.trim();
            if (!trimmed) return;
            if (!FEATURE_KEYWORDS.test(trimmed)) return;
            if (FEATURE_REJECT.test(trimmed)) return;
            featuresSet.add(trimmed);
        };
        // Badges under title or anywhere
        $('a, span, li, p, div').each((_, el) => {
            const text = $(el).text().trim();
            if (!text) return;
            collectFeature(text);
        });
        // Parse dotari section after “Dotări” or “Dotari”
        const dotariMatch = bodyText.split(/Dot[aă]ri[^:]*:/i)[1];
        if (dotariMatch) {
            dotariMatch.split(/[;,\n]+/).forEach((f) => collectFeature(f));
        }
        // Additional description
        let extraDescription = '';
        $('h3,h4,h2').each((_, el) => {
            const header = $(el).text().trim();
            if (/Descriere/i.test(header)) {
                const para = $(el).nextAll('p').first().text().trim();
                if (para) extraDescription = para;
            }
        });
        // Images
        const images: { src: string; alt?: string }[] = [];
        $('img').each((_i, img) => {
            const src = $(img).attr('src') || '';
            if (/usercontent\.cdn\.workleto\.com|\/uploads\//.test(src)) {
                const abs = src.startsWith('http') ? src : new URL(src, request.url).toString();
                images.push({ src: abs, alt: title });
            }
        });
        const brand = title.split(' ')[0] || '';
        const model = title.split(' ').slice(1).join(' ');
        await Dataset.pushData({
            stockId,
            vin,
            title,
            url: request.url,
            brand,
            model,
            year,
            mileageKm,
            horsepower,
            fuel,
            transmission,
            drivetrain,
            body: bodyType,
            displacementCc,
            priceEur,
            compareAtPriceEur,
            vatType,
            color,
            // Limit the number of feature entries per vehicle. Although the site
            // can expose dozens of badges and list items, Shopify metafields
            // become unwieldy if we store them all. Keeping the first 30
            // ensures we capture the most relevant equipment without
            // overflowing columns in the dataset or Shopify.  See the
            // `dataset_autoworld-crawl_2025-08-22_14-16-17-659.xlsx` sample
            // where some vehicles have over 40 features—limiting to 30 keeps
            // the export tidy.  The order of insertion is preserved by
            // `featuresSet`, so the earliest features listed on the page
            // (usually the most important) are retained.
            features: Array.from(featuresSet).slice(0, 30),
            extraDescription,
            images: images.slice(0, 24),
        });
    },
});

// Kick off the crawl with the base URL.
await crawler.run([{ url: baseUrl }]);

await Actor.exit();