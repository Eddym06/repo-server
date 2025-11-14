# 🚀 Guía de Instalación - AutoQuiz Multi-Usuario

## 📋 Requisitos Previos

- Node.js 18+ instalado
- PostgreSQL 17 (ya configurado en VPS con n8n)
- Acceso al VPS (66.55.75.9)
- Docker (si despliegas con contenedores)

## 🗄️ Configuración de la Base de Datos

### 1. Conectar a PostgreSQL

```bash
# Desde el VPS o contenedor de n8n
docker exec -it n8n_postgres psql -U postgres -d n8n
```

### 2. Ejecutar el Schema

```bash
# Opción 1: Ejecutar directamente desde el archivo
psql -U postgres -d n8n -f database/schema.sql

# Opción 2: Copiar y pegar el contenido de database/schema.sql
```

El schema creará:
- ✅ 6 tablas (users, user_metrics, error_logs, active_sessions, quiz_history, global_stats)
- ✅ 2 funciones (generate_unique_identifier, generate_unique_token)
- ✅ 4 triggers (auto-update timestamps y estadísticas globales)
- ✅ 1 vista (dashboard_summary)

### 3. Verificar Instalación

```sql
-- Verificar que las tablas existen
\dt

-- Verificar que las funciones existen
\df generate_unique_*

-- Verificar estadísticas globales iniciales
SELECT * FROM global_stats;
```

## 📦 Instalación de Dependencias

```bash
cd playwright-serverM
npm install
```

Esto instalará:
- `pg` (PostgreSQL client)
- `ws` (WebSocket server)
- Todas las dependencias existentes

## ⚙️ Configuración del Servidor

### 1. Variables de Entorno

Crea un archivo `.env` (o configura en EasyPanel):

```env
# Base de Datos (ya configurado en VPS)
DB_HOST=n8n_postgres
DB_PORT=5432
DB_NAME=n8n
DB_USER=postgres
DB_PASSWORD=7f5253d09cb2157c4921

# Servidor
PORT=3000
HOST=0.0.0.0
ALLOWED_ORIGIN=https://autoquiz.qdf2w3.easypanel.host

# Admin (opcional)
ADMIN_KEY=tu-clave-secreta-admin
```

### 2. Probar Conexión

```bash
node -e "import('./database.js').then(db => db.testConnection())"
```

Deberías ver:
```
[DB] ✅ Conexión exitosa a PostgreSQL
```

## 🎨 Panel de Control

### Acceder al Dashboard

Una vez el servidor esté corriendo:

```
http://localhost:3000/dashboard
```

O en producción:
```
https://autoquiz.qdf2w3.easypanel.host/dashboard
```

### Crear Primer Usuario

1. Ir a **Dashboard** → **Usuarios**
2. Clic en **"+ Nuevo Usuario"**
3. Ingresar nombre (ej: "Juan Pérez")
4. **¡IMPORTANTE!** Copiar el token generado (solo se muestra una vez)
5. Compartir el token con el usuario de la extensión

## 🔐 Configurar Extensión

### En Chrome/Edge:

1. Ir a **Opciones de AutoQuiz**
2. En **Autenticación**:
   - Ingresar nombre de usuario
   - Pegar el token (64 caracteres)
3. En **Configuración del Servidor**:
   - URL del servidor: `https://autoquiz.qdf2w3.easypanel.host`
4. Clic en **"Probar Conexión"** para verificar
5. Guardar configuración

### Primera Validación

Al guardar, la extensión enviará el token al servidor. Si es válido:
- ✅ El campo de token desaparecerá
- ✅ Se mostrará: "Autenticado como: [username]" con ID

## 🐳 Despliegue en VPS

### Opción 1: Docker (Recomendado)

```bash
# 1. Subir archivos al VPS
scp -r playwright-serverM root@66.55.75.9:/opt/autoquiz-server

# 2. SSH al VPS
ssh root@66.55.75.9

# 3. Construir imagen
cd /opt/autoquiz-server
docker build -t autoquiz-server .

# 4. Crear red (si no existe)
docker network create easypanel

# 5. Desplegar con docker-compose
docker-compose up -d
```

### Opción 2: EasyPanel

1. Ir a EasyPanel → **New Service**
2. Seleccionar **Docker Service**
3. Configurar:
   - **Name**: `autoquiz-server`
   - **Image**: `autoquiz-server:latest` (construida localmente)
   - **Ports**: `3000:3000`
   - **Network**: Conectar a red de n8n
4. Variables de entorno (ver arriba)
5. Deploy

### Verificar Despliegue

```bash
# Verificar logs
docker logs -f autoquiz-server

# Probar endpoint
curl https://autoquiz.qdf2w3.easypanel.host/metrics
```

## 📊 Métricas y Monitoreo

El dashboard proporciona:

- **Estadísticas Globales**: Usuarios, cuestionarios, tokens, preguntas
- **Gestión de Usuarios**: Crear, habilitar/inhabilitar, eliminar
- **Logs de Errores**: Monitoreo de errores por usuario
- **Sesiones Activas**: Cuestionarios en progreso
- **WebSocket**: Logs en tiempo real

## 🔧 Troubleshooting

### Error de Conexión a PostgreSQL

```bash
# Verificar que el contenedor n8n_postgres está corriendo
docker ps | grep postgres

# Verificar red
docker network inspect easypanel
```

### Token No Válido en Extensión

1. Verificar que el usuario existe: Panel → Usuarios
2. Verificar que está habilitado (badge verde "Activo")
3. Generar nuevo token si es necesario (eliminar y crear usuario)

### Panel No Carga

1. Verificar que `public/` tiene: dashboard.html, dashboard.css, dashboard.js
2. Verificar logs del servidor: `docker logs autoquiz-server`
3. Verificar URL: `/dashboard` (con /d al final)

### WebSocket No Conecta

1. Verificar que el servidor HTTP usa variable `server` (no `app.listen()`)
2. Verificar que WebSocketServer recibe `{ server }` como parámetro
3. En producción: Verificar que Traefik soporta WebSocket upgrade

## 📝 Notas de Seguridad

- ✅ Tokens se guardan en `chrome.storage.local` (no sync)
- ✅ Tokens tienen 64 caracteres (256 bits)
- ✅ Usuarios pueden ser inhabilitados sin eliminar datos
- ✅ Base de datos usa CASCADE para limpiar datos huérfanos
- ⚠️ El panel NO tiene autenticación actualmente (agregar ADMIN_KEY en producción)

## 🎯 Próximos Pasos

1. ✅ Ejecutar schema SQL
2. ✅ Instalar dependencias Node
3. ✅ Configurar variables de entorno
4. ✅ Iniciar servidor
5. ✅ Crear primer usuario en dashboard
6. ✅ Configurar extensión con token
7. ✅ ¡Disfrutar AutoQuiz Multi-Usuario!

---

**🚀 ¡Tu servidor AutoQuiz Multi-Usuario está listo!**
