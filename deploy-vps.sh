#!/bin/bash

# ============================================
# AutoQuiz Extension Server - Deploy Script
# ============================================

set -e  # Exit on error

echo "🚀 Iniciando deploy del AutoQuiz Extension Server..."

# Variables
VPS_HOST="root@185.144.156.88"
REMOTE_DIR="/root/autoquiz-extension-server"
SERVICE_NAME="autoquiz-extension-server"
IMAGE_NAME="autoquiz-extension-server:latest"
PORT_PUBLIC=3001
PORT_INTERNAL=3000

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}📦 Paso 1: Creando directorio en VPS...${NC}"
ssh $VPS_HOST "mkdir -p $REMOTE_DIR"

echo -e "${YELLOW}📤 Paso 2: Subiendo archivos al VPS...${NC}"
# Subir archivos necesarios
rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'test-results' \
    --exclude '*.bak' \
    --exclude '.env.example' \
    ./ $VPS_HOST:$REMOTE_DIR/

echo -e "${YELLOW}🔧 Paso 3: Creando archivo .env en VPS...${NC}"
ssh $VPS_HOST "cat > $REMOTE_DIR/.env << 'EOF'
PORT=3000
DB_USER=postgres
DB_PASSWORD=a2d27068d014beeadb8f
DB_HOST=autoquiz_postgres-autoquiz
DB_PORT=5432
DB_NAME=autoquiz
DB_SSL=false
JWT_SECRET=$(openssl rand -hex 64)
NODE_ENV=production
ENABLE_LOGGING=true
EOF"

echo -e "${YELLOW}🐳 Paso 4: Construyendo imagen Docker...${NC}"
ssh $VPS_HOST "cd $REMOTE_DIR && docker build -t $IMAGE_NAME ."

echo -e "${YELLOW}🗑️  Paso 5: Eliminando servicio anterior (si existe)...${NC}"
ssh $VPS_HOST "docker service rm $SERVICE_NAME 2>/dev/null || true"
sleep 5

echo -e "${YELLOW}🚀 Paso 6: Creando servicio Docker Swarm...${NC}"
ssh $VPS_HOST "docker service create \
    --name $SERVICE_NAME \
    --network easypanel-autoquiz \
    --network easypanel \
    --publish $PORT_PUBLIC:$PORT_INTERNAL \
    --env-file $REMOTE_DIR/.env \
    --replicas 1 \
    --restart-condition on-failure \
    --restart-max-attempts 3 \
    --update-parallelism 1 \
    --update-delay 10s \
    $IMAGE_NAME"

echo -e "${YELLOW}⏳ Paso 7: Esperando a que el servicio inicie...${NC}"
sleep 15

echo -e "${YELLOW}📊 Paso 8: Verificando estado del servicio...${NC}"
ssh $VPS_HOST "docker service ps $SERVICE_NAME"

echo -e "${YELLOW}📝 Paso 9: Mostrando logs del servicio...${NC}"
ssh $VPS_HOST "docker service logs --tail 50 $SERVICE_NAME"

echo ""
echo -e "${GREEN}✅ Deploy completado!${NC}"
echo ""
echo -e "${GREEN}📍 URLs de acceso:${NC}"
echo -e "   Dashboard: ${YELLOW}http://185.144.156.88:$PORT_PUBLIC/dashboard${NC}"
echo -e "   Login: ${YELLOW}http://185.144.156.88:$PORT_PUBLIC/login${NC}"
echo -e "   API: ${YELLOW}http://185.144.156.88:$PORT_PUBLIC${NC}"
echo ""
echo -e "${GREEN}🔍 Comandos útiles:${NC}"
echo -e "   Ver logs: ${YELLOW}ssh $VPS_HOST 'docker service logs -f $SERVICE_NAME'${NC}"
echo -e "   Ver estado: ${YELLOW}ssh $VPS_HOST 'docker service ps $SERVICE_NAME'${NC}"
echo -e "   Reiniciar: ${YELLOW}ssh $VPS_HOST 'docker service update --force $SERVICE_NAME'${NC}"
echo -e "   Eliminar: ${YELLOW}ssh $VPS_HOST 'docker service rm $SERVICE_NAME'${NC}"
echo ""
