FROM node:24-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY server.ts tsconfig*.json ./
COPY lib ./lib
COPY shared ./shared
COPY public ./public
COPY scripts/build.js ./scripts/build.js
RUN npm run build

FROM node:24-bookworm-slim
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public/index.html /app/public/styles.css /app/public/ookoo-logo.png ./public/
COPY --chown=node:node .env.example ./
RUN mkdir -p data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3210 CHROMIUM_EXECUTABLE=/usr/bin/chromium PPT_FONT="Noto Sans CJK SC"
EXPOSE 3210
CMD ["node","dist/server.js"]
