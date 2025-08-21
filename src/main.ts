import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';
import * as cheerio from 'cheerio';

/**
 * Input schema for the crawler. You can override the base URL and other parameters
 * when running the Actor via the Apify console or API.
 */
interface Input {
  baseUrl?: string;
  maxCars?: number;
  useApifyProxy?: boolean;
}

// Regular expression that matches detail page URLs. All car detail pages
// end in `-ID<digits>` so we rely on that pattern to filter links.
const DETAIL_HREF = /\/stoc\/.*-ID\d+/i;

/** Sleep helper to await a given number of milliseconds. Playwright does
 * not provide a built-in sleep so we implement our own.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Auto-scrolls a page to load all lazy-loaded content. Many modern
 * e‑commerce listings employ infinite scroll: as you scroll, more items
 * appear. This helper repeatedly scrolls to the bottom of the page until
 * no new anchors appear or a maximum number of rounds is hit.
 */
async function autoScroll(page: any, maxRounds = 30) {
  let lastAnchorCount = 0;
  for (let i = 0; i < maxRounds; i++) {
    // Scroll down by two viewport heights to trigger loading of more items
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(700);
    // Count all anchor tags on the page. This is used as a proxy for
    // detecting whether new items have loaded. If the count hasn't
    // increased since the last scroll, we break the loop.
    const anchorCount = await page.locator('a').count().catch(() => 0);
    if (anchorCount === lastAnchorCount) break;
    lastAnchorCount = anchorCount;
  }
}

/** Main entrypoint for the Actor. This function is executed when the
 * Actor runs. It sets up the crawler and orchestrates crawling of the
 * listing page followed by detail pages.
 */
await Actor.init();
const input = (await Actor.getInput<Input>()) ?? {};
const baseUrl = input.baseUrl ?? 'https://www.autoworldgrup.ro/stoc';

log.info(`Crawl start: ${baseUrl}`);

// Create a PlaywrightCrawler. This high-level abstraction from Crawlee
// automatically manages concurrency, error handling, retries and more.
const crawler = new PlaywrightCrawler({
  headless: true,
  maxConcurrency: 2,
  requestHandlerTimeoutSecs: 90,
  async requestHandler({ page, request, enqueueLinks }) {
    // If no label is set on the request, treat it as the list page.
    if (!request.label) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      // Perform auto‑scroll to load all items on the list page
      await autoScroll(page, 30);
      // Enqueue all detail links. We use transformRequestFunction to
      // assign a label to each detail request and filter out any
      // non-detail links.
      await enqueueLinks({
        transformRequestFunction: (req) => {
          if (DETAIL_HREF.test(req.url)) {
            req.label = 'DETAIL';
            return req;
          }
          return null;
        },
      });
    } else if (request.label === 'DETAIL') {
      // We are on a detail page. Wait for the DOM to load completely.
      await page.goto(request.url, { waitUntil: 'domcontentloaded' });
      const html = await page.content();
      const $ = cheerio.load(html);
      // Extract all textual content from the body. Some values are only
      // present in text rather than structured elements.
      const bodyText = $('body').text();
      const title = $('h1,h2,h3,h4,h5').first().text().trim();
      // Stock ID can be found either in the text or in the URL.
      let stockId = bodyText.match(/ID\s*stoc:\s*(\d+)/i)?.[1] || '';
      if (!stockId) stockId = request.url.match(/-ID(\d+)/i)?.[1] || '';
      // Price handling: convert "1.234.567" to integer 1234567. Some cars
      // may not have a price listed.
      const priceTxt = bodyText.match(/(\d{1,3}(?:\.\d{3})*)\s*EUR/i)?.[1];
      const priceEur = priceTxt ? parseInt(priceTxt.replace(/\./g, ''), 10) : undefined;
      const compareTxt = bodyText.match(/Preț de listă\s*([0-9\.]+)\s*EUR/i)?.[1];
      const compareAtPriceEur = compareTxt ? parseInt(compareTxt.replace(/\./g, ''), 10) : undefined;
      // Extract additional numeric values
      const year = parseInt(bodyText.match(/\b(20\d{2})\b/)?.[1] || '') || undefined;
      const horsepower = parseInt(bodyText.match(/(\d+)\s*CP/i)?.[1] || '') || undefined;
      // Displacement is sometimes written as "1.598 cm", sometimes "1.6 cm".
      const dispMatch = bodyText.match(/(\d{1,2})\.(\d{3})\s*cm/i)?.[0] || '';
      const displacementCc = dispMatch ? parseInt(dispMatch.replace(/[^0-9]/g, ''), 10) : undefined;
      const kmMatch = bodyText.match(/(\d{1,3}(?:\.\d{3})*)\s*km/i)?.[1];
      const mileageKm = kmMatch ? parseInt(kmMatch.replace(/\./g, ''), 10) : undefined;
      const fuel = (bodyText.match(/Benzina|Diesel|Electric|Hibrid Plug-In|Hibrid/i)?.[0] || '').trim();
      const transmission = (bodyText.match(/Automata|Manuala|CVT|dublu ambreiaj/i)?.[0] || '').trim();
      const drivetrain = (bodyText.match(/4x4|Fata|Spate/i)?.[0] || '').trim();
      const bodyType = (bodyText.match(/SUV|Sedan|Combi|Cabrio|Compacta|Coupe|Monovolum/i)?.[0] || '').trim();
      // Collect features by scanning list items and paragraphs for known
      // keywords. We collect up to 200 unique features.
      const features: string[] = [];
      $('li, p').each((_i, el) => {
        const t = $(el).text().trim();
        if (t && /Bluetooth|Android Auto|Carplay|Senzori|Camera|ABS|ESP|Jante|Airbag|Isofix|Keyless|Lane|Cruise|LED/i.test(t)) {
          features.push(t);
        }
      });
      // Extract image URLs. The listing uses Workleto CDN; we only keep
      // those images and resolve relative URLs to absolute ones.
      const images: { src: string; alt?: string }[] = [];
      $('img').each((_i, img) => {
        const src = $(img).attr('src') || '';
        if (/usercontent\.cdn\.workleto\.com|\/uploads\//.test(src)) {
          const abs = src.startsWith('http') ? src : new URL(src, request.url).toString();
          images.push({ src: abs, alt: title });
        }
      });
      // Build a normalized car object. Fields not found remain undefined.
      const car = {
        stockId,
        title,
        url: request.url,
        brand: title.split(' ')[0] || '',
        model: title.split(' ').slice(1).join(' '),
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
        vatType: /TVA\s+deductibil/i.test(html) ? 'deductibil' : (/TVA\s+nedeductibil/i.test(html) ? 'nedeductibil' : 'necunoscut'),
        features: Array.from(new Set(features)).slice(0, 200),
        images: images.slice(0, 24),
      };
      // Only push to dataset if we have a stock ID. Without one the car
      // cannot be uniquely identified.
      if (car.stockId) await Dataset.pushData(car);
    }
  },
});

// Start crawling the base URL. Crawlee will crawl the list page and
// subsequently all detail pages that were enqueued.
await crawler.run([{ url: baseUrl }]);
log.info('Crawl done — items stored to default Dataset.');
await Actor.exit();