/**
 * @file database.js
 * @description Módulo de conexión y operaciones con PostgreSQL
 */

import pg from 'pg';
const { Pool } = pg;

// Validar credenciales críticas ANTES de crear el pool
const dbUser = process.env.DATABASE_USER || process.env.DB_USER;
const dbPassword = process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD;
const dbHost = process.env.DATABASE_HOST || process.env.DB_HOST || 'postgres';
const dbPort = parseInt(process.env.DATABASE_PORT || process.env.DB_PORT || '5432');
const dbName = process.env.DATABASE_NAME || process.env.DB_NAME || 'autoquiz';

if (!dbUser || !dbPassword) {
    console.error('[DB] ❌ ERROR CRÍTICO: Credenciales de base de datos no configuradas');
    console.error('[DB] Las variables DB_USER y DB_PASSWORD son OBLIGATORIAS');
    console.error('[DB] Configure estas variables en el archivo .env o en docker-compose.yml');
    console.error('[DB] El servidor NO puede iniciar sin credenciales válidas');
    process.exit(1); // Fallar ruidosamente para evitar estados inconsistentes
}

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
    user: dbUser,
    password: dbPassword,
    host: dbHost,
    port: dbPort,
    database: dbName,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 20, // Máximo de conexiones en el pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
});

console.log('[DB] 🔐 Configuración de conexión validada correctamente');
console.log(`[DB] 📍 Conectando a: ${dbHost}:${dbPort}/${dbName} como ${dbUser}`);

// Evento de conexión exitosa
pool.on('connect', () => {
    console.log('[DB] ✅ Conectado a PostgreSQL');
});

// Evento de error
pool.on('error', (err) => {
    console.error('[DB] ❌ Error inesperado en PostgreSQL:', err);
});

// ===== OPERACIONES DE USUARIOS =====

/**
 * Crear un nuevo usuario con token pre-generado (llamado desde extensión)
 */
