#!/bin/bash
set -e

echo "=================================================="
echo "🚀 Desplegando AutoQuiz Server desde GitHub"
echo "=================================================="

# Variables
REPO_URL="https://github.com/Eddym06/repo-server.git"
DEPLOY_DIR="/root/autoquiz-server-prod"
BRANCH="main"

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}📦 Paso 1: Clonando repositorio...${NC}"
if [ -d "$DEPLOY_DIR" ]; then
    echo "   Directorio existe, actualizando..."
    cd "$DEPLOY_DIR"
    git fetch origin
    git reset --hard origin/$BRANCH
    git pull origin $BRANCH
else
    echo "   Clonando repositorio..."
    git clone -b $BRANCH $REPO_URL $DEPLOY_DIR
    cd "$DEPLOY_DIR"
fi

echo -e "${GREEN}✅ Repositorio actualizado${NC}"

echo -e "${YELLOW}🐳 Paso 2: Deteniendo contenedor anterior...${NC}"
docker compose -f docker-compose.prod.yml down 2>/dev/null || true
docker rm -f autoquiz-server 2>/dev/null || true

echo -e "${YELLOW}🔨 Paso 3: Construyendo imagen Docker...${NC}"
docker compose -f docker-compose.prod.yml build --no-cache

echo -e "${YELLOW}🚀 Paso 4: Iniciando contenedor...${NC}"
docker compose -f docker-compose.prod.yml up -d

echo -e "${YELLOW}⏳ Esperando que el servidor inicie...${NC}"
sleep 5

echo -e "${YELLOW}📊 Paso 5: Verificando estado...${NC}"
docker ps | grep autoquiz-server

echo ""
echo -e "${GREEN}✅ Despliegue completado${NC}"
echo ""
echo "📊 Dashboard: http://185.144.156.88:3001/dashboard"
echo "🔌 API: http://185.144.156.88:3001"
echo ""
echo "📝 Ver logs: docker logs autoquiz-server -f"
echo "🔄 Reiniciar: docker compose -f $DEPLOY_DIR/docker-compose.prod.yml restart"
echo "🛑 Detener: docker compose -f $DEPLOY_DIR/docker-compose.prod.yml down"
echo ""
echo "=================================================="
