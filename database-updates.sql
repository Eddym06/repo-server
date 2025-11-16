-- ====================================
-- ACTUALIZACIONES DE BASE DE DATOS
-- AutoQuiz Server - Nuevas Funcionalidades
-- ====================================

-- 1. Agregar columnas para tracking de modelos y actividad
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS last_model_used VARCHAR(100),
ADD COLUMN IF NOT EXISTS favorite_model VARCHAR(100),
ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS is_currently_active BOOLEAN DEFAULT FALSE;

-- 2. Crear tabla para historial de modelos usados por usuario
CREATE TABLE IF NOT EXISTS user_model_usage (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    model_name VARCHAR(100) NOT NULL,
    session_id VARCHAR(255),
    used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tokens_used INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_model_usage_user_id ON user_model_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_user_model_usage_model_name ON user_model_usage(model_name);

-- 3. Crear tabla para progreso en tiempo real de sesiones
CREATE TABLE IF NOT EXISTS session_progress (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255) UNIQUE NOT NULL,
    questions_completed INTEGER DEFAULT 0,
    questions_total INTEGER DEFAULT 0,
    current_question INTEGER DEFAULT 0,
    model_used VARCHAR(100),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_session_progress_user_id ON session_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_session_progress_session_id ON session_progress(session_id);
CREATE INDEX IF NOT EXISTS idx_session_progress_is_active ON session_progress(is_active);

-- 4. Crear tabla errors si no existe (reemplaza error_logs del schema antiguo)
CREATE TABLE IF NOT EXISTS errors (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    error_type VARCHAR(100),
    error_message TEXT NOT NULL,
    error_stack TEXT,
    context JSONB,
    username VARCHAR(100), -- Desnormalizado para queries rápidas
    identifier VARCHAR(6),  -- Desnormalizado para queries rápidas
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_errors_user_id ON errors(user_id);
CREATE INDEX IF NOT EXISTS idx_errors_created_at ON errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_error_type ON errors(error_type);

-- 4b. Agregar columnas para logs detallados de errores
ALTER TABLE errors
ADD COLUMN IF NOT EXISTS error_log TEXT,
ADD COLUMN IF NOT EXISTS warning_log TEXT;

-- 5. Crear tabla para estadísticas de modelos por marca
CREATE TABLE IF NOT EXISTS model_stats (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL, -- 'openai', 'gemini', 'grok', 'deepseek', 'claude'
    model_name VARCHAR(100) NOT NULL,
    total_requests INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, model_name)
);

CREATE INDEX IF NOT EXISTS idx_model_stats_provider ON model_stats(provider);

-- 6. Crear vista para obtener el modelo favorito de cada usuario
CREATE OR REPLACE VIEW user_favorite_models AS
SELECT 
    u.id as user_id,
    u.username,
    umu.model_name as favorite_model,
    COUNT(*) as usage_count,
    SUM(umu.tokens_used) as total_tokens
FROM users u
LEFT JOIN user_model_usage umu ON u.id = umu.user_id
GROUP BY u.id, u.username, umu.model_name
HAVING COUNT(*) = (
    SELECT MAX(cnt) FROM (
        SELECT COUNT(*) as cnt
        FROM user_model_usage
        WHERE user_id = u.id
        GROUP BY model_name
    ) subq
);

-- 7. Función para actualizar el modelo favorito automáticamente
CREATE OR REPLACE FUNCTION update_favorite_model()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users
    SET favorite_model = (
        SELECT model_name
        FROM user_model_usage
        WHERE user_id = NEW.user_id
        GROUP BY model_name
        ORDER BY COUNT(*) DESC, MAX(used_at) DESC
        LIMIT 1
    ),
    last_model_used = NEW.model_name
    WHERE id = NEW.user_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Crear trigger para actualizar modelo favorito
DROP TRIGGER IF EXISTS trigger_update_favorite_model ON user_model_usage;
CREATE TRIGGER trigger_update_favorite_model
    AFTER INSERT ON user_model_usage
    FOR EACH ROW
    EXECUTE FUNCTION update_favorite_model();

-- 8. Función para actualizar estadísticas de modelos
CREATE OR REPLACE FUNCTION update_model_stats()
RETURNS TRIGGER AS $$
DECLARE
    model_provider VARCHAR(50);
BEGIN
    -- Determinar el proveedor basado en el modelo
    model_provider := CASE
        WHEN NEW.model_name LIKE 'gpt%' OR NEW.model_name LIKE 'o1%' THEN 'openai'
        WHEN NEW.model_name LIKE 'gemini%' THEN 'gemini'
        WHEN NEW.model_name LIKE 'grok%' THEN 'grok'
        WHEN NEW.model_name LIKE 'deepseek%' THEN 'deepseek'
        WHEN NEW.model_name LIKE 'claude%' THEN 'claude'
        ELSE 'other'
    END;
    
    -- Actualizar o insertar estadísticas
    INSERT INTO model_stats (provider, model_name, total_requests, total_tokens, last_used)
    VALUES (model_provider, NEW.model_name, 1, COALESCE(NEW.tokens_used, 0), NEW.used_at)
    ON CONFLICT (provider, model_name)
    DO UPDATE SET
        total_requests = model_stats.total_requests + 1,
        total_tokens = model_stats.total_tokens + COALESCE(NEW.tokens_used, 0),
        last_used = NEW.used_at;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Crear trigger para actualizar estadísticas de modelos
DROP TRIGGER IF EXISTS trigger_update_model_stats ON user_model_usage;
CREATE TRIGGER trigger_update_model_stats
    AFTER INSERT ON user_model_usage
    FOR EACH ROW
    EXECUTE FUNCTION update_model_stats();

-- 9. Función para limpiar sesiones inactivas (más de 1 hora sin actualizar)
CREATE OR REPLACE FUNCTION cleanup_inactive_sessions()
RETURNS void AS $$
BEGIN
    UPDATE session_progress
    SET is_active = FALSE
    WHERE updated_at < NOW() - INTERVAL '1 hour'
    AND is_active = TRUE;
    
    UPDATE users
    SET is_currently_active = FALSE
    WHERE id IN (
        SELECT DISTINCT user_id
        FROM session_progress
        WHERE is_active = FALSE
        AND user_id NOT IN (
            SELECT user_id FROM session_progress WHERE is_active = TRUE
        )
    );
END;
$$ LANGUAGE plpgsql;

-- 10. Crear índices adicionales para optimización
CREATE INDEX IF NOT EXISTS idx_users_is_currently_active ON users(is_currently_active);
CREATE INDEX IF NOT EXISTS idx_users_last_active_at ON users(last_active_at);
CREATE INDEX IF NOT EXISTS idx_errors_created_at ON errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_model_usage_used_at ON user_model_usage(used_at DESC);

-- 11. Crear tabla para almacenar informes de cuestionarios completados
CREATE TABLE IF NOT EXISTS quiz_reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    report_title VARCHAR(500) DEFAULT 'Cuestionario',
    platform VARCHAR(100) DEFAULT 'Moodle',
    questions_total INTEGER DEFAULT 0,
    questions_correct INTEGER DEFAULT 0,
    questions_failed INTEGER DEFAULT 0,
    tokens_used INTEGER DEFAULT 0,
    model_used VARCHAR(100),
    duration_seconds INTEGER DEFAULT 0,
    report_data JSONB NOT NULL, -- Almacena el informe completo con todas las preguntas
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quiz_reports_user_id ON quiz_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_reports_session_id ON quiz_reports(session_id);
CREATE INDEX IF NOT EXISTS idx_quiz_reports_completed_at ON quiz_reports(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_reports_model_used ON quiz_reports(model_used);

-- 12. Función para actualizar estadísticas del usuario cuando se guarda un informe
CREATE OR REPLACE FUNCTION update_user_stats_on_report()
RETURNS TRIGGER AS $$
BEGIN
    -- Actualizar métricas del usuario
    UPDATE user_metrics
    SET 
        quizzes_completed = quizzes_completed + 1,
        total_questions = total_questions + NEW.questions_total,
        total_tokens_used = total_tokens_used + NEW.tokens_used
    WHERE user_id = NEW.user_id;
    
    -- Actualizar última actividad
    UPDATE users
    SET last_active_at = NEW.completed_at
    WHERE id = NEW.user_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Crear trigger para actualizar estadísticas al guardar informe
DROP TRIGGER IF EXISTS trigger_update_user_stats_on_report ON quiz_reports;
CREATE TRIGGER trigger_update_user_stats_on_report
    AFTER INSERT ON quiz_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_user_stats_on_report();

-- 13. Vista para estadísticas de informes por usuario
CREATE OR REPLACE VIEW user_report_stats AS
SELECT 
    u.id as user_id,
    u.username,
    COUNT(qr.id) as total_reports,
    SUM(qr.questions_total) as total_questions_answered,
    SUM(qr.questions_correct) as total_correct,
    SUM(qr.questions_failed) as total_failed,
    ROUND(AVG(qr.questions_correct::DECIMAL / NULLIF(qr.questions_total, 0) * 100), 2) as avg_accuracy,
    SUM(qr.tokens_used) as total_tokens_from_reports,
    MAX(qr.completed_at) as last_report_date
FROM users u
LEFT JOIN quiz_reports qr ON u.id = qr.user_id
GROUP BY u.id, u.username;

-- 14. Función para obtener informes recientes de todos los usuarios (para admin dashboard)
CREATE OR REPLACE FUNCTION get_recent_reports(limit_count INTEGER DEFAULT 10)
RETURNS TABLE (
    report_id INTEGER,
    user_id INTEGER,
    username VARCHAR,
    report_title VARCHAR,
    questions_total INTEGER,
    questions_correct INTEGER,
    accuracy DECIMAL,
    model_used VARCHAR,
    completed_at TIMESTAMP
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        qr.id as report_id,
        u.id as user_id,
        u.username,
        qr.report_title,
        qr.questions_total,
        qr.questions_correct,
        ROUND((qr.questions_correct::DECIMAL / NULLIF(qr.questions_total, 0) * 100), 2) as accuracy,
        qr.model_used,
        qr.completed_at
    FROM quiz_reports qr
    INNER JOIN users u ON qr.user_id = u.id
    ORDER BY qr.completed_at DESC
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- ====================================
-- COMENTARIOS Y NOTAS
-- ====================================
-- Este script agrega las siguientes funcionalidades:
-- 1. Tracking de modelos favoritos por usuario
-- 2. Progreso en tiempo real de sesiones activas
-- 3. Logs detallados de errores con WARNING
-- 4. Estadísticas globales de modelos por proveedor
-- 5. Estado de actividad de usuarios (activo/inactivo)
-- 6. Sistema de limpieza automática de sesiones obsoletas
-- 7. Sistema completo de informes de cuestionarios
-- 8. Estadísticas automáticas al completar quizzes
-- 9. Vistas y funciones para análisis de rendimiento
--
-- Para ejecutar: psql -U postgres -d autoquiz_db -f database-updates.sql
-- ====================================
