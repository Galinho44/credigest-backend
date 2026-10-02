# Dockerfile para deploy no Railway
FROM node:22-alpine

WORKDIR /app

# Copia package.json e instala dependencias
COPY package*.json ./
RUN npm ci --omit=dev

# Copia codigo fonte
COPY src/ ./src/
COPY db/ ./db/
COPY publico/ ./publico/

# Variaveis de ambiente
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Expõe porta
EXPOSE 3000

# Comando de inicio: roda migrations e sobe servidor
CMD ["sh", "-c", "node --env-file-if-exists=.env src/banco/migrar.js && node --env-file-if-exists=.env src/server.js"]