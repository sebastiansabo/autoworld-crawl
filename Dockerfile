# Use the Apify Playwright image with Chrome/Chromium preinstalled.
# This ensures all Playwright browser dependencies are available out of the box and
# avoids runtime errors when the crawler attempts to launch a headless browser on
# the Apify platform. See the Apify documentation for details【850153556570037†L120-L134】.
FROM apify/actor-node-playwright-chrome:latest
WORKDIR /app
COPY package*.json tsconfig.json ./
# Configure npm to install dependencies as root with unsafe permissions.
# Without this, npm tries to write to /app/node_modules as the default user and fails.
RUN npm config set user root \
    && npm config set unsafe-perm true \
    && npm ci
COPY src ./src
RUN npm run build
CMD ["node", "dist/main.js"]