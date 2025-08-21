FROM node:20-slim
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build
CMD ["node", "dist/main.js"]