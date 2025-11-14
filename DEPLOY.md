# 🚀 AutoQuiz Server - Guía de Despliegue en VPS

## 📋 Arquitectura del Sistema

```
┌──────────────────┐         HTTPS          ┌─────────────────┐
│  Extensión       │ ────────────────────▶   │   Traefik       │
│  Chrome          │                         │   (Proxy)       │
└──────────────────┘                         └─────────────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │ AutoQuiz Server │
                                             │   (Docker)      │
                                             │   Port 3000     │
                                             └─────────────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │  OpenAI/Gemini  │
                                             │  Grok/DeepSeek  │
                                             └─────────────────┘
```

## 🎯 Opción 1: Despliegue con EasyPanel (Recomendado)

### 1. Conectar al VPS
```bash
ssh root@66.55.75.9
```

### 2. Crear directorio del proyecto
```bash
mkdir -p /opt/autoquiz-server
cd /opt/autoquiz-server
```

### 3. Clonar o subir archivos
Sube estos archivos al servidor:
- `server.js`
- `config.js`
- `answerShape.js`
- `utils.js`
- `utils/` (directorio completo)
- `package.json`
- `Dockerfile`
- `docker-compose.yml`
- `.env.example`

```bash
# Opción A: Clonar desde GitHub (si tienes repo público)
git clone https://github.com/Eddym06/Autoquiz.git
cd Autoquiz/playwright-serverM

# Opción B: Subir manualmente con SCP desde Windows
# Desde PowerShell local:
scp -r C:\Users\eddym\Downloads\Autoquiz` Externo\playwright-serverM\* root@66.55.75.9:/opt/autoquiz-server/
```

### 4. Configurar variables de entorno
```bash
cd /opt/autoquiz-server
cp .env.example .env
nano .env
```

Editar `.env`:
```env
PORT=3000
HOST=0.0.0.0
ENABLE_LOGGING=true
ALLOWED_ORIGIN=https://autoquiz.qdf2w3.easypanel.host
```

### 5. Construir y desplegar con Docker Swarm
```bash
# Construir imagen
docker build -t autoquiz-server:latest .

# Desplegar servicio en red de EasyPanel
docker service create \
  --name autoquiz \
  --network easypanel \
  --replicas 1 \
  --constraint 'node.role == manager' \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.autoquiz-http.rule=Host(\`autoquiz.qdf2w3.easypanel.host\`)" \
  --label "traefik.http.routers.autoquiz-http.entrypoints=http" \
  --label "traefik.http.routers.autoquiz-http.middlewares=redirect-to-https" \
  --label "traefik.http.routers.autoquiz-https.rule=Host(\`autoquiz.qdf2w3.easypanel.host\`)" \
  --label "traefik.http.routers.autoquiz-https.entrypoints=https" \
  --label "traefik.http.routers.autoquiz-https.tls=true" \
  --label "traefik.http.routers.autoquiz-https.tls.certresolver=letsencrypt" \
  --label "traefik.http.services.autoquiz.loadbalancer.server.port=3000" \
  autoquiz-server:latest
```

### 6. Verificar despliegue
```bash
# Ver logs
docker service logs autoquiz -f

# Ver estado
docker service ps autoquiz

# Probar conexión
curl http://localhost:3000/metrics
curl https://autoquiz.qdf2w3.easypanel.host/metrics
```

---

## 🎯 Opción 2: Despliegue Manual con Docker Compose

### 1. Preparar archivos (igual que Opción 1, pasos 1-4)

### 2. Iniciar con Docker Compose
```bash
cd /opt/autoquiz-server

# Construir y levantar
docker-compose up -d

# Ver logs
docker-compose logs -f
```

### 3. Actualizar configuración de Traefik manualmente
```bash
# Agregar configuración al archivo de Traefik
nano /etc/easypanel/traefik/config/autoquiz.json
```

Contenido de `autoquiz.json`:
```json
{
  "http": {
    "routers": {
      "http-autoquiz": {
        "service": "autoquiz",
        "rule": "Host(`autoquiz.qdf2w3.easypanel.host`)",
        "entryPoints": ["http"],
        "middlewares": ["redirect-to-https"]
      },
      "https-autoquiz": {
        "service": "autoquiz",
        "rule": "Host(`autoquiz.qdf2w3.easypanel.host`)",
        "entryPoints": ["https"],
        "tls": {
          "certResolver": "letsencrypt",
          "domains": [{"main": "autoquiz.qdf2w3.easypanel.host"}]
        }
      }
    },
    "services": {
      "autoquiz": {
        "loadBalancer": {
          "servers": [{"url": "http://autoquiz-server:3000"}],
          "passHostHeader": true
        }
      }
    }
  }
}
```

### 4. Recargar Traefik
```bash
# Traefik detecta cambios automáticamente
# O forzar recarga:
docker service update --force traefik
```

---

## 🔧 Comandos Útiles

### Gestión del servicio
```bash
# Ver logs en tiempo real
docker service logs autoquiz -f

# Escalar réplicas
docker service scale autoquiz=2

# Actualizar servicio con nueva imagen
docker service update --image autoquiz-server:latest autoquiz

# Detener y eliminar servicio
docker service rm autoquiz
```

### Debugging
```bash
# Entrar al contenedor
docker exec -it $(docker ps -q -f name=autoquiz) sh

# Ver métricas del servidor
curl https://autoquiz.qdf2w3.easypanel.host/metrics

# Ver logs de Traefik
docker service logs traefik | grep autoquiz
```

### Actualizar código
```bash
cd /opt/autoquiz-server

# Opción A: Pull desde GitHub
git pull origin main

# Opción B: Subir archivos manualmente desde Windows
# (desde PowerShell local)
scp server.js root@66.55.75.9:/opt/autoquiz-server/

# Reconstruir y actualizar
docker build -t autoquiz-server:latest .
docker service update --image autoquiz-server:latest autoquiz
```

---

## 🌐 Configurar Extensión para usar VPS

### En la extensión Chrome:

1. Abrir **Opciones de AutoQuiz** (clic derecho en el ícono → Opciones)
2. En **"Configuración del Servidor"**, cambiar URL a:
   ```
   https://autoquiz.qdf2w3.easypanel.host
   ```
3. Presionar **"🔍 Probar Conexión"** para verificar
4. Si aparece **"✅ Servidor conectado correctamente"**, hacer clic en **"Guardar Configuración"**

---

## 🔒 Seguridad y Optimización

### Firewall (UFW)
```bash
# Permitir solo SSH, HTTP y HTTPS
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

### Limitar recursos del contenedor
Editar `docker-compose.yml`:
```yaml
deploy:
  resources:
    limits:
      cpus: '0.5'
      memory: 512M
    reservations:
      memory: 256M
```

### Monitoreo
```bash
# Ver uso de recursos
docker stats autoquiz

# Ver logs de errores
docker service logs autoquiz --since 1h | grep ERROR
```

---

## 📊 Endpoints Disponibles

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/start-quiz` | POST | Inicia un cuestionario nuevo |
| `/get-command` | GET | Obtiene siguiente comando |
| `/metrics` | GET | Métricas del servidor (tokens, rate limits) |

---

## 🆘 Troubleshooting

### Error: "Connection refused"
```bash
# Verificar que el contenedor esté corriendo
docker service ps autoquiz

# Verificar logs
docker service logs autoquiz | tail -50
```

### Error: "SSL certificate problem"
```bash
# Verificar certificado SSL
curl -v https://autoquiz.qdf2w3.easypanel.host/metrics

# Verificar configuración de Traefik
docker service inspect traefik | grep autoquiz
```

### Error: "CORS blocked"
```bash
# Verificar ALLOWED_ORIGIN en .env
cat /opt/autoquiz-server/.env

# Actualizar variable y reiniciar
docker service update --env-add ALLOWED_ORIGIN=https://tu-dominio.com autoquiz
```

---

## 📝 Checklist de Despliegue

- [ ] Subir archivos al VPS
- [ ] Configurar `.env`
- [ ] Construir imagen Docker
- [ ] Desplegar servicio en red `easypanel`
- [ ] Verificar logs del contenedor
- [ ] Probar endpoint `/metrics` localmente
- [ ] Probar endpoint público con HTTPS
- [ ] Configurar extensión con URL remota
- [ ] Probar conexión desde extensión
- [ ] Ejecutar quiz de prueba

---

## 🎉 ¡Listo!

Tu servidor AutoQuiz está desplegado en:
**https://autoquiz.qdf2w3.easypanel.host**

Certificado SSL: ✅ Automático con Let's Encrypt
