# Build context is the REPO ROOT (shared/, scripts/ and k8s/ are copied in):
#   docker build -f platform/chaos-api/Dockerfile --build-arg VERSION=v1.0.1 -t tradesim-chaos-api .
FROM node:20-alpine
RUN apk add --no-cache bash curl jq ca-certificates
# The scenario/fix/reset scripts run kubectl against tradesim with the pod's ServiceAccount (see k8s/platform/chaos-api.yaml).
ARG KUBECTL_VERSION=v1.31.4
ARG TARGETARCH=amd64
RUN curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl && kubectl version --client
WORKDIR /app/platform/chaos-api

COPY platform/chaos-api/package.json platform/chaos-api/package-lock.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY scripts /app/scripts
COPY k8s /app/k8s
COPY platform/chaos-api ./

ARG VERSION=dev
ENV VERSION=$VERSION NODE_ENV=production IN_CLUSTER=1 HOME=/tmp
USER node
EXPOSE 8090
CMD ["node", "server.js"]
