# 🚀 AutoQuiz Server - Multi-User Edition

Servidor Node.js para resolver cuestionarios Moodle usando IA (OpenAI, Gemini, Grok, DeepSeek) con soporte para **hasta 15 usuarios concurrentes**.

## 📋 Características

- ✅ **Multi-usuario**: Hasta 15 extensiones conectadas simultáneamente
- ✅ **Gestión de sesiones**: Auto-limpieza y expiración automática
- ✅ **Rate limiting inteligente**: Control de tokens y 429 errors
- ✅ **Múltiples proveedores**: OpenAI, Google Gemini, Grok (x.ai), DeepSeek
- ✅ **Optimización de imágenes**: Compresión automática para reducir costos
- ✅ **Métricas en tiempo real**: `/metrics` endpoint
- ✅ **Admin panel**: Gestión de sesiones activas
- ✅ **Personalización**: Reglas customizadas y documentos de referencia
- ✅ **Docker ready**: Dockerfile y docker-compose incluidos

## 🏗️ Arquitectura

```
Extensión Chrome → HTTPS → Traefik → AutoQuiz Server → OpenAI/Gemini/Grok/DeepSeek
                                         ↓
                                    SessionManager
                                         ↓
                                   (15 usuarios max)
```

## 🚀 Instalación Local

### Prerrequisitos
- Node.js 18+ 
- npm o yarn

### 1. Instalar dependencias
```bash
cd playwright-serverM
npm install
```

### 2. Configurar variables de entorno
```bash
cp .env.example .env
nano .env
```

Variables importantes:
```env
PORT=3000
HOST=0.0.0.0
MAX_CONCURRENT_USERS=15
SESSION_TIMEOUT=3600000
ADMIN_KEY=tu-clave-secreta
```

### 3. Iniciar servidor
```bash
node server.js
```

Servidor corriendo en: `http://localhost:3000`

## 🐳 Despliegue con Docker

Ver [DEPLOY.md](./DEPLOY.md) para guía completa de despliegue en VPS.

### Quick start
```bash
docker build -t autoquiz-server:latest .
docker run -d -p 3000:3000 --name autoquiz autoquiz-server:latest
```

### Con Docker Compose
```bash
docker-compose up -d
```

## 📡 API Endpoints

### POST /start-quiz
Inicia un nuevo cuestionario.

**Request:**
```json
{
  "questions": [...],
  "screenshotData": "data:image/jpeg;base64,...",
  "config": {
    "apiKey": "sk-...",
    "model": "gpt-4o"
  },
  "personalization": {
    "active": true,
    "customRules": ["Regla 1", "Regla 2"],
    "documents": [...],
    "images": [...]
  }
}
```

**Response:**
```json
{
  "status": "success",
  "sessionId": "abc123...",
  "activeUsers": 3,
  "maxUsers": 15
}
```

### GET /get-command?sessionId=xxx
Obtiene el siguiente comando para ejecutar.

**Response:**
```json
{
  "status": "command",
  "command": {
    "number": 1,
    "type": "multichoice",
    "selectedAnswer": ["Opción A", "Opción B"]
  }
}
```

### GET /metrics
Métricas del servidor en tiempo real.

**Response:**
```json
{
  "timestamp": "2025-11-13T19:00:00.000Z",
  "server": {
    "version": "24.1-MultiUser",
    "uptime": 3600,
    "node_version": "v20.11.0"
  },
  "sessions": {
    "active": 3,
    "total": 5,
    "max_concurrent": 15,
    "timeout_minutes": 60
  },
  "tokens": {
    "used_last_minute": 12500,
    "remaining": 17500,
    "limit": 30000
  },
  "memory": {
    "rss": "256 MB",
    "heapUsed": "128 MB"
  }
}
```

### GET /admin/sessions
Lista todas las sesiones activas (requiere `X-Admin-Key` header).

### DELETE /admin/sessions/:sessionId
Elimina una sesión específica (requiere `X-Admin-Key` header).

## ⚙️ Configuración Multi-Usuario

### Límite de usuarios concurrentes
Por defecto: **15 usuarios simultáneos**

Modificar en `.env`:
```env
MAX_CONCURRENT_USERS=20
```

### Timeout de sesiones
Por defecto: **1 hora (3600000 ms)**

Modificar en `.env`:
```env
SESSION_TIMEOUT=7200000  # 2 horas
```

