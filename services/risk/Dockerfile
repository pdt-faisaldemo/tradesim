# Build context is the REPO ROOT (shared/ is copied in):
#   docker build -f services/risk/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-risk .
FROM node:20-alpine
WORKDIR /app/services/risk

COPY services/risk/package.json services/risk/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY services/risk ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production
USER node
EXPOSE 8082
CMD ["node", "server.js"]
