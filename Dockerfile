FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data DOWNLOAD_DIR=/downloads HONGGUO_TOKEN=1234567890abcdef1234567890abcdef

# Install ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

# Install production dependencies
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

# Copy server and built frontend
COPY server/ ./server/
COPY dist-react/ ./dist-react/
COPY src/ ./src/

RUN mkdir -p /data /downloads && chown -R node:node /app /data /downloads

USER node
EXPOSE 3000

CMD ["node", "server/index.cjs"]