### Limpieza automática
El servidor limpia sesiones expiradas cada **5 minutos** automáticamente.

## 📊 Métricas por Usuario

Cada usuario tiene métricas individuales:
- `sessionsCreated`: Total de sesiones creadas
- `sessionsExpired`: Sesiones que expiraron
- `questionsProcessed`: Total de preguntas procesadas
- `firstSeen`: Primera vez que usó el servidor
- `lastSeen`: Última actividad

Acceder vía `/metrics` endpoint.

## 🔒 Seguridad

### Headers recomendados
La extensión puede enviar:
```javascript
headers: {
  'X-User-Id': 'usuario123',  // Identificador único (opcional)
  'X-Admin-Key': 'clave-admin' // Para endpoints admin
}
```

### CORS
El servidor acepta:
- Extensiones Chrome (`chrome-extension://`)
- localhost / 127.0.0.1
- Dominios easypanel.host
- Dominio custom definido en `ALLOWED_ORIGIN`

### Rate Limiting
- **429 errors**: Cooldown automático
- **Token budget**: Máximo 30k tokens/minuto
- **Degraded mode**: Lotes más pequeños en caso de sobrecarga

## 🧪 Testing

### Test de conexión
```bash
curl http://localhost:3000/metrics
```

### Test con múltiples usuarios
```bash
# Terminal 1
curl -X POST http://localhost:3000/start-quiz \
  -H "Content-Type: application/json" \
  -H "X-User-Id: user1" \
  -d '{"questions":[...],"config":{"apiKey":"..."}}'

# Terminal 2
curl -X POST http://localhost:3000/start-quiz \
  -H "Content-Type: application/json" \
  -H "X-User-Id: user2" \
  -d '{"questions":[...],"config":{"apiKey":"..."}}'
```

### Verificar límite de usuarios
Hacer 16 requests simultáneos → El 16º debería recibir error 429.

## 🐛 Troubleshooting

### Error: "Límite de usuarios concurrentes alcanzado"
**Solución:** Aumentar `MAX_CONCURRENT_USERS` en `.env` o esperar a que expiren sesiones antiguas.

### Sesiones no expiran
**Solución:** Verificar que `SESSION_TIMEOUT` esté configurado. Por defecto es 1 hora.

### Alto uso de memoria
**Solución:** Reducir `MAX_CONCURRENT_USERS` o disminuir `SESSION_TIMEOUT`.

### Errores 429 frecuentes
**Solución:** 
- Reducir `TOKEN_LIMIT_PER_MINUTE`
- Activar `RATE_LIMIT_DEGRADE=true`
- Usar modelos más eficientes (Gemini 2.5 Flash)

## 📈 Escalabilidad

### Para más de 15 usuarios:

1. **Aumentar recursos del servidor:**
   ```yaml
   # docker-compose.yml
   deploy:
     resources:
       limits:
         memory: 1G
         cpus: '1.0'
   ```

2. **Aumentar límite:**
   ```env
   MAX_CONCURRENT_USERS=30
   ```

3. **Considerar load balancer:**
   ```bash
   docker service scale autoquiz=3
   ```

### Monitoreo recomendado
- **Prometheus + Grafana**: Métricas avanzadas
- **PM2**: Gestión de procesos Node.js
- **New Relic**: APM profesional

## 📝 Logs

Los logs incluyen:
- `[SESSION-MANAGER]`: Gestión de sesiones
- `[START-QUIZ]`: Inicio de cuestionarios
- `[GET-COMMAND]`: Comandos enviados
- `[BATCH X]`: Procesamiento de lotes
- `[RATE-LIMIT]`: Control de rate limiting
- `[TOKENS]`: Gestión de presupuesto de tokens

Ver logs en tiempo real:
```bash
# Docker
docker service logs autoquiz -f

# Local
node server.js | tee -a server.log
```

## 🤝 Contribuir

1. Fork el repositorio
2. Crear branch: `git checkout -b feature/nueva-funcionalidad`
3. Commit: `git commit -am 'Añadir nueva funcionalidad'`
4. Push: `git push origin feature/nueva-funcionalidad`
5. Pull Request

## 📄 Licencia

Ver [LICENSE](../Licence)

## 👨‍💻 Autor

**Eddy M.**
- Email: eddym062806@gmail.com
- GitHub: [@Eddym06](https://github.com/Eddym06)

---

**Versión:** 24.1-MultiUser  
**Última actualización:** Noviembre 2025
