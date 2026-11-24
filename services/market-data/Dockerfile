# Build context is the REPO ROOT (shared/ is copied in):
#   docker build -f services/market-data/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-market-data .
FROM node:20-alpine
WORKDIR /app/services/market-data

COPY services/market-data/package.json services/market-data/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY services/market-data ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production
USER node
EXPOSE 8085
CMD ["node", "server.js"]
