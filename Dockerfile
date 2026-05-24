FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install

# Source is bind-mounted in dev via docker-compose; this COPY is for prod builds.
COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
