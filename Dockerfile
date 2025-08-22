FROM apify/actor-node-playwright-chrome:latest

# Run as root to avoid permission errors when installing dependencies
USER root

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install --include=dev

COPY src ./src
RUN npm run build

CMD ["node", "dist/main.js"]