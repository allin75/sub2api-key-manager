FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1
CMD ["node", "src/server.js"]
