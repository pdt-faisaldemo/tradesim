# Build context is the REPO ROOT (shared/ is copied in):
#   docker build -f services/account/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-account .
FROM node:20-alpine
WORKDIR /app/services/account

COPY services/account/package.json services/account/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY services/account ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production
USER node
EXPOSE 8083
CMD ["node", "server.js"]
