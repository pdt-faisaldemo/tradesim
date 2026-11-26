# Build context is the REPO ROOT (shared/ is copied in):
#   docker build -f platform/alert-bridge/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-alert-bridge .
FROM node:20-alpine
WORKDIR /app/platform/alert-bridge

COPY platform/alert-bridge/package.json platform/alert-bridge/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY platform/alert-bridge ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production
USER node
EXPOSE 8095
CMD ["node", "server.js"]
