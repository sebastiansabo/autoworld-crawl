# Autoworld Crawl

This actor crawls the [Autoworld](https://www.autoworldgrup.ro/stoc) catalogue and extracts
detailed information about each vehicle. It handles pagination automatically,
follows links to product detail pages, deduplicates by stock ID, and outputs
a rich set of fields including the VIN, technical specifications, colour,
VAT status, feature list and an extra description.

## Features

* **Pagination**: Dynamically follows `?p=` pages (including `type` query params)
  until a configurable maximum page number.
* **Deduplication**: Uses a `seenStockIds` set to avoid processing the same
  vehicle twice (for example when it appears in the “similar models” section).
* **Colour cleaning**: Removes the trailing `An fabricare` from colour names.
* **Feature filtering**: Captures equipment items via a whitelist and removes
  navigation or legal text via a reject list.
* **Extra description**: Extracts the paragraph following the “Descriere”
  heading.

## Running locally

```
npm install
npm run build
node dist/main.js
```

You can override the starting URL by providing an `input.json` file with
`baseUrl` and `startUrls` properties when running via the Apify platform.