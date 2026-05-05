FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Before npm ci so postinstall `playwright install` does not download a second Chromium
# alongside the binaries already baked into this image (mismatch → SIGTRAP / unstable launch).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 3000
CMD ["npm", "start"]
