# Theme Studio capture job (Track 3.6): Node + Debian's Chromium + fonts.
# Built from the repository root:
#   docker build -f jobs/theme-studio-capture/Dockerfile jobs/theme-studio-capture
# See docs/theme-studio-capture-job.md for the Cloud Run job and schedule.
FROM node:24-slim

# Chromium and the fonts a storefront screenshot needs (Latin, Devanagari and
# the other Indian scripts via Noto, and colour emoji). The theme's own web
# fonts come from the storefront itself.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium fonts-noto-core fonts-noto-color-emoji ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /job
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY capture-job.mjs ./

USER node
CMD ["node", "capture-job.mjs"]
