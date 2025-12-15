FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["npm","start"]