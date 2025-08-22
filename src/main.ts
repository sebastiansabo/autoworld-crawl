import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';
import * as cheerio from 'cheerio';

/**
 * Input interface. Allows overriding the base URL to crawl, limiting the
 * maximum number of cars processed and toggling the use of the Apify proxy.
 */
interface Input {
  baseUrl?: string;
  maxCars?: number;
  useApifyProxy?: boolean;
}

// Regular expression matching car detail links. On the listing pages the
// vehicles appear as cards with hrefs like `/stoc/<slug>-ID1234`. When we
// enqueue links we tag them with the label "DETAIL" so the request handler
// knows how to parse them.
const DETAIL_HREF = /\/stoc\/.*-ID\d+/i;

// Keep track of stock IDs we've already processed. This prevents the crawler
// from pushing the same vehicle multiple times (for example via "similar
// models" links on detail pages). Once a stock ID is added to this set
// we skip any subsequent occurrences.
const seenStockIds = new Set<string>();

// Helper to wait for a given number of milliseconds. Used during auto
// scrolling so that content can load before we inspect the page.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scrolls the page down repeatedly to trigger lazy loading of all items. The
 * listing page uses infinite scrolling; without this we would only see a
 * subset of vehicles. We stop scrolling when the number of links stops
 * increasing or when the maximum number of rounds is reached.
 */
async function autoScroll(page: any, maxRounds = 30) {
  let last = 0;
  for (let i = 0; i < maxRounds; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(700);
    const count = await page.locator('a').count().catch(() => 0);
    if (count === last) break;
    last = count;
  }
}

/**
 * Keyword whitelist for features. Only strings that contain one of these terms
 * will be considered a feature. This focuses on equipment and comfort items
 * (CarPlay, Android Auto, sensors, safety systems, etc.) and avoids generic
 * numbers or unrelated words.
 */
// List of keywords that indicate a string describes a vehicle feature. We
// intentionally include a broad set of automotive terms such as comfort,
// safety and convenience items. Strings matching any of these keywords will
// be considered features if they also do not match the reject list below.
const FEATURE_KEYWORDS = new RegExp(
  [
    'Carplay',
    'Android',
    'Bluetooth',
    'Cruise',
    'ACC',
    'Adaptive',
    'Senzor',
    'Sensor',
    'Senzori',
    'Camera',
    'Park',
    'Parcare',
    'Video',
    '360',
    'Keyless',
    'LED',
    'Lumini',
    'Lane',
    'Asist',
    'Assist',
    'Airbag',
    'Isofix',
    'ABS',
    'ESP',
    'Jante',
    'Scaun',
    'Volan',
    'Climat',
    'Port',
    'USB',
    'Radio',
    'Naviga',
    'Sistem',
    'Start',
    'Stop',
    'Privacy',
    'Pre-colizi',
    'Collision',
    'Limitare',
    'Frane',
    'Frânare',
    'Asisten',
    'Emergency',
    'SOS',
    'Imobilizator',
    'Electric',
    'Power',
    'Coti(er|era)',
    'Tapițer',
    'Geamuri',
    'Audio',
    'ESP',
    'ABS'
  ].join('|'),
  'i',
);

/**
 * Terms that indicate a text is not a feature. We use this to filter out
 * navigation labels, legal terms, form labels, and generic specs that should
 * not be part of a features list. If any of these substrings are found in
 * the candidate string, it will be discarded.
 */
const FEATURE_REJECT = new RegExp(
  [
    'Despre',
    'Politic',
    'Cookies',
    'Termeni',
    'Contact',
    'Comand',
    'Finan',
    'Credit',
    'Leasing',
    'Buy',
    'KM',
    'CP',
    'km',
    'EUR',
    'RON',
    'TVA',
    'Diesel',
    'Benzina',
    'Automata',
    'Manuala',
    'VAT',
    'Culoare',
    'An fabrica',
    'Pret',
    'Preț',
    'Platform',
    'Servicii',
    'Juridic',
    'Company',
    'Ajută',
    'Sute',
    'Solicitare',
    'Nume',
    'Telefon',
    'Email',
    'E-mail',
    'Mesaj',
    'Cod',
    'VIN',
    'ID stoc',
    'Stoc',
    'Stock',
    'Return',
    'Aplica',
    'Trimite',
    'Preţ',
    'Politica',
    'Platformă',
    'Câmp',
    'Condiții',
    'Termen',
    'Confidenţialitate',
    '©',
    'Copyright',
    'Vânzare',
    'Inchidere',
    'Mesajul',
  ].join('|'),
  'i',
);

