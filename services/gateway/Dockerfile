# Build context is the REPO ROOT (shared/ is copied in):
#   docker build -f services/gateway/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-gateway .
FROM node:20-alpine
WORKDIR /app/services/gateway

COPY services/gateway/package.json services/gateway/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY services/gateway ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.js"]
