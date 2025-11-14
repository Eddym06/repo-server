// config.js - Versión para VPS (sin API keys hardcoded)
require('dotenv').config(); // Load environment variables from .env

module.exports = {
  // La API key ahora DEBE venir del cliente (extensión) o variable de entorno
  // NO exponer API keys en el servidor
  enableLogging: process.env.ENABLE_LOGGING === 'true' || true,
  port: process.env.PORT || 3000,
  host: process.env.HOST || '0.0.0.0',
  allowedOrigin: process.env.ALLOWED_ORIGIN
};