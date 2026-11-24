# Build context is the REPO ROOT (shared/ is copied in):
#   docker build -f services/order/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-order .
FROM node:20-alpine
WORKDIR /app/services/order

COPY services/order/package.json services/order/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY services/order ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production
USER node
EXPOSE 8081
CMD ["node", "server.js"]
