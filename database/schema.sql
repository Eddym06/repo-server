-- ============================================
-- AutoQuiz Server - PostgreSQL Schema
-- ============================================

-- Tabla de usuarios
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(6) UNIQUE NOT NULL,      -- Identificador único de 6 dígitos
    token VARCHAR(64) UNIQUE NOT NULL,          -- Token único para autenticación
    username VARCHAR(100) NOT NULL,             -- Nombre del usuario
    enabled BOOLEAN DEFAULT true,               -- Estado del usuario (habilitado/inhabilitado)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para búsqueda rápida
CREATE INDEX idx_users_token ON users(token);
CREATE INDEX idx_users_identifier ON users(identifier);
CREATE INDEX idx_users_enabled ON users(enabled);

-- Tabla de métricas de usuarios
CREATE TABLE IF NOT EXISTS user_metrics (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    quizzes_completed INTEGER DEFAULT 0,        -- Cuestionarios finalizados
    total_tokens_used BIGINT DEFAULT 0,         -- Total de tokens consumidos
    total_questions_processed INTEGER DEFAULT 0, -- Total de preguntas procesadas
    total_errors INTEGER DEFAULT 0,             -- Total de errores encontrados
    last_quiz_at TIMESTAMP,                     -- Último cuestionario ejecutado
    UNIQUE(user_id)
);

-- Tabla de logs en tiempo real (solo se guardan los errores)
CREATE TABLE IF NOT EXISTS error_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(64),                     -- ID de sesión donde ocurrió el error
    error_type VARCHAR(50),                     -- Tipo de error (API, NETWORK, PROCESSING, etc.)
    error_message TEXT NOT NULL,                -- Mensaje de error
    error_stack TEXT,                           -- Stack trace del error
    context JSONB,                              -- Contexto adicional (modelo, pregunta, etc.)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_error_logs_user ON error_logs(user_id);
CREATE INDEX idx_error_logs_created ON error_logs(created_at DESC);
CREATE INDEX idx_error_logs_type ON error_logs(error_type);

-- Tabla de sesiones activas
CREATE TABLE IF NOT EXISTS active_sessions (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(64) UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    questions_total INTEGER,
    questions_processed INTEGER DEFAULT 0,
    tokens_estimated INTEGER DEFAULT 0,
    model_used VARCHAR(50),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed BOOLEAN DEFAULT false
);

CREATE INDEX idx_active_sessions_user ON active_sessions(user_id);
CREATE INDEX idx_active_sessions_completed ON active_sessions(completed);

-- Tabla de historial de cuestionarios (CON INFORME COMPLETO)
CREATE TABLE IF NOT EXISTS quiz_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(64),
    questions_total INTEGER,
    questions_correct INTEGER,
    questions_failed INTEGER,
    tokens_used INTEGER,
    model_used VARCHAR(50),
    duration_seconds INTEGER,
    report_data JSONB NOT NULL,                 -- NUEVO: Informe completo con preguntas y respuestas
    report_title VARCHAR(255),                  -- NUEVO: Título del cuestionario
    platform VARCHAR(100),                      -- NUEVO: Plataforma (Moodle, etc.)
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_quiz_history_user ON quiz_history(user_id);
CREATE INDEX idx_quiz_history_completed ON quiz_history(completed_at DESC);
CREATE INDEX idx_quiz_history_platform ON quiz_history(platform);

-- Tabla de estadísticas globales (para el dashboard)
CREATE TABLE IF NOT EXISTS global_stats (
    id INTEGER PRIMARY KEY DEFAULT 1,
    total_users INTEGER DEFAULT 0,
    total_quizzes_completed INTEGER DEFAULT 0,
    total_tokens_used BIGINT DEFAULT 0,
    total_questions_processed INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT single_row CHECK (id = 1)
);

-- Insertar fila única para stats globales
INSERT INTO global_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Tabla de administradores
CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

CREATE INDEX idx_admin_email ON admin_users(email);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger para users
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Función para actualizar estadísticas globales
CREATE OR REPLACE FUNCTION update_global_stats()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE global_stats SET
        total_users = (SELECT COUNT(*) FROM users),
        total_quizzes_completed = (SELECT SUM(quizzes_completed) FROM user_metrics),
        total_tokens_used = (SELECT SUM(total_tokens_used) FROM user_metrics),
        total_questions_processed = (SELECT SUM(total_questions_processed) FROM user_metrics),
        total_errors = (SELECT SUM(total_errors) FROM user_metrics),
        last_updated = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para actualizar stats globales automáticamente
CREATE TRIGGER update_global_stats_on_user_insert AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION update_global_stats();

CREATE TRIGGER update_global_stats_on_user_delete AFTER DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION update_global_stats();

CREATE TRIGGER update_global_stats_on_metrics_update AFTER UPDATE ON user_metrics
    FOR EACH ROW EXECUTE FUNCTION update_global_stats();

-- Vista para dashboard rápido
CREATE OR REPLACE VIEW dashboard_summary AS
SELECT 
    u.id,
    u.identifier,
    u.username,
    u.enabled,
    u.created_at,
    u.last_activity,
    COALESCE(m.quizzes_completed, 0) as quizzes_completed,
    COALESCE(m.total_tokens_used, 0) as total_tokens_used,
    COALESCE(m.total_questions_processed, 0) as total_questions_processed,
    COALESCE(m.total_errors, 0) as total_errors,
    (SELECT COUNT(*) FROM active_sessions WHERE user_id = u.id AND completed = false) as active_sessions_count
FROM users u
LEFT JOIN user_metrics m ON u.id = m.user_id
ORDER BY u.last_activity DESC;

-- ============================================
-- FUNCIONES DE UTILIDAD
-- ============================================

-- Generar identificador único de 6 dígitos
CREATE OR REPLACE FUNCTION generate_unique_identifier()
RETURNS VARCHAR(6) AS $$
DECLARE
    new_identifier VARCHAR(6);
    done BOOLEAN := false;
BEGIN
    WHILE NOT done LOOP
        -- Generar 6 dígitos aleatorios
        new_identifier := LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');
        
        -- Verificar que no exista
        IF NOT EXISTS (SELECT 1 FROM users WHERE identifier = new_identifier) THEN
            done := true;
        END IF;
    END LOOP;
    
    RETURN new_identifier;
END;
$$ LANGUAGE plpgsql;

-- Generar token único de 64 caracteres
CREATE OR REPLACE FUNCTION generate_unique_token()
RETURNS VARCHAR(64) AS $$
DECLARE
    new_token VARCHAR(64);
    done BOOLEAN := false;
BEGIN
    WHILE NOT done LOOP
        -- Generar token aleatorio (64 caracteres hex)
        new_token := encode(gen_random_bytes(32), 'hex');
        
        -- Verificar que no exista
        IF NOT EXISTS (SELECT 1 FROM users WHERE token = new_token) THEN
            done := true;
        END IF;
    END LOOP;
    
    RETURN new_token;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- DATOS DE PRUEBA (OPCIONAL - COMENTAR EN PRODUCCIÓN)
-- ============================================

-- Insertar usuario de prueba
-- INSERT INTO users (identifier, token, username, enabled)
-- VALUES (
--     generate_unique_identifier(),
--     generate_unique_token(),
--     'Usuario Prueba',
--     true
-- );
