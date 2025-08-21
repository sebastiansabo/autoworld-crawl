# Use the Apify Playwright image with Chrome/Chromium preinstalled.
# This ensures all Playwright browser dependencies are available out of the box and
# avoids runtime errors when the crawler attempts to launch a headless browser on
# the Apify platform. See the Apify documentation for details【850153556570037†L120-L134】.
FROM apify/actor-node-playwright-chrome:latest
WORKDIR /app
# Copy package files and tsconfig with ownership set to `myuser`. Without
# `--chown`, Docker copies files as root, which causes permission errors when
# installing dependencies under the non-root user used in Apify base images.
# See Apify Academy tutorial on avoiding EACCES errors【623042132476881†L84-L105】.
COPY --chown=myuser:myuser package*.json tsconfig.json ./

# Install dependencies including dev dependencies. We use `npm install` instead
# of `npm ci` because the repository does not ship with a package-lock.json.
# Installing with `--include=dev` ensures the TypeScript compiler is present even when
# NODE_ENV=production (Apify builds default to production mode).
RUN npm install --include=dev

# Copy source code with correct ownership
COPY --chown=myuser:myuser src ./src
RUN npm run build
CMD ["node", "dist/main.js"]