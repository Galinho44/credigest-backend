# Dockerfile para deploy no Railway
FROM node:22-alpine

# SQLite nativo (node:sqlite) precisa disso
RUN apk add --no-cache sqlite-libs

WORKDIR /app

# Copia package.json e instala dependencias
COPY package*.json ./
RUN npm ci --omit=dev

# Copia código fonte
COPY src/ ./src/
COPY db/ ./db/
COPY publico/ ./publico()

# Variáveis de ambiente
ENV NODE_ENV=producao
ENV HOST=0.0.0.0
# PORT é injetado pelo Railway (não defina aqui)

# Expõe porta (Railway usa a variável PORT)
EXPOSE 3000

# Inicia o servidor (migrations rodam dentro do server.js na primeira vez)
CMD ["node", "--env-file-if-exists=.env", "src/server.js"]