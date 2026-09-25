FROM node:24-slim

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
