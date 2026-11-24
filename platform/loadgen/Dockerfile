# Build context is the REPO ROOT (shared/ is copied in):
#   docker build -f platform/loadgen/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-loadgen .
FROM node:20-alpine
WORKDIR /app/platform/loadgen

COPY platform/loadgen/package.json platform/loadgen/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY platform/loadgen ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production
USER node
EXPOSE 8090
CMD ["node", "server.js"]
