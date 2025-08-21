# Use the Apify Playwright image with Chrome/Chromium preinstalled.
# This ensures all Playwright browser dependencies are available out of the box and
# avoids runtime errors when the crawler attempts to launch a headless browser on
# the Apify platform. See the Apify documentation for details【850153556570037†L120-L134】.
FROM apify/actor-node-playwright-chrome:latest

# Run installation and build steps as root to avoid EACCES permission errors when
# creating node_modules. See Apify documentation for recommended patterns【850153556570037†L120-L134】.
USER root
WORKDIR /app

# Copy package files and tsconfig
COPY package*.json tsconfig.json ./

# Install all dependencies (including dev dependencies). We use `npm install` instead of `npm ci`
# because this project does not include a package-lock.json. The `--include=dev` flag ensures
# TypeScript and other dev dependencies are available during the build even when NODE_ENV is production.
RUN npm install --include=dev

# Copy source files and compile the TypeScript
COPY src ./src
RUN npm run build

# Use root for the runtime as well. Apify containers are sandboxed, so this is safe and avoids
# user mismatches when launching the crawler.
CMD ["node", "dist/main.js"]