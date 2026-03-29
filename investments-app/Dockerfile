FROM node:20-alpine AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine AS app

WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/server.js ./
COPY --from=frontend-builder /build/backend/public ./public

EXPOSE 3001
CMD ["node", "server.js"]