async function main() {
  await Actor.init();
  const input = (await Actor.getInput<Input>()) ?? {};
  const baseUrl = input.baseUrl ?? 'https://www.autoworldgrup.ro/stoc';
  const maxCars = input.maxCars ?? 2000;

  log.info(`Starting crawl at ${baseUrl}`);

  const crawler = new PlaywrightCrawler({
    headless: true,
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 120,
    // Use Apify proxy if requested. This helps avoid blocks but is optional.
    proxyConfiguration: input.useApifyProxy ? await Actor.createProxyConfiguration() : undefined,
    async requestHandler({ page, request, enqueueLinks }) {
      // If no label then we are on a listing page. Scroll it and enqueue all
      // detail pages. The paginator uses query string `?p=` so we allow the
      // crawler to follow those as well by not filtering them out.
      if (!request.label) {
        // On listing pages we must navigate to the requested URL rather than
        // always using baseUrl. Using baseUrl here would reset pagination and
        // cause the crawler to repeatedly load the first page. By using
        // request.url we allow queued `?p=` pages to load correctly.
        await page.goto(request.url, { waitUntil: 'domcontentloaded' });
        // Scroll the listing to trigger lazy loading of all cards on the
        // current page. Increase maxRounds to ensure all items are loaded.
        await autoScroll(page, 50);
        // Enqueue both pagination links (e.g. ?p=2) and detail pages. We
        // inspect every anchor on the page and decide whether to follow it.
        await enqueueLinks({
          // Consider all anchors; we'll filter in transformRequestFunction
          selector: 'a',
          transformRequestFunction: (req) => {
            const url = req.url;
            // Detail pages have a stock ID slug (e.g. -ID1234). Tag them so
            // the handler knows to parse details.
            if (DETAIL_HREF.test(url)) {
              req.label = 'DETAIL';
              return req;
            }
            // Follow pagination links like ?p=2, ?p=3, etc. Leave the label
            // undefined so they are treated as listing pages.
            if (url.includes('?p=')) {
              return req;
            }
            // Ignore all other links (navigation, filters, etc.)
            return null;
          },
        });
      } else if (request.label === 'DETAIL') {
        await page.goto(request.url, { waitUntil: 'domcontentloaded' });
        const html = await page.content();
        const $ = cheerio.load(html);
        const bodyText = $('body').text();
        const title = $('h1,h2,h3,h4,h5').first().text().trim();

        // Extract stock ID from page or URL. The site always includes `ID stoc`
        // near the top of the page. If we can’t find it, fall back to parsing
        // the numeric part after `-ID` in the URL.
        let stockId = bodyText.match(/ID\s*stoc\s*:?\s*(\d+)/i)?.[1] || '';
        if (!stockId) {
          stockId = request.url.match(/-ID(\d+)/i)?.[1] || '';
        }

        // Parse prices. The site formats numbers with periods as thousand
        // separators and uses EUR as currency.
        const priceTxt = bodyText.match(/(\d{1,3}(?:\.\d{3})*)\s*EUR/i)?.[1];
        const priceEur = priceTxt ? parseInt(priceTxt.replace(/\./g, ''), 10) : undefined;
        const compareTxt = bodyText.match(/Preț de listă\s*([0-9\.]+)\s*EUR/i)?.[1];
        const compareAtPriceEur = compareTxt ? parseInt(compareTxt.replace(/\./g, ''), 10) : undefined;

        const year = parseInt(bodyText.match(/\b(20\d{2})\b/)?.[1] || '') || undefined;
        const horsepower = parseInt(bodyText.match(/(\d+)\s*CP/i)?.[1] || '') || undefined;
        const dispMatch = bodyText.match(/(\d{1,2})\.(\d{3})\s*cm/i)?.[0] || '';
        const displacementCc = dispMatch ? parseInt(dispMatch.replace(/[^0-9]/g, ''), 10) : undefined;
        const kmMatch = bodyText.match(/(\d{1,3}(?:\.\d{3})*)\s*km/i)?.[1];
        const mileageKm = kmMatch ? parseInt(kmMatch.replace(/\./g, ''), 10) : undefined;

        // Fuel, transmission, drivetrain, body type and color are extracted via
        // matching common Romanian terms. These are approximate but work well
        // given the site structure.
        const fuel = (bodyText.match(/Benzina|Diesel|Electric|Hibrid Plug-In|Hibrid/i)?.[0] || '').trim();
        const transmission = (bodyText.match(/Automata|Manuala|CVT|dublu ambreiaj/i)?.[0] || '').trim();
        const drivetrain = (bodyText.match(/4x4|Fata|Spate/i)?.[0] || '').trim();
        const bodyType = (bodyText.match(/SUV|Sedan|Combi|Cabrio|Compacta|Coupe|Monovolum/i)?.[0] || '').trim();
        // Extract the colour. Capture only the portion after "Culoare" up
        // until the next field (typically "An fabricare"). We use a
        // lookahead to stop the match when the words "An fabricare" or a
        // newline are encountered. As a fallback we reuse the older pattern.
        let color = '';
        try {
          const match = bodyText.match(/Culoare\s*[:\s]*([A-Za-zĂÂÎȘȚăâîșț ,.]+?)(?=\s+An\s+fabricare|\n)/i);
          color = (match?.[1] || '').trim();
          if (!color) {
            const fallback = bodyText.match(/Culoare\s*\n?\s*([A-Za-zĂÂÎȘȚăâîșț\s]+)/i);
            color = (fallback?.[1] || '').trim();
          }
          // Remove any trailing "An fabricare" text if captured
          color = color.replace(/An\s*fabricare.*$/i, '').trim();
        } catch (err) {
          color = '';
        }

        // VAT status is indicated as "TVA deductibil" or "TVA nedeductibil".
        const vatType = /TVA\s+deductibil/i.test(html)
          ? 'deductibil'
          : /TVA\s+nedeductibil/i.test(html)
            ? 'nedeductibil'
            : 'necunoscut';

        // Extract VIN if present. VINs are 17-character alphanumeric strings. We
        // search for lines starting with VIN and capture the following token.
        let vin = bodyText.match(/\bVIN\s*\n?\s*([A-HJ-NPR-Z0-9]{17})/i)?.[1] || '';

        // Collect candidate features from list items, spans, links and paragraphs.
        const featuresSet = new Set<string>();
        const collect = (text: string) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          // Reject unwanted terms and accept only if matches keywords.
          if (FEATURE_REJECT.test(trimmed)) return;
          if (!FEATURE_KEYWORDS.test(trimmed)) return;
          featuresSet.add(trimmed);
        };
        $('li, span, a, p').each((_i, el) => {
          collect($(el).text());
        });

        // Additionally, parse the dotari section if present. This is a free-form
        // description after "Dotari" or "Dotări" followed by a colon. We split
        // the string on common separators like comma or newline.
        const dotariSection = bodyText.match(/Dot[aă]ri(?:.*?:)?\s*(.+)/i)?.[1];
        if (dotariSection) {
          dotariSection
            .split(/[•\-\u2022\n,]+/)
            .map((s) => s.trim())
            .forEach((item) => {
              if (!item) return;
              if (FEATURE_REJECT.test(item)) return;
              if (!FEATURE_KEYWORDS.test(item)) return;
              featuresSet.add(item);
            });
        }

        // Limit to 200 features and convert to array. We aim for a large
        // collection (often 15–20 items per car). Duplicate removal is
        // handled by using a set.
        const features = Array.from(featuresSet).slice(0, 200);

        // Extract "Descriere suplimentară" (additional description) if present.
        let extraDescription = '';
        try {
          const descrHeading = $('*:contains("Descriere supliment")').filter((_i, el) => {
            return /Descriere\s+supliment[aă]r[ăa]/i.test($(el).text());
          }).first();
          if (descrHeading && descrHeading.length) {
            // The description is typically the next sibling paragraph or div.
            const next = descrHeading.next();
            extraDescription = next.text().trim();
          }
        } catch (err) {
          // ignore parsing errors
        }

        // Extract images. We look for images hosted on workleto or under /uploads.
        const images: { src: string; alt?: string }[] = [];
        $('img').each((_i, img) => {
          const src = $(img).attr('src') || '';
          if (/usercontent\.cdn\.workleto\.com|\/uploads\//.test(src)) {
            const abs = src.startsWith('http') ? src : new URL(src, request.url).toString();
            images.push({ src: abs, alt: title });
          }
        });

        // Build the record and push it to the default dataset. We derive brand
        // and model from the title by splitting on spaces; this is crude but
        // works for most cases.
        const brand = title.split(' ')[0] || '';
        const model = title.split(' ').slice(1).join(' ') || '';
        const car = {
          stockId,
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
          color,
          displacementCc,
          priceEur,
          compareAtPriceEur,
          vatType,
          vin,
          features,
          extraDescription,
          images: images.slice(0, 24),
        };
        // Push the record only if we haven't already processed this stock ID.
        if (car.stockId) {
          if (seenStockIds.has(car.stockId)) {
            return;
          }
          seenStockIds.add(car.stockId);
        }
        await Dataset.pushData(car);
      }
    },
    maxRequestsPerCrawl: maxCars,
  });

  await crawler.run([{ url: baseUrl }]);
  log.info('Crawl finished');
  await Actor.exit();
}

// Execute the main function. If an unhandled rejection occurs, log the error
// and exit gracefully.
main().catch((err) => {
  log.error(err);
});