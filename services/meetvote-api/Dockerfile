FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV PORT=8090
ENV DATABASE_PATH=/data/meetvote.sqlite
EXPOSE 8090

CMD ["node", "src/server.js"]
