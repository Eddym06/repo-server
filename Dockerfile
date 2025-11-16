# ============================================
# AutoQuiz Extension Server - Production Dockerfile
# ============================================

FROM node:24-alpine

# Metadata
LABEL maintainer="eddym062806@gmail.com"
LABEL description="AutoQuiz Extension Server - Multi-user API for Chrome Extensions"
LABEL version="1.0.0"

# Instalar dependencias del sistema
RUN apk add --no-cache \
    curl \
    ca-certificates \
    tzdata

# Variables de entorno por defecto
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    ENABLE_LOGGING=true \
    TZ=America/New_York

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

# Crear usuario no-root para seguridad
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Cambiar a usuario no-root
USER nodejs

# Exponer puerto
EXPOSE 3000

# Health check mejorado
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/dashboard', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Comando para iniciar servidor
CMD ["node", "server.js"]
