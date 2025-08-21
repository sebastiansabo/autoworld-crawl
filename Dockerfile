FROM apify/actor-node-playwright-chrome:latest

# Switch to root for installation
USER root

WORKDIR /app

# Copy package manifests and tsconfig
COPY package*.json tsconfig.json ./

# Install dependencies as root
RUN npm ci

# Copy the source code and build
COPY src ./src
RUN npm run build

# Switch back to the default non-root user
USER actor

CMD ["node", "dist/main.js"]
