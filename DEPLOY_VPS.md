# Despliegue del AutoQuiz Extension Server en VPS con Easypanel

## 📋 Análisis de la Infraestructura Actual

### Contenedores Existentes
- **autoquiz_postgres-autoquiz**: PostgreSQL 17 en red `easypanel-autoquiz` (IP: 10.0.2.2)
- **autoquiz_postgres-autoquiz_pgweb**: PGWeb para administración de BD
- Red dedicada: `easypanel-autoquiz` (overlay swarm)

### Puertos Disponibles
- Puerto 80: HTTP (Traefik)
- Puerto 443: HTTPS (Traefik)
- Puerto 3000: Easypanel UI
- Puerto 22: SSH
- **Puertos libres recomendados**: 3001-3010, 5000-5010, 8000-8010

## ✅ Respuestas a tus Preguntas

### 1. ¿Podemos crear un contenedor que use la misma red?
**SÍ**, puedes crear un nuevo servicio en Easypanel que se conecte automáticamente a la red `easypanel-autoquiz` para comunicarse con PostgreSQL.

### 2. ¿Podemos exponer un puerto público?
**SÍ**, hay dos opciones:
- **Opción A (Recomendada)**: Usar Traefik para exponer via HTTP/HTTPS con dominio
- **Opción B**: Exponer puerto directo (ej: 3001) para acceso público

## 🚀 Plan de Despliegue

### Opción 1: Despliegue mediante Easypanel UI (Recomendado)

1. **Acceder a Easypanel**: http://185.144.156.88:3000
2. **Ir al proyecto "autoquiz"**
3. **Crear nuevo servicio**:
   - Tipo: App
   - Nombre: `autoquiz-extension-server`
   - Imagen: Dockerfile personalizado

4. **Configuración de red**:
   - Red: `easypanel-autoquiz` (automático por estar en el mismo proyecto)
   - Host PostgreSQL: `autoquiz_postgres-autoquiz` (nombre del servicio)

5. **Variables de entorno**:
   ```env
   PORT=3000
   DB_USER=postgres
   DB_PASSWORD=a2d27068d014beeadb8f
   DB_HOST=autoquiz_postgres-autoquiz
   DB_PORT=5432
   DB_NAME=autoquiz
   DB_SSL=false
   JWT_SECRET=tu_secret_super_seguro_cambiar_en_produccion
   NODE_ENV=production
   ```

6. **Configurar dominio o puerto**:
   - **Con dominio**: Agregar dominio en Easypanel y Traefik manejará HTTPS automáticamente
   - **Sin dominio**: Exponer puerto 3001 público

### Opción 2: Despliegue mediante Docker Compose

Subir el siguiente archivo al VPS y desplegarlo:

```yaml
# docker-compose-vps.yml
version: '3.8'

services:
  autoquiz-extension-server:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: autoquiz-extension-server
    restart: unless-stopped
    ports:
      - "3001:3000"  # Puerto público 3001 → puerto interno 3000
    networks:
      - easypanel-autoquiz
    environment:
      - PORT=3000
      - DB_USER=postgres
      - DB_PASSWORD=a2d27068d014beeadb8f
      - DB_HOST=autoquiz_postgres-autoquiz
      - DB_PORT=5432
      - DB_NAME=autoquiz
      - DB_SSL=false
      - JWT_SECRET=${JWT_SECRET:-change_this_in_production}
      - NODE_ENV=production
    depends_on:
      - postgres
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/dashboard"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

networks:
  easypanel-autoquiz:
    external: true

# No necesitamos definir postgres porque ya existe
```

### Opción 3: Despliegue Manual con Docker

```bash
# 1. Conectar al VPS
ssh root@185.144.156.88

# 2. Crear directorio para el proyecto
mkdir -p /root/autoquiz-extension-server
cd /root/autoquiz-extension-server

# 3. Clonar o subir archivos del servidor
# (puedes usar scp, git clone, o FTP)

# 4. Construir la imagen
docker build -t autoquiz-extension-server:latest .

# 5. Crear el servicio en Docker Swarm
docker service create \
  --name autoquiz-extension-server \
  --network easypanel-autoquiz \
  --publish 3001:3000 \
  --env PORT=3000 \
  --env DB_USER=postgres \
  --env DB_PASSWORD=a2d27068d014beeadb8f \
  --env DB_HOST=autoquiz_postgres-autoquiz \
  --env DB_PORT=5432 \
  --env DB_NAME=autoquiz \
  --env DB_SSL=false \
  --env JWT_SECRET=change_this_secret \
  --env NODE_ENV=production \
  --replicas 1 \
  autoquiz-extension-server:latest

# 6. Verificar que esté corriendo
docker service ls
docker service logs autoquiz-extension-server
```

## 📦 Dockerfile Optimizado para Producción

```dockerfile
# Dockerfile
FROM node:24-alpine

# Instalar dependencias del sistema
RUN apk add --no-cache \
    curl \
    ca-certificates

# Crear directorio de trabajo
WORKDIR /app

# Copiar package files
COPY package*.json ./

# Instalar dependencias de producción
RUN npm ci --only=production

# Copiar código fuente
COPY . .

# Crear usuario no-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Exponer puerto
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/dashboard', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Comando de inicio
CMD ["node", "server.js"]
```

## 🔧 Configuración de la Extensión

Una vez desplegado, las extensiones de los usuarios deberán configurarse con:

### Con puerto público directo
```
URL del servidor: http://185.144.156.88:3001
```

### Con dominio (si configuras uno)
```
URL del servidor: https://autoquiz-api.tudominio.com
```

## 🔒 Seguridad Recomendada

1. **Firewall**: Asegúrate de que el puerto 3001 esté abierto en el firewall del VPS
   ```bash
   # Ubuntu/Debian
   sudo ufw allow 3001/tcp
   sudo ufw reload
   ```

2. **HTTPS**: Si usas dominio, Traefik manejará certificados SSL automáticamente con Let's Encrypt

3. **JWT Secret**: Cambia el JWT_SECRET a un valor aleatorio fuerte:
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

4. **Rate Limiting**: El servidor ya tiene rate limiting configurado

5. **CORS**: Configurar origins permitidos en `server.js` si es necesario

## 📊 Monitoreo

### Ver logs en tiempo real
```bash
ssh root@185.144.156.88 "docker service logs -f autoquiz-extension-server"
```

### Verificar estado
```bash
ssh root@185.144.156.88 "docker service ps autoquiz-extension-server"
```

### Acceder al dashboard
```
http://185.144.156.88:3001/dashboard
```

## 🧪 Prueba de Conectividad

### Desde el VPS (red interna)
```bash
ssh root@185.144.156.88 "curl http://autoquiz_postgres-autoquiz:5432 || echo 'PostgreSQL accesible'"
```

### Desde internet (puerto público)
```bash
curl http://185.144.156.88:3001/dashboard
```

### Desde la extensión
1. Ir a opciones de la extensión
2. Configurar URL: `http://185.144.156.88:3001`
3. Hacer clic en "Probar Conexión"
4. Si es exitoso, guardar configuración

## 📝 Pasos Recomendados

### Opción Fácil (Easypanel UI):
1. ✅ Subir código al VPS o GitHub
2. ✅ Crear app en Easypanel proyecto "autoquiz"
3. ✅ Configurar Dockerfile build
4. ✅ Agregar variables de entorno
5. ✅ Exponer puerto 3001 o configurar dominio
6. ✅ Deploy automático

### Opción Manual (Docker):
1. ✅ Subir código al VPS: `/root/autoquiz-extension-server/`
2. ✅ Crear Dockerfile optimizado
3. ✅ Construir imagen
4. ✅ Crear servicio Docker Swarm conectado a `easypanel-autoquiz`
5. ✅ Exponer puerto 3001
6. ✅ Verificar logs y conectividad

## 🎯 Resultado Final

- ✅ Servidor de extensión corriendo en contenedor Docker
- ✅ Conectado a PostgreSQL existente via red `easypanel-autoquiz`
- ✅ Accesible públicamente via `http://185.144.156.88:3001`
- ✅ Dashboard en `http://185.144.156.88:3001/dashboard`
- ✅ API endpoints disponibles para extensiones de usuarios
- ✅ Logs centralizados via Docker
- ✅ Auto-restart si el contenedor falla
- ✅ Mismo cluster de base de datos, cero latencia

## 📞 Comandos Útiles

```bash
# Ver todos los servicios
ssh root@185.144.156.88 "docker service ls"

# Ver contenedores en red autoquiz
ssh root@185.144.156.88 "docker network inspect easypanel-autoquiz"

# Reiniciar servicio
ssh root@185.144.156.88 "docker service update --force autoquiz-extension-server"

# Escalar (múltiples réplicas)
ssh root@185.144.156.88 "docker service scale autoquiz-extension-server=2"

# Eliminar servicio
ssh root@185.144.156.88 "docker service rm autoquiz-extension-server"
```

## 🔄 Actualización del Servidor

```bash
# 1. Rebuildar imagen
docker build -t autoquiz-extension-server:latest .

# 2. Actualizar servicio (rolling update, zero downtime)
docker service update --image autoquiz-extension-server:latest autoquiz-extension-server
```

---

**¿Necesitas que prepare los archivos para desplegar ahora mismo?** Puedo crear:
1. `Dockerfile` optimizado
2. `docker-compose-vps.yml` listo para deploy
3. Script de deploy automatizado
4. Configuración de la extensión actualizada
