FROM apify/actor-node-playwright-chrome:latest

# Install dependencies and build the TypeScript sources. The Playwright image
# already includes the necessary browser binaries, so we don't need to run
# `playwright install` separately. We install dev dependencies because
# TypeScript is a dev dependency and the compiler is needed at build time.
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install --include=dev

# Copy the source files and compile them to JavaScript.
COPY src ./src
RUN npm run build

# Run the compiled script. Apify will set ENTRYPOINT for us but we keep the
# command explicit for clarity.
CMD ["node", "dist/main.js"]