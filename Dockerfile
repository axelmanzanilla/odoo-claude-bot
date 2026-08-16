# Build stage: compile TypeScript with dev dependencies present.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies, the compiled bot, and the Claude CLI.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# git lets Claude read repository history in the mounted Odoo workspace;
# ripgrep backs the Grep tool.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The bot writes only to /app/data. Mount the Odoo workspace read-only at
# /workspace/odoo and set ODOO_WORKSPACE to match.
RUN mkdir -p /app/data /home/node/.claude \
  && chown -R node:node /app/data /home/node/.claude
USER node
VOLUME ["/app/data"]

ENV DATABASE_PATH=/app/data/bot.sqlite3
ENV ODOO_WORKSPACE=/workspace/odoo

# Claude needs a writable HOME for its credentials and session transcripts.
ENV HOME=/home/node

CMD ["node", "dist/index.js"]
