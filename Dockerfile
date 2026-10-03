# Dockerfile para deploy no Railway
FROM node:22-alpine

# SQLite nativo (node:sqlite) precisa disso
RUN apk add --no-cache sqlite-libs

# Cria pasta do banco (volume persistente do Railway)
RUN mkdir -p /data

WORKDIR /app

# Copia package.json e instala dependencias
COPY package*.json ./
RUN npm ci --omit=dev

# Copia código fonte
COPY src/ ./src/
COPY db/ ./db/
COPY publico/ ./publico/

# Variáveis de ambiente
ENV NODE_ENV=producao
ENV HOST=0.0.0.0
# PORT é injetado pelo Railway (NÃO defina aqui)

# Expõe porta
EXPOSE 3000

# Inicia o servidor
CMD ["node", "--env-file-if-exists=.env", "src/server.js"]