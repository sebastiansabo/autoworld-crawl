FROM apify/actor-node-playwright-chrome:latest

# Use the root user for installation to avoid EACCES errors when creating
# node_modules. The default user in the base image is `actor`, which lacks
# permissions to write to /app/node_modules. Running as root during the
# build phase solves this issue.
USER root

WORKDIR /app

# Copy package manifests and install dependencies, including devDeps so
# TypeScript is available at build time. Running under the root user
# prevents permission issues when creating the node_modules directory.
COPY package*.json tsconfig.json ./
RUN npm install --include=dev

# Copy source code and compile to JavaScript. We leave the runtime user as
# root because Apify runs the container in a sandboxed environment and
# changing users mid-build can reintroduce permission problems.
COPY src ./src
RUN npm run build

CMD ["node", "dist/main.js"]