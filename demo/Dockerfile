FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm run build && npm --prefix demo ci --no-audit --no-fund && npm --prefix demo run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY demo/server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY demo/server ./server
COPY --from=build /app/demo/dist ./dist
EXPOSE 3000
CMD ["node", "server/index.js"]
