/**
 * @file database.js
 * @description Módulo de conexión y operaciones con PostgreSQL
 */

import pg from 'pg';
const { Pool } = pg;

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '7f5253d09cb2157c4921',
    host: process.env.DB_HOST || 'n8n_postgres',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'n8n',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 20, // Máximo de conexiones en el pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

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
 * Crear un nuevo usuario
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
             WHERE u.token = $1`,
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
export async function setUserEnabled(userId, enabled) {
    try {
        const result = await pool.query(
            'UPDATE users SET enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [enabled, userId]
        );
        console.log(`[DB] 🔄 Usuario ${userId} ${enabled ? 'habilitado' : 'inhabilitado'}`);
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
            'UPDATE users SET last_activity = CURRENT_TIMESTAMP WHERE id = $1',
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
                 total_questions_processed = total_questions_processed + $3,
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
            `SELECT u.id, u.identifier, u.username, u.enabled, u.created_at, u.last_activity,
                    COALESCE(m.quizzes_completed, 0) as quizzes_completed,
                    COALESCE(m.total_questions_processed, 0) as total_questions_processed,
                    COALESCE(m.total_tokens_used, 0) as total_tokens_used,
                    COALESCE(m.total_errors, 0) as total_errors
             FROM users u
             LEFT JOIN user_metrics m ON u.id = m.user_id
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
                    COALESCE(m.quizzes_completed, 0) as quizzes_completed,
                    COALESCE(m.total_questions_processed, 0) as total_questions_processed,
                    COALESCE(m.total_tokens_used, 0) as total_tokens_used,
                    COALESCE(m.total_errors, 0) as total_errors
             FROM users u
             LEFT JOIN user_metrics m ON u.id = m.user_id
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
            `SELECT e.*, u.username, u.identifier
             FROM error_logs e
             JOIN users u ON e.user_id = u.id
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
             WHERE s.completed_at IS NULL
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
 */
export async function saveQuizReport(userId, reportData) {
    try {
        const result = await pool.query(
            `INSERT INTO quiz_history (
                user_id, session_id, questions_total, questions_correct, questions_failed,
                tokens_used, model_used, duration_seconds, report_data, report_title, platform
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id`,
            [
                userId,
                reportData.sessionId || null,
                reportData.totalQuestions || 0,
                reportData.correctAnswers || 0,
                reportData.failedAnswers || 0,
                reportData.tokensUsed || 0,
                reportData.modelUsed || 'unknown',
                reportData.durationSeconds || 0,
                JSON.stringify(reportData),
                reportData.title || 'Cuestionario',
                reportData.platform || 'Moodle'
            ]
        );
        
        console.log(`[DB] 📊 Informe guardado: ID=${result.rows[0].id}, Usuario=${userId}`);
        return result.rows[0].id;
    } catch (error) {
        console.error('[DB] Error al guardar informe:', error);
        throw error;
    }
}

/**
 * Obtener informes de un usuario
 */
export async function getUserReports(userId, limit = 50) {
    try {
        const result = await pool.query(
            `SELECT id, report_title, platform, questions_total, questions_correct, 
                    questions_failed, duration_seconds, completed_at
             FROM quiz_history
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
            `SELECT * FROM quiz_history WHERE id = $1 AND user_id = $2`,
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
            'SELECT COUNT(*) FROM quiz_history WHERE user_id = $1',
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
            'DELETE FROM quiz_history WHERE id = $1 AND user_id = $2',
            [reportId, userId]
        );
        
        console.log(`[DB] 🗑️ Informe ${reportId} eliminado`);
        return true;
    } catch (error) {
        console.error('[DB] Error al eliminar informe:', error);
        throw error;
    }
}

// Exportar pool para uso directo si es necesario
export { pool };
