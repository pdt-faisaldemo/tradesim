# Build context is the REPO ROOT (shared/ is copied in):
#   docker build -f services/portfolio/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-portfolio .
FROM node:20-alpine
WORKDIR /app/services/portfolio

COPY services/portfolio/package.json services/portfolio/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY services/portfolio ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production
USER node
EXPOSE 8084
CMD ["node", "server.js"]
