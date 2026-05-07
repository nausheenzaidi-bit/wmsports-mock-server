FROM node:20-slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY server.cjs ./
COPY import-to-microcks.sh ./
COPY artifacts/ ./artifacts/
COPY src/ ./src/

RUN chmod +x import-to-microcks.sh

EXPOSE 4010

CMD ["node", "server.cjs"]
