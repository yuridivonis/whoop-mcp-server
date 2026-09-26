FROM node:24-slim

# The MCP Registry checks this label to confirm the image belongs to the server it lists.
LABEL io.modelcontextprotocol.server.name="io.github.yuridivonis/whoop-mcp-server" \
      org.opencontainers.image.source="https://github.com/yuridivonis/whoop-mcp-server" \
      org.opencontainers.image.description="Your WHOOP recovery, sleep, strain and workouts in Claude, ChatGPT or any MCP app. Self-hosted." \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Create data directory for SQLite
RUN mkdir -p /data

ENV DB_PATH=/data/whoop.db
ENV MCP_MODE=http
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