export async function createUserWithToken(token, username) {
    const client = await pool.connect();
    try {
        // Generar solo el identificador (el token ya viene de la extensión)
        const identifierResult = await client.query('SELECT generate_unique_identifier() as identifier');
        const identifier = identifierResult.rows[0].identifier;

        // Insertar usuario
        const result = await client.query(
            `INSERT INTO users (identifier, token, username, enabled) 
             VALUES ($1, $2, $3, true) 
             RETURNING id, identifier, token, username, enabled, created_at`,
            [identifier, token, username]
        );

        console.log(`[DB] 👤 Usuario registrado desde extensión: ${username} (${identifier})`);
        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al crear usuario con token:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Crear un nuevo usuario (método legacy - mantener para compatibilidad)
 */
export async function createUser(username) {
    const client = await pool.connect();
    try {
        // Generar identificador y token únicos
        const identifierResult = await client.query('SELECT generate_unique_identifier() as identifier');
        const tokenResult = await client.query('SELECT generate_unique_token() as token');

        const identifier = identifierResult.rows[0].identifier;
        const token = tokenResult.rows[0].token;

        // Insertar usuario
        const result = await client.query(
            `INSERT INTO users (identifier, token, username, enabled) 
             VALUES ($1, $2, $3, true) 
             RETURNING id, identifier, token, username, enabled, created_at`,
            [identifier, token, username]
        );

        // Crear métricas iniciales
        await client.query(
            'INSERT INTO user_metrics (user_id) VALUES ($1)',
            [result.rows[0].id]
        );

        console.log(`[DB] 👤 Usuario creado: ${username} (${identifier})`);
        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al crear usuario:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Obtener usuario por token
 */
export async function getUserByToken(token) {
    try {
        const result = await pool.query(
            `SELECT u.*, 
                    COALESCE(m.quizzes_completed, 0) as quizzes_completed,
                    COALESCE(m.total_tokens_used, 0) as total_tokens_used
             FROM users u
             LEFT JOIN user_metrics m ON u.id = m.user_id
             WHERE u.auth_token = $1`,
            [token]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('[DB] Error al obtener usuario por token:', error);
        throw error;
    }
}

/**
 * Obtener usuario por identificador
 */
export async function getUserByIdentifier(identifier) {
    try {
        const result = await pool.query(
            `SELECT u.*, 
                    COALESCE(m.quizzes_completed, 0) as quizzes_completed,
                    COALESCE(m.total_tokens_used, 0) as total_tokens_used
             FROM users u
             LEFT JOIN user_metrics m ON u.id = m.user_id
             WHERE u.identifier = $1`,
            [identifier]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('[DB] Error al obtener usuario por identificador:', error);
        throw error;
    }
}

/**
 * Actualizar nombre de usuario
 */
export async function updateUsername(userId, newUsername) {
    try {
        const result = await pool.query(
            'UPDATE users SET username = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [newUsername, userId]
        );
        console.log(`[DB] 📝 Usuario ${userId} renombrado a: ${newUsername}`);
        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al actualizar nombre de usuario:', error);
        throw error;
    }
}

/**
 * Habilitar/Inhabilitar usuario
 */
export async function setUserEnabled(userId, isActive) {
    try {
        const result = await pool.query(
            'UPDATE users SET is_active = $1, last_active = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [isActive, userId]
        );
        console.log(`[DB] 🔄 Usuario ${userId} ${isActive ? 'habilitado' : 'inhabilitado'}`);
        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al cambiar estado de usuario:', error);
        throw error;
    }
}

/**
 * Eliminar usuario (y todas sus métricas/logs por CASCADE)
 */
export async function deleteUser(userId) {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        console.log(`[DB] 🗑️ Usuario ${userId} eliminado`);
        return true;
    } catch (error) {
        console.error('[DB] Error al eliminar usuario:', error);
        throw error;
    }
}

/**
 * Actualizar última actividad del usuario
 */
export async function updateUserActivity(userId) {
    try {
        await pool.query(
            'UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = $1',
            [userId]
        );
    } catch (error) {
        console.error('[DB] Error al actualizar actividad:', error);
    }
}

// ===== OPERACIONES DE MÉTRICAS =====

/**
 * Incrementar cuestionarios completados
 */
export async function incrementQuizzesCompleted(userId, tokensUsed, questionsProcessed) {
    try {
        await pool.query(
            `UPDATE user_metrics 
             SET quizzes_completed = quizzes_completed + 1,
                 total_tokens_used = total_tokens_used + $2,
                 total_questions = total_questions + $3,
                 last_quiz_at = CURRENT_TIMESTAMP
             WHERE user_id = $1`,
            [userId, tokensUsed, questionsProcessed]
        );
        console.log(`[DB] 📊 Métricas actualizadas para usuario ${userId}`);
    } catch (error) {
        console.error('[DB] Error al actualizar métricas:', error);
        throw error;
    }
}

/**
 * Incrementar contador de errores
 */
export async function incrementErrorCount(userId) {
    try {
        await pool.query(
            'UPDATE user_metrics SET total_errors = total_errors + 1 WHERE user_id = $1',
            [userId]
        );
    } catch (error) {
        console.error('[DB] Error al incrementar contador de errores:', error);
    }
}

/**
 * Obtener métricas de un usuario
 */
export async function getUserMetrics(userId) {
    try {
        const result = await pool.query(
            'SELECT * FROM user_metrics WHERE user_id = $1',
            [userId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('[DB] Error al obtener métricas:', error);
        throw error;
    }
}

// ===== OPERACIONES DE LOGS DE ERRORES =====

/**
 * Guardar error en la base de datos
 */
export async function saveErrorLog(userId, sessionId, errorType, errorMessage, errorStack, context) {
    try {
        const result = await pool.query(
            `INSERT INTO error_logs (user_id, session_id, error_type, error_message, error_stack, context)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [userId, sessionId, errorType, errorMessage, errorStack, JSON.stringify(context)]
        );

        // Incrementar contador de errores
        await incrementErrorCount(userId);

        console.log(`[DB] ⚠️ Error guardado para usuario ${userId}: ${errorType}`);
        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al guardar log de error:', error);
        throw error;
    }
}

/**
 * Obtener logs de errores de un usuario
 */
export async function getUserErrorLogs(userId, limit = 50) {
    try {
        const result = await pool.query(
            `SELECT * FROM error_logs 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2`,
            [userId, limit]
        );
        return result.rows;
    } catch (error) {
        console.error('[DB] Error al obtener logs de errores:', error);
        throw error;
    }
}

/**
 * Obtener todos los errores recientes (para dashboard)
 */
export async function getRecentErrors(limit = 100) {
    try {
        const result = await pool.query(
            `SELECT e.*, u.username, u.identifier 
             FROM error_logs e
             JOIN users u ON e.user_id = u.id
             ORDER BY e.created_at DESC 
             LIMIT $1`,
            [limit]
        );
        return result.rows;
    } catch (error) {
        console.error('[DB] Error al obtener errores recientes:', error);
        throw error;
    }
}

// ===== OPERACIONES DE SESIONES =====

/**
 * Crear sesión activa
 */
export async function createActiveSession(sessionId, userId, questionsTotal, tokensEstimated, modelUsed) {
    try {
        const result = await pool.query(
            `INSERT INTO active_sessions (session_id, user_id, questions_total, tokens_estimated, model_used)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [sessionId, userId, questionsTotal, tokensEstimated, modelUsed]
        );
        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al crear sesión activa:', error);
        throw error;
    }
}

/**
 * Actualizar progreso de sesión
 */
export async function updateSessionProgress(sessionId, questionsProcessed) {
    try {
        await pool.query(
            `UPDATE active_sessions 
             SET questions_processed = $2, last_activity = CURRENT_TIMESTAMP
             WHERE session_id = $1`,
            [sessionId, questionsProcessed]
        );
    } catch (error) {
        console.error('[DB] Error al actualizar progreso de sesión:', error);
    }
}

/**
 * Completar sesión
 */
export async function completeSession(sessionId, questionsCorrect, questionsFailed, tokensUsed, durationSeconds) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Obtener datos de la sesión
        const sessionResult = await client.query(
            'SELECT * FROM active_sessions WHERE session_id = $1',
            [sessionId]
        );

        if (sessionResult.rows.length > 0) {
            const session = sessionResult.rows[0];

            // Marcar como completada
            await client.query(
                'UPDATE active_sessions SET completed = true WHERE session_id = $1',
                [sessionId]
            );

            // Guardar en historial
            await client.query(
                `INSERT INTO quiz_history 
                 (user_id, session_id, questions_total, questions_correct, questions_failed, tokens_used, model_used, duration_seconds)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [session.user_id, sessionId, session.questions_total, questionsCorrect, questionsFailed, tokensUsed, session.model_used, durationSeconds]
            );
        }

        await client.query('COMMIT');
        console.log(`[DB] ✅ Sesión ${sessionId} completada`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[DB] Error al completar sesión:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Guardar tokens usados en el quiz (inmediatamente al iniciar)
 */
export async function saveQuizTokens(userId, sessionId, tokensUsed, modelUsed, questionsTotal) {
    try {
        // Actualizar la sesión activa con los tokens reales
        await pool.query(
            `UPDATE active_sessions 
             SET tokens_estimated = $3, model_used = $4
             WHERE session_id = $1 AND user_id = $2`,
            [sessionId, userId, tokensUsed, modelUsed]
        );

        // Actualizar métricas del usuario
        await pool.query(
            `INSERT INTO user_metrics (user_id, total_tokens_used, quizzes_completed)
             VALUES ($1, $2, 0)
             ON CONFLICT (user_id) 
             DO UPDATE SET total_tokens_used = user_metrics.total_tokens_used + $2`,
            [userId, tokensUsed]
        );

        console.log(`[DB] 🎯 Tokens guardados: ${tokensUsed} para usuario ${userId}`);
    } catch (error) {
        console.error('[DB] Error al guardar tokens:', error);
        throw error;
    }
}

/**
 * Obtener sesiones activas de un usuario
 */
export async function getUserActiveSessions(userId) {
    try {
        const result = await pool.query(
            'SELECT * FROM active_sessions WHERE user_id = $1 AND completed = false',
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error('[DB] Error al obtener sesiones activas:', error);
        throw error;
    }
}

// ===== OPERACIONES DE ESTADÍSTICAS GLOBALES =====

/**
 * Obtener estadísticas globales
 */
export async function getGlobalStats() {
    try {
        const result = await pool.query('SELECT * FROM global_stats WHERE id = 1');
        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al obtener estadísticas globales:', error);
        throw error;
    }
}

/**
 * Obtener todos los usuarios (sin tokens)
 */
export async function getAllUsers() {
    try {
        const result = await pool.query(
            `SELECT u.id, u.user_id, u.username, u.email, u.is_active, u.created_at,
                    COALESCE(u.total_quizzes, 0) as quizzes_completed,
                    COALESCE(u.total_questions, 0) as total_questions_processed,
                    COALESCE(u.total_tokens_used, 0) as total_tokens_used,
                    0 as total_errors
             FROM users u
             ORDER BY u.created_at DESC`
        );
        return result.rows;
    } catch (error) {
        console.error('[DB] Error en getAllUsers:', error);
        throw error;
    }
}

/**
 * Obtener usuario por ID
 */
export async function getUserById(userId) {
    try {
        const result = await pool.query(
            `SELECT u.*, 
                    COALESCE(u.total_quizzes, 0) as quizzes_completed,
                    COALESCE(u.total_questions, 0) as total_questions_processed,
                    COALESCE(u.total_tokens_used, 0) as total_tokens_used,
                    0 as total_errors
             FROM users u
             WHERE u.id = $1`,
            [userId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('[DB] Error en getUserById:', error);
        throw error;
    }
}

/**
 * Obtener todos los errores
 */
export async function getAllErrorLogs(limit = 100) {
    try {
        const result = await pool.query(
            `SELECT e.*, u.username, u.identifier, u.email
             FROM error_logs e
             LEFT JOIN users u ON e.user_id = u.id
             ORDER BY e.created_at DESC
             LIMIT $1`,
            [limit]
        );
        return result.rows;
    } catch (error) {
        console.error('[DB] Error en getAllErrorLogs:', error);
        throw error;
    }
}

/**
 * Obtener sesiones activas
 */
export async function getActiveSessions() {
    try {
        const result = await pool.query(
            `SELECT s.*, u.username, u.identifier
             FROM active_sessions s
             LEFT JOIN users u ON s.user_id = u.id
             WHERE s.completed = false
             ORDER BY s.started_at DESC`
        );
        return result.rows;
    } catch (error) {
        console.error('[DB] Error en getActiveSessions:', error);
        throw error;
    }
}

// ===== INICIALIZACIÓN =====

/**
 * Verificar conexión a la base de datos
 */
export async function testConnection() {
    try {
        const result = await pool.query('SELECT NOW()');
        console.log('[DB] ✅ Conexión exitosa a PostgreSQL');
        return true;
    } catch (error) {
        console.error('[DB] ❌ Error de conexión a PostgreSQL:', error);
        return false;
    }
}

/**
 * Cerrar pool de conexiones
 */
export async function closePool() {
    await pool.end();
    console.log('[DB] 🔌 Pool de conexiones cerrado');
}

// ===== OPERACIONES DE ADMIN =====

/**
 * Crear o actualizar admin (primera vez)
 */
export async function createOrUpdateAdmin(email, passwordHash) {
    try {
        const result = await pool.query(
            `INSERT INTO admin_users (email, password_hash) 
             VALUES ($1, $2)
             ON CONFLICT (email) 
             DO UPDATE SET password_hash = $2, last_login = CURRENT_TIMESTAMP
             RETURNING id, email, created_at`,
            [email, passwordHash]
        );
        console.log(`[DB] 👤 Admin configurado: ${email}`);
        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al crear/actualizar admin:', error);
        throw error;
    }
}

/**
 * Obtener admin por email
 */
export async function getAdminByEmail(email) {
    try {
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE email = $1',
            [email]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('[DB] Error al obtener admin:', error);
        throw error;
    }
}

/**
 * Verificar si existe algún admin
 */
export async function hasAdmin() {
    try {
        const result = await pool.query('SELECT COUNT(*) FROM admin_users');
        return parseInt(result.rows[0].count) > 0;
    } catch (error) {
        console.error('[DB] Error al verificar admin:', error);
        return false;
    }
}

/**
 * Actualizar último login
 */
export async function updateAdminLastLogin(email) {
    try {
        await pool.query(
            'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE email = $1',
            [email]
        );
    } catch (error) {
        console.error('[DB] Error al actualizar last_login:', error);
    }
}

// ===== OPERACIONES DE INFORMES =====

/**
 * Guardar informe completo de cuestionario
 * Obtener informes de un usuario
 */
export async function getUserReports(userId, limit = 50) {
    try {
        const result = await pool.query(
            `SELECT id, report_title, platform, questions_total, questions_correct, 
                    questions_failed, tokens_used, model_used, duration_seconds, 
                    completed_at, session_id
             FROM quiz_reports
             WHERE user_id = $1
             ORDER BY completed_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        return result.rows;
    } catch (error) {
        console.error('[DB] Error al obtener informes:', error);
        throw error;
    }
}

/**
 * Obtener informe completo por ID
 */
export async function getReportById(reportId, userId) {
    try {
        const result = await pool.query(
            `SELECT * FROM quiz_reports WHERE id = $1 AND user_id = $2`,
            [reportId, userId]
        );

        return result.rows[0] || null;
    } catch (error) {
        console.error('[DB] Error al obtener informe:', error);
        throw error;
    }
}

/**
 * Contar informes de un usuario
 */
export async function countUserReports(userId) {
    try {
        const result = await pool.query(
            'SELECT COUNT(*) FROM quiz_reports WHERE user_id = $1',
            [userId]
        );

        return parseInt(result.rows[0].count);
    } catch (error) {
        console.error('[DB] Error al contar informes:', error);
        return 0;
    }
}

/**
 * Eliminar informe
 */
export async function deleteReport(reportId, userId) {
    try {
        await pool.query(
            'DELETE FROM quiz_reports WHERE id = $1 AND user_id = $2',
            [reportId, userId]
        );

        console.log(`[DB] 🗑️ Informe ${reportId} eliminado`);
        return true;
    } catch (error) {
        console.error('[DB] Error al eliminar informe:', error);
        throw error;
    }
}

/**
 * Obtener todos los informes (para admin)
 */
export async function getAllReports(limit = 50) {
    try {
        const result = await pool.query(
            `SELECT r.id, r.report_title, r.platform, r.questions_total, r.questions_correct, 
                    r.questions_failed, r.tokens_used, r.model_used, r.duration_seconds, 
                    r.completed_at, r.session_id, r.user_id, u.username, u.identifier
             FROM quiz_reports r
             JOIN users u ON r.user_id = u.id
             ORDER BY r.completed_at DESC
             LIMIT $1`,
            [limit]
        );

        return result.rows;
    } catch (error) {
        console.error('[DB] Error al obtener todos los informes:', error);
        throw error;
    }
}

/**
 * Obtener informe por ID (admin - sin restricción de usuario)
 */
export async function getReportByIdAdmin(reportId) {
    try {
        const result = await pool.query(
            `SELECT r.*, u.username, u.identifier
             FROM quiz_reports r
             JOIN users u ON r.user_id = u.id
             WHERE r.id = $1`,
            [reportId]
        );

        return result.rows[0] || null;
    } catch (error) {
        console.error('[DB] Error al obtener informe (admin):', error);
        throw error;
    }
}

/**
 * Eliminar informe (admin)
 */
export async function deleteReportAdmin(reportId) {
    try {
        await pool.query(
            'DELETE FROM quiz_reports WHERE id = $1',
            [reportId]
        );
        console.log(`[DB] 🗑️ Informe ${reportId} eliminado (admin)`);
        return true;
    } catch (error) {
        console.error('[DB] Error al eliminar informe (admin):', error);
        throw error;
    }
}

// ===== OPERACIONES DE LOGS DE EXTENSIÓN =====

/**
 * Guardar log de la extensión
 */
export async function saveExtensionLog(userId, level, message, data, url, timestamp) {
    try {
        const result = await pool.query(
            `INSERT INTO extension_logs (user_id, level, message, data, url, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, created_at`,
            [userId, level, message, data || {}, url, timestamp]
        );

        return result.rows[0];
    } catch (error) {
        console.error('[DB] Error al guardar log de extensión:', error);
        throw error;
    }
}

/**
 * Obtener logs recientes de un usuario (últimos 2 minutos)
 */
export async function getUserLogs(userId, limit = 100) {
    try {
        const result = await pool.query(
            `SELECT id, level, message, data, url, timestamp, created_at
             FROM extension_logs
             WHERE user_id = $1
               AND created_at > NOW() - INTERVAL '2 minutes'
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        return result.rows;
    } catch (error) {
        console.error('[DB] Error al obtener logs de usuario:', error);
        throw error;
    }
}

/**
 * Obtener logs recientes de todos los usuarios (para admin)
 */
export async function getAllRecentLogs(limit = 200) {
    try {
        const result = await pool.query(
            `SELECT l.id, l.user_id, l.level, l.message, l.data, l.url, l.timestamp, l.created_at,
                    u.username, u.identifier
             FROM extension_logs l
             JOIN users u ON l.user_id = u.id
             WHERE l.created_at > NOW() - INTERVAL '2 minutes'
             ORDER BY l.created_at DESC
             LIMIT $1`,
            [limit]
        );

        return result.rows;
    } catch (error) {
        console.error('[DB] Error al obtener todos los logs:', error);
        throw error;
    }
}

/**
 * Limpiar logs antiguos (más de 2 minutos)
 */
export async function cleanOldLogs() {
    try {
        const result = await pool.query(
            `DELETE FROM extension_logs 
             WHERE created_at < NOW() - INTERVAL '2 minutes'`
        );

        return result.rowCount;
    } catch (error) {
        console.error('[DB] Error al limpiar logs antiguos:', error);
        throw error;
    }
}

/**
 * Obtener actividad de quizzes por día (últimos 7 días)
 */
export async function getActivityByDay(days = 7) {
    try {
        const result = await pool.query(`
            WITH days_series AS (
                SELECT generate_series(
                    CURRENT_DATE - INTERVAL '${days - 1} days',
                    CURRENT_DATE,
                    '1 day'::interval
                )::date AS day
            )
            SELECT 
                TO_CHAR(ds.day, 'Dy') as day_name,
                ds.day,
                COALESCE(COUNT(q.id), 0) as count
            FROM days_series ds
            LEFT JOIN quiz_reports q ON DATE(q.completed_at) = ds.day
            GROUP BY ds.day
            ORDER BY ds.day ASC
        `);

        return result.rows.map(row => ({
            day: row.day_name,
            count: parseInt(row.count)
        }));
    } catch (error) {
        console.error('[DB] Error al obtener actividad por día:', error);
        return [];
    }
}

/**
 * Obtener consumo de tokens por día (últimos 7 días)
 */
export async function getTokensByDay(days = 7) {
    try {
        const result = await pool.query(`
            WITH days_series AS (
                SELECT generate_series(
                    CURRENT_DATE - INTERVAL '${days - 1} days',
                    CURRENT_DATE,
                    '1 day'::interval
                )::date AS day
            )
            SELECT 
                TO_CHAR(ds.day, 'Dy') as day_name,
                ds.day,
                COALESCE(SUM(q.tokens_used), 0) as tokens
            FROM days_series ds
            LEFT JOIN quiz_reports q ON DATE(q.completed_at) = ds.day
            GROUP BY ds.day
            ORDER BY ds.day ASC
        `);

        return result.rows.map(row => ({
            day: row.day_name,
            tokens: parseInt(row.tokens)
        }));
    } catch (error) {
        console.error('[DB] Error al obtener tokens por día:', error);
        return [];
    }
}

/**
 * Obtener distribución de uso por modelo IA
 */
export async function getModelUsage() {
    try {
        const result = await pool.query(`
            SELECT 
                CASE 
                    WHEN model_used ILIKE '%gemini%' THEN 'Gemini'
                    WHEN model_used ILIKE '%gpt%' OR model_used ILIKE '%openai%' THEN 'OpenAI'
                    WHEN model_used ILIKE '%claude%' OR model_used ILIKE '%anthropic%' THEN 'Claude'
                    WHEN model_used ILIKE '%deepseek%' THEN 'DeepSeek'
                    ELSE 'Otros'
                END as model_name,
                COUNT(*) as usage_count
            FROM quiz_reports
            WHERE model_used IS NOT NULL
            GROUP BY model_name
            ORDER BY usage_count DESC
        `);

        const modelUsage = {};
        result.rows.forEach(row => {
            modelUsage[row.model_name] = parseInt(row.usage_count);
        });

        return modelUsage;
    } catch (error) {
        console.error('[DB] Error al obtener uso de modelos:', error);
        return {};
    }
}

/**
 * Obtener estadísticas globales mejoradas con datos históricos
 * Calcula los totales dinámicamente desde user_metrics y quiz_reports
 */
export async function getEnhancedStats() {
    try {
        // Calcular totales globales desde user_metrics
        const totalsResult = await pool.query(`
            SELECT 
                COUNT(*) as total_users,
                SUM(m.quizzes_completed) as total_quizzes_completed,
                SUM(m.total_questions) as total_questions_processed,
                SUM(m.total_tokens_used) as total_tokens_used,
                SUM(m.total_errors) as total_errors
            FROM user_metrics m
            RIGHT JOIN users u ON m.user_id = u.id
        `);

        const totals = totalsResult.rows[0];

        // Obtener sesiones activas
        const activeSessionsResult = await pool.query('SELECT COUNT(*) as count FROM active_sessions WHERE completed = false');

        const baseStats = {
            total_users: parseInt(totals.total_users || 0),
            total_quizzes_completed: parseInt(totals.total_quizzes_completed || 0),
            total_questions_processed: parseInt(totals.total_questions_processed || 0),
            total_tokens_used: parseInt(totals.total_tokens_used || 0),
            total_errors: parseInt(totals.total_errors || 0),
            active_sessions: parseInt(activeSessionsResult.rows[0].count || 0)
        };

        const [activityByDay, tokensByDay, modelUsage] = await Promise.all([
            getActivityByDay(7),
            getTokensByDay(7),
            getModelUsage()
        ]);

        return {
            ...baseStats,
            activityByDay,
            tokensByDay,
            modelUsage
        };
    } catch (error) {
        console.error('[DB] Error al obtener estadísticas mejoradas:', error);
        throw error;
    }
}

// Exportar pool para uso directo si es necesario
export { pool };
