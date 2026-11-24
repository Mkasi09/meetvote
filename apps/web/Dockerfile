FROM node:24-alpine

WORKDIR /app
COPY apps/web/package.json ./
COPY apps/web/server.js apps/web/index.html apps/web/app.js apps/web/styles.css ./
COPY apps/web/logo-white.png ./logo-white.png
COPY apps/web/candidate-default.svg ./candidate-default.svg
COPY apps/elawini_estate_meetvote_logo.png ./logo.png

ENV PORT=3000
ENV API_URL=http://localhost:8090
EXPOSE 3000

CMD ["node", "server.js"]
