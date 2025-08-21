# Use the Apify Playwright image with Chrome/Chromium preinstalled.
# This ensures all Playwright browser dependencies are available out of the box and
# avoids runtime errors when the crawler attempts to launch a headless browser on
# the Apify platform. See the Apify documentation for details【850153556570037†L120-L134】.
FROM apify/actor-node-playwright-chrome:latest
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build
CMD ["node", "dist/main.js"]