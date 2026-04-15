FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY server.js .

RUN addgroup -S app && adduser -S app -G app && \
    mkdir -p /data && chown app:app /data

USER app
ENV DATA_DIR=/data
EXPOSE 9223
VOLUME /data

CMD ["node", "server.js"]
