# One image for every process: api (default), worker, migrate, bootstrap and the CLI.
# Node 24 runs the TypeScript directly (type stripping), so there is no build step.
FROM node:24.22.2-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY bin ./bin
COPY db ./db
ENV NODE_ENV=production
RUN mkdir -p /data/media && chown node:node /data/media
USER node
EXPOSE 8787
CMD ["node", "src/api/main.ts"]
