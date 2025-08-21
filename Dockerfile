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

# Install dependencies as the default non-root user (myuser). With the files
# owned by `myuser`, `npm ci` can create `node_modules` without EACCES errors.
RUN npm ci

# Copy source code with correct ownership
COPY --chown=myuser:myuser src ./src
RUN npm run build
CMD ["node", "dist/main.js"]