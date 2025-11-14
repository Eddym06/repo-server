# Dockerfile para AutoQuiz Server
FROM node:20-slim

# Metadata
LABEL maintainer="eddym062806@gmail.com"
LABEL description="AutoQuiz Playwright Server para resolver cuestionarios Moodle con IA"
LABEL version="24.1"

# Variables de entorno por defecto
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    ENABLE_LOGGING=true

# Crear directorio de trabajo
WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar dependencias de producción
RUN npm ci --only=production && \
    npm cache clean --force

# Copiar código fuente
COPY server.js config.js answerShape.js utils.js database.js ./
COPY utils/ ./utils/
COPY database/ ./database/

# Copiar archivos públicos del dashboard
COPY public/ ./public/

# Exponer puerto
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/metrics', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Comando para iniciar servidor
CMD ["node", "server.js"]
