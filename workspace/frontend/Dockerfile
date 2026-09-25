FROM node:20-alpine

WORKDIR /app

ARG NEXT_PUBLIC_API_URL=https://workspace-endpoint.openagents.org
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

# Self-host: environment pills / thread-row keys (components/chat/env-pills.tsx).
# Both empty = feature off. OPS_PATH is a same-origin path proxied to an
# environment host's ops-server (/ops/status, /ops/release-thread/<name>);
# EXTERNAL_BASE is the browser-reachable origin environment pages open on.
ARG NEXT_PUBLIC_ELROND_OPS_PATH=
ARG NEXT_PUBLIC_ELROND_EXTERNAL_BASE=
ENV NEXT_PUBLIC_ELROND_OPS_PATH=${NEXT_PUBLIC_ELROND_OPS_PATH}
ENV NEXT_PUBLIC_ELROND_EXTERNAL_BASE=${NEXT_PUBLIC_ELROND_EXTERNAL_BASE}

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy application code
COPY . .

# Build
RUN npm run build

# Run
EXPOSE 3000
CMD ["npm", "start"]
