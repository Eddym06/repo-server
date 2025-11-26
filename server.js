/**
 * @file server_ge.js
 * @description v27.0.0-Secure - Enhanced Orchestrator Server with Robust AI Response Normalization
 *
 * ARCHITECTURE:
 * - Robust response normalization for multiple AI response formats
 * - Enhanced error handling with retries
 * - Optimized batch processing and image compression
 * 
 * SUPPORTED QUESTION TYPES:
 * - gapselect, ddwtos, ddmarker, multichoice, matching, ordering, truefalse, shortanswer, moodle_match, moodle_gapselect, radio
 * 
 * STANDARD RESPONSE FORMAT:
 * {
 *   "answers": [
 *     {
 *       "question_number": <number>,
 *       "answer": <type-specific-answer>,
 *       "error": <optional-error-message>
 *     }
 *   ]
 * }
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fetch from 'node-fetch';
import pdf from 'pdf-parse';
import bcrypt from 'bcrypt';
import { WebSocketServer } from 'ws';
import * as db from './database.js';
import { optimizeImage, needsOptimization } from './utils.js';
import { createOptimizedBatches, estimatePayloadTokens } from './utils.js';
import { sanitizeString, coerceArrayStrings, validateAndCoerceAnswer } from './answerShape.js';

// --- RATE LIMIT & DEGRADE STATE ---
const RATE_LIMIT_CONFIG = {
    enableCooldown: true,
    enablePartitionDegrade: true,
    degradeWindowMs: 60_000,        // 1 minuto de modo degradado
    degradedBatchSize: 1,           // tamaño cuando degradado
    minCooldownMs: 1500,            // mínimo entre peticiones tras 429
    maxCooldownMs: 15_000,          // máximo cool-down
    cooldownGrowthFactor: 1.5,      // factor de crecimiento por 429 consecutivos
    logPrefix: '[RATE-LIMIT]'
};

let nextAllowedRequestTime = 0;     // timestamp ms para próxima petición
let consecutive429 = 0;             // contador de 429 consecutivos
let degradeActive = false;          // modo degradado activo
let degradeUntil = 0;               // timestamp fin degradado
let successesSinceDegrade = 0;      // éxitos para posible salida temprana
const SUCCESS_TO_RECOVER = 5;       // éxitos antes de recuperar si antes de ventana

// --- TOKEN BUDGET (Tokens por minuto) ---
const TOKEN_BUDGET_CONFIG = {
    enabled: true,
    limitPerMinute: 30000,
    nearThreshold: 2000,     // "faltando 2000" del límite
    preWaitMs: 2200,         // espera cuando excedería
    postWaitMs: 2000,        // espera cuando está cerca pero no excede
    logPrefix: '[TOKENS]'
};

// Ventana deslizante de tokens (array de {ts, tokens})
const tokenWindow = [];

// --- LIGHTWEIGHT MUTEX FOR RATE-LIMIT / TOKEN WINDOW CRITICAL SECTIONS ---
class AsyncMutex {
    constructor() { this._locked = false; this._queue = []; }
    acquire() {
        return new Promise(resolve => {
            if (!this._locked) { this._locked = true; resolve(); }
            else this._queue.push(resolve);
        });
    }
    release() {
        if (this._queue.length) {
            const next = this._queue.shift();
            next();
        } else {
            this._locked = false;
        }
    }
    async runExclusive(fn) {
        await this.acquire();
        try { return await fn(); } finally { this.release(); }
    }
}
const rateLimitMutex = new AsyncMutex();

function pruneTokenWindow() {
    const cutoff = now() - 60_000; // 1 minuto
    while (tokenWindow.length && tokenWindow[0].ts < cutoff) tokenWindow.shift();
}

function tokensUsedLastMinute() {
    pruneTokenWindow();
    const total = tokenWindow.reduce((sum, e) => sum + e.tokens, 0);
    // Sanity reset si total imposible (más del triple del límite) para evitar contaminar gating
    if (total > TOKEN_BUDGET_CONFIG.limitPerMinute * 3) {
        console.warn(`${TOKEN_BUDGET_CONFIG.logPrefix} Valor anómalo (${total}) > 3x límite. Reiniciando ventana.`);
        tokenWindow.length = 0;
        return 0;
    }
    return total;
}

function msUntilWindowReset() {
    pruneTokenWindow();
    if (!tokenWindow.length) return 0;
    const oldest = tokenWindow[0].ts;
    const resetAt = oldest + 60_000;
    return Math.max(0, resetAt - now());
}

function registerTokens(count) {
    if (!TOKEN_BUDGET_CONFIG.enabled) return;
    tokenWindow.push({ ts: now(), tokens: count });
    pruneTokenWindow();
}

async function preflightTokenGate(estimatedTokens) {
    if (!TOKEN_BUDGET_CONFIG.enabled) return { postDelay: false };
    const used = tokensUsedLastMinute();
    const limit = TOKEN_BUDGET_CONFIG.limitPerMinute;
    const nearStart = limit - TOKEN_BUDGET_CONFIG.nearThreshold; // 28000 si limit=30000 y near=2000
    let postDelay = false;
    console.log(`${TOKEN_BUDGET_CONFIG.logPrefix} windowUsed=${used} entries=${tokenWindow.length} est=${estimatedTokens}`);
    if (used >= nearStart) {
        if (used + estimatedTokens > limit) {
            // Si ya estamos por encima o justo en el límite, esperar hasta que expire la ventana en lugar de pequeños sleeps repetidos
            const msRemain = msUntilWindowReset();
            if (used >= limit && msRemain > TOKEN_BUDGET_CONFIG.preWaitMs) {
                console.log(`${TOKEN_BUDGET_CONFIG.logPrefix} Límite alcanzado (${used}/${limit}). Espera larga ${msRemain}ms hasta liberar ventana.`);
                await new Promise(r => setTimeout(r, msRemain));
            } else {
                console.log(`${TOKEN_BUDGET_CONFIG.logPrefix} Estimado excedería límite (${used}+${estimatedTokens}>${limit}). Esperando ${TOKEN_BUDGET_CONFIG.preWaitMs}ms.`);
                await new Promise(r => setTimeout(r, TOKEN_BUDGET_CONFIG.preWaitMs));
            }
        } else {
            console.log(`${TOKEN_BUDGET_CONFIG.logPrefix} Cerca del límite (${used}/${limit}). Post-delay ${TOKEN_BUDGET_CONFIG.postWaitMs}ms.`);
            postDelay = true;
        }
    }
    return { postDelay };
}

function now() { return Date.now(); }

function isRateLimitErrorMessage(msg = '') {
    return /rate limit/i.test(msg) || /429/.test(msg);
}

function parseRetrySeconds(message = '') {
    const m = message.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)s/i);
    if (m) return parseFloat(m[1]);
    return null;
}

function extractRequestedTokens(text='') {
    const m = text.match(/Requested\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

async function respectGlobalCooldown() {
    if (!RATE_LIMIT_CONFIG.enableCooldown) return;
    const waitMs = nextAllowedRequestTime - now();
    if (waitMs > 0) {
        console.log(`${RATE_LIMIT_CONFIG.logPrefix} Esperando ${waitMs}ms por cool-down activo.`);
        await new Promise(r => setTimeout(r, waitMs));
    }
}

function scheduleCooldown(message, aggressive = false) {
    if (!RATE_LIMIT_CONFIG.enableCooldown) return;
    const suggestedSeconds = parseRetrySeconds(message) || 3; // fallback 3s
    consecutive429++;
    const baseMs = suggestedSeconds * 1000;
    const factor = aggressive ? (consecutive429 + 1) * RATE_LIMIT_CONFIG.cooldownGrowthFactor : (consecutive429 + 1);
    const rawDelay = baseMs * factor;
    const clamped = Math.min(RATE_LIMIT_CONFIG.maxCooldownMs, Math.max(RATE_LIMIT_CONFIG.minCooldownMs, rawDelay));
    nextAllowedRequestTime = now() + clamped;
    console.log(`${RATE_LIMIT_CONFIG.logPrefix} Cool-down programado ${clamped}ms (suggested=${baseMs} factor=${factor.toFixed(2)} consecutive429=${consecutive429}).`);
}

function activateDegrade() {
    if (!RATE_LIMIT_CONFIG.enablePartitionDegrade) return;
    degradeActive = true;
    degradeUntil = now() + RATE_LIMIT_CONFIG.degradeWindowMs;
    successesSinceDegrade = 0;
    console.log(`${RATE_LIMIT_CONFIG.logPrefix} Modo degradado ACTIVADO hasta ${new Date(degradeUntil).toISOString()}`);
}

function maybeRecoverFromDegrade() {
    if (!degradeActive) return;
    if (now() >= degradeUntil || successesSinceDegrade >= SUCCESS_TO_RECOVER) {
        console.log(`${RATE_LIMIT_CONFIG.logPrefix} Modo degradado DESACTIVADO (éxitos=${successesSinceDegrade}, tiempo restante=${Math.max(0, degradeUntil - now())}ms)`);
        degradeActive = false;
        successesSinceDegrade = 0;
        consecutive429 = 0; // reset racha
    }
}

function registerBatchSuccess() {
    if (degradeActive) {
        successesSinceDegrade++;
        maybeRecoverFromDegrade();
    } else {
        consecutive429 = 0; // reset si no estamos en degrade
    }
}

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 para aceptar conexiones externas en VPS

// ===== MULTI-USER SESSION MANAGEMENT =====
const MAX_CONCURRENT_USERS = parseInt(process.env.MAX_CONCURRENT_USERS) || 15;
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 3600000; // 1 hora por defecto
const sessions = new Map(); // Usando Map para mejor rendimiento
const userMetrics = new Map(); // Métricas por usuario

class SessionManager {
    constructor() {
        this.sessions = sessions;
        this.userMetrics = userMetrics;
        // Limpieza automática de sesiones expiradas cada 5 minutos
        setInterval(() => this.cleanExpiredSessions(), 300000);
    }
    
    createSession(questions, answers, userId = null, progress = null) {
        // Verificar límite de usuarios concurrentes
        const activeSessions = Array.from(this.sessions.values()).filter(s => !s.expired);
        if (activeSessions.length >= MAX_CONCURRENT_USERS) {
            throw new Error(`Límite de usuarios concurrentes alcanzado (${MAX_CONCURRENT_USERS})`);
        }
        
        const sessionId = crypto.randomBytes(16).toString('hex');
        const session = {
            id: sessionId,
            userId: userId || sessionId.substring(0, 8),
            questions,
            answers,
            currentIndex: 0,
            createdAt: Date.now(),
            lastAccessAt: Date.now(),
            expiresAt: Date.now() + SESSION_TIMEOUT,
            expired: false,
            questionsTotal: questions.length,
            questionsProcessed: 0,
            progress: progress // ⬅️ NUEVO: Guardar progreso del quiz
        };
        
        this.sessions.set(sessionId, session);
        this.updateUserMetrics(session.userId, 'session_created');
        
        console.log(`[SESSION-MANAGER] Sesión creada: ${sessionId} | Usuario: ${session.userId} | Activas: ${activeSessions.length + 1}/${MAX_CONCURRENT_USERS}`);
        if (progress) {
            console.log(`[SESSION-MANAGER] Progreso registrado: ${progress.current || '?'}/${progress.total || '?'} (${progress.source})`);
        }
        
        // Auto-expiración
        setTimeout(() => this.expireSession(sessionId), SESSION_TIMEOUT);
        
        return sessionId;
    }
    
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        
        // Verificar expiración
        if (session.expired || Date.now() > session.expiresAt) {
            this.expireSession(sessionId);
            return null;
        }
        
        // Actualizar último acceso
        session.lastAccessAt = Date.now();
        return session;
    }
    
    expireSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && !session.expired) {
            session.expired = true;
            this.updateUserMetrics(session.userId, 'session_expired');
            console.log(`[SESSION-MANAGER] Sesión expirada: ${sessionId} | Usuario: ${session.userId}`);
        }
    }
    
    deleteSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.updateUserMetrics(session.userId, 'session_deleted');
            this.sessions.delete(sessionId);
            console.log(`[SESSION-MANAGER] Sesión eliminada: ${sessionId}`);
        }
    }
    
    cleanExpiredSessions() {
        const now = Date.now();
        let cleaned = 0;

        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.expired || now > session.expiresAt) {
                this.sessions.delete(sessionId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[SESSION-MANAGER] Limpieza automática: ${cleaned} sesiones eliminadas`);
        }

        return cleaned;
    }

    cleanupSessions() {
        return this.cleanExpiredSessions();
    }    updateUserMetrics(userId, event) {
        if (!this.userMetrics.has(userId)) {
            this.userMetrics.set(userId, {
                userId,
                sessionsCreated: 0,
                sessionsExpired: 0,
                sessionsDeleted: 0,
                questionsProcessed: 0,
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                modelUsage: {} // ⬅️ NUEVO: Contador de uso por modelo { 'gpt-4o': 5, 'gemini-2.5-flash': 3 }
            });
        }
        
        const metrics = this.userMetrics.get(userId);
        metrics.lastSeen = Date.now();
        
        switch(event) {
            case 'session_created':
                metrics.sessionsCreated++;
                break;
            case 'session_expired':
                metrics.sessionsExpired++;
                break;
            case 'session_deleted':
                metrics.sessionsDeleted++;
                break;
            case 'question_processed':
                metrics.questionsProcessed++;
                break;
        }
    }
    
    // 📊 NUEVO: Función para trackear modelo usado
    trackModelUsage(userId, model) {
        if (!this.userMetrics.has(userId)) {
            this.updateUserMetrics(userId, 'session_created'); // Inicializar si no existe
        }
        
        const metrics = this.userMetrics.get(userId);
        if (!metrics.modelUsage) {
            metrics.modelUsage = {};
        }
        
        metrics.modelUsage[model] = (metrics.modelUsage[model] || 0) + 1;
        console.log(`[MODEL-TRACKING] Usuario ${userId}: ${model} usado ${metrics.modelUsage[model]} veces`);
    }
    
    // 📊 NUEVO: Obtener modelo favorito de un usuario
    getFavoriteModel(userId) {
        const metrics = this.userMetrics.get(userId);
        if (!metrics || !metrics.modelUsage || Object.keys(metrics.modelUsage).length === 0) {
            return null;
        }
        
        // Encontrar el modelo con más usos
        let favoriteModel = null;
        let maxUses = 0;
        
        for (const [model, uses] of Object.entries(metrics.modelUsage)) {
            if (uses > maxUses) {
                maxUses = uses;
                favoriteModel = model;
            }
        }
        
        return favoriteModel;
    }
    
    getActiveUsers() {
        const activeSessions = Array.from(this.sessions.values()).filter(s => !s.expired);
        return activeSessions.length;
    }

    getActiveSessionsCount() {
        return this.getActiveUsers();
    }
    
    getMetrics() {
        return {
            activeSessions: this.getActiveUsers(),
            maxConcurrentUsers: MAX_CONCURRENT_USERS,
            totalSessions: this.sessions.size,
            users: Array.from(this.userMetrics.values())
        };
    }
}

const sessionManager = new SessionManager();
const app = express();

// CORS configurado para aceptar extensiones de Chrome y dominios específicos
const allowedOrigins = [
    /^chrome-extension:\/\//,
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https?:\/\/.*\.easypanel\.host$/,
    process.env.ALLOWED_ORIGIN
].filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Permitir requests sin origin (Postman, curl, etc.)
        if (!origin) return cb(null, true);
        
        // Verificar si el origin coincide con algún patrón permitido
        const allowed = allowedOrigins.some(pattern => {
            if (pattern instanceof RegExp) return pattern.test(origin);
            return pattern === origin;
        });
        
        cb(null, allowed);
    },
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));

// --- AI LOGIC ---
function processAnswerByType(answer, question) {
    const questionType = question.type || 'unknown';
    console.log(`[PROCESS] Processing question #${answer.question_number} of type: ${questionType}`);
    // Normalizar alias de tipos para reducir duplicación
    const aliasMap = {
        'checkbox': 'multichoice',
        'short_text': 'shortanswer',
        'short-answer': 'shortanswer',
        'radio': 'radio',
        'fill_in_the_blanks_from_list': 'ddwtos',
        'moodle_dragdrop_text': 'ddwtos',
        'dragdrop_text': 'ddwtos'
    };
    const originalLower = questionType.toLowerCase();
    const normalizedType = aliasMap[originalLower] || originalLower;

    const supportedTypes = [
        // Tipos canónicos
        'gapselect','moodle_gapselect',
        'ddwtos','ddmarker','moodle_dragdrop_marker',
        'multichoice','moodle_multichoice','checkbox',
        'matching','moodle_match',
        'ordering',
        'truefalse','moodle_truefalse',
        'shortanswer','short_text','short-answer',
        'radio',
        'cloze',
        // Alias adicionales normalizados
        'fill_in_the_blanks_from_list','moodle_dragdrop_text','dragdrop_text'
    ];

    if (!supportedTypes.includes(originalLower)) {
        console.warn(`[WARN] Unknown question type: ${questionType}. Using generic processing.`);
        console.warn('[WARN] Tipos soportados actuales:', supportedTypes.join(','));
        return answer.answer;
    }

    switch (normalizedType) {
        case 'gapselect':
        case 'moodle_gapselect':
            if (Array.isArray(answer.answer)) {
                return answer.answer;
            }
            break;
        case 'ddmarker':
        case 'moodle_dragdrop_marker':
            if (Array.isArray(answer.answer)) {
                return answer.answer;
            }
            break;
        case 'multichoice':
        case 'moodle_multichoice':
            if (Array.isArray(answer.answer)) {
                return answer.answer;
            }
            break;
        case 'matching':
        case 'moodle_match':
            if (Array.isArray(answer.answer)) {
                return answer.answer;
            }
            break;
        case 'ordering':
            // Ordering: debe ser array de strings en el orden correcto.
            // Fallbacks si la IA falló (null) o devolvió formato inesperado.
            if (Array.isArray(answer.answer)) {
                return answer.answer;
            }
            try {
                // Formato alternativo: objeto { order: [...] }
                if (answer.answer && typeof answer.answer === 'object' && Array.isArray(answer.answer.order)) {
                    return answer.answer.order;
                }
                // Formato string: intentar dividir por separadores comunes
                if (typeof answer.answer === 'string') {
                    const raw = answer.answer.trim();
                    const parts = raw.split(/\r?\n|\->|\u2192|,|;|\|/).map(s => s.trim()).filter(Boolean);
                    if (parts.length > 1) {
                        return parts;
                    }
                }
            } catch (e) {
                console.warn('[WARN] Error intentando normalizar ordering:', e.message);
            }
            // Si llegamos aquí, la respuesta es inválida (null, etc). Proveer fallback usando opciones originales si existen.
            if (question && Array.isArray(question.options) && question.options.length > 0) {
                console.warn(`[WARN] Respuesta ordering inválida ( ${answer.answer} ). Usando opciones originales como fallback.`);
                // Marcar en el objeto de respuesta que se usó fallback para poder registrar en el content script.
                answer.fallbackOrderingUsed = true;
                console.log(JSON.stringify({ level: 'INFO', event: 'ordering_fallback', reason: 'invalid_or_null', question: question.number, options_used: question.options }));
                return [...question.options];
            }
            console.warn('[WARN] Respuesta ordering inválida y sin opciones disponibles para fallback. Devolviendo array vacío.');
            answer.fallbackOrderingUsed = true;
            console.log(JSON.stringify({ level: 'INFO', event: 'ordering_fallback', reason: 'invalid_no_options', question: question?.number, options_used: [] }));
            return [];
            break;
        case 'truefalse':
        case 'moodle_truefalse':
            if (typeof answer.answer === 'string' || typeof answer.answer === 'boolean') {
                return answer.answer;
            }
            break;
        case 'shortanswer':
            if (typeof answer.answer === 'string') {
                return answer.answer;
            }
            break;
        // 'short_text' y variantes ya normalizadas a shortanswer
        case 'radio':
            // Para radio, esperamos una string. Si viene array, tomar el primer elemento
            if (typeof answer.answer === 'string') {
                return answer.answer;
            }
            if (Array.isArray(answer.answer) && answer.answer.length > 0) {
                console.warn(`[WARN] Radio question received array, taking first element:`, answer.answer);
                return String(answer.answer[0]);
            }
            // Si no es válido, devolver null para que se marque como error
            console.warn(`[WARN] Invalid answer format for radio question:`, answer.answer);
            return null;
        case 'ddwtos':
            if (Array.isArray(answer.answer)) {
                return answer.answer;
            }
            break;
        case 'fill_in_the_blanks_from_list': // normalizado a ddwtos pero si llega sin mapear
            if (Array.isArray(answer.answer)) return answer.answer;
            break;
        case 'cloze':
            // Aceptar múltiples formatos de salida del modelo y normalizar
            try {
                let raw = answer.answer;
                if (!raw) return answer.answer;
                // Si viene como {answers:[...]}
                if (raw.answers && Array.isArray(raw.answers)) raw = raw.answers;
                if (Array.isArray(raw)) {
                    if (raw.length === 0) return raw; // nada que hacer
                    // Validar que el array tiene elementos antes de acceder a raw[0]
                    if (raw.length > 0) {
                        // Formato 1: array de strings
                        if (typeof raw[0] === 'string') {
                            return raw.map((txt, idx) => ({ placeholder_number: idx + 1, answer_text: txt }));
                        }
                        // Formato 2: array de objetos con answer_text / answer
                        if (typeof raw[0] === 'object') {
                            return raw.map((o, idx) => ({
                                placeholder_number: o.placeholder_number || o.number || idx + 1,
                                answer_text: o.answer_text || o.answer || ''
                            }));
                        }
                    }
                }
            } catch (e) {
                console.warn('[WARN] Error normalizando respuesta cloze:', e.message);
            }
            return answer.answer;
    }
    
    console.warn(`[WARN] Unexpected answer format for type ${questionType}:`, answer.answer);
    return answer.answer;
}

function normalizeAIResponse(aiResponse, questions) {
    console.log('[NORMALIZE] Normalizing AI response:', JSON.stringify(aiResponse, null, 2));
    
    if (aiResponse && aiResponse.answers && Array.isArray(aiResponse.answers)) {
        console.log('[NORMALIZE] Response already in correct format');
        return aiResponse;
    }
    
    let normalizedAnswers = [];
    
    if (Array.isArray(aiResponse)) {
        console.log('[NORMALIZE] Detected direct array format');
        normalizedAnswers = aiResponse.map((answer, index) => ({
            question_number: index + 1,
            answer: answer
        }));
    } else if (aiResponse && typeof aiResponse === 'object') {
        const keys = Object.keys(aiResponse);
        
        if (keys.every(key => !isNaN(parseInt(key)))) {
            console.log('[NORMALIZE] Detected object with numeric keys');
            normalizedAnswers = keys.map(key => ({
                question_number: parseInt(key),
                answer: aiResponse[key]
            }));
        } else {
            console.log('[NORMALIZE] Attempting to map flat object');
            questions.forEach((question, index) => {
                const questionNumber = question.number || index + 1;
                const possibleKeys = [`question_${questionNumber}`, `q${questionNumber}`, `pregunta_${questionNumber}`, questionNumber.toString()];
                let answer = null;
                
                for (const key of possibleKeys) {
                    if (aiResponse[key] !== undefined) {
                        answer = aiResponse[key];
                        break;
                    }
                }
                
                if (answer !== null) {
                    normalizedAnswers.push({
                        question_number: questionNumber,
                        answer: answer
                    });
                }
            });
        }
    } else if (typeof aiResponse === 'string') {
        try {
            console.log('[NORMALIZE] Attempting to parse string as JSON');
            const parsed = JSON.parse(aiResponse);
            return normalizeAIResponse(parsed, questions);
        } catch (error) {
            console.warn('[NORMALIZE] Could not parse string as JSON:', error.message);
        }
    }
    
    if (normalizedAnswers.length === 0) {
        console.warn('[NORMALIZE] Could not normalize response, creating empty structure');
        normalizedAnswers = questions.map((question, index) => ({
            question_number: question.number || index + 1,
            answer: null,
            error: 'No valid response from AI'
        }));
    }
    
    const normalized = { answers: normalizedAnswers };
    console.log('[NORMALIZE] Normalized response:', JSON.stringify(normalized, null, 2));
    return normalized;
}

// --- SHAPE GUARDS & SANITIZERS ---

function validateNormalizedResponse(normalizedResponse, questions) {
    if (!normalizedResponse || !normalizedResponse.answers || !Array.isArray(normalizedResponse.answers)) {
        console.error('[VALIDATE] Invalid normalized response structure');
        return false;
    }
    
    const questionNumbers = questions.map(q => q.number);
    const answerNumbers = normalizedResponse.answers.map(a => a.question_number);
    
    const missingQuestions = questionNumbers.filter(num => !answerNumbers.includes(num));
    if (missingQuestions.length > 0) {
        console.warn('[VALIDATE] Missing answers for questions:', missingQuestions);
        return false;
    }
    
    return true;
}

async function processBatch(questionBatch, optimizedImage, systemPrompt, model, apiKey, batchIndex, personalizationImages = null) {
    console.log(`[BATCH ${batchIndex}] Procesando ${questionBatch.length} preguntas (degradeActive=${degradeActive})`);
    console.log(`[BATCH ${batchIndex}] Preguntas enviadas:`, JSON.stringify(questionBatch, null, 2));
    
    const estimatedTokens = estimatePayloadTokens(systemPrompt, questionBatch, optimizedImage);
    console.log(`[BATCH ${batchIndex}] Tokens estimados: ${estimatedTokens}`);
    
    // Detectar tipo de modelo
    const isGemini = model && model.toLowerCase().includes('gemini');
    const isGPT5Mini = model && model.toLowerCase().includes('gpt-5-mini');
    const isGrok = model && model.toLowerCase().includes('grok');
    const isDeepSeek = model && (model.toLowerCase().includes('deepseek') || model === 'deepseek-chat' || model === 'deepseek-reasoner');
    const isClaude = model && model.toLowerCase().includes('claude');
    
    const userContent = [
        { type: 'text', text: `Resuelve este cuestionario: ${JSON.stringify(questionBatch)}` },
        optimizedImage ? { type: 'image_url', image_url: { url: optimizedImage, detail: 'high' } } : null
    ].filter(Boolean);
    
    // Configurar tokens según el modelo
    const payload = {
        model: model || 'gpt-4o',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
        response_format: { type: 'json_object' }
    };
    
    // Configurar tokens y parámetros específicos por modelo
    if (isGPT5Mini) {
        payload.max_completion_tokens = 128000; // 128K tokens máximo para GPT-5-mini
        payload.reasoning_effort = "high"; // Activa el modo de pensamiento profundo
    } else if (isGrok) {
        payload.max_output_tokens = 5000; // 5K tokens de salida para Grok (2M contexto)
    } else if (isDeepSeek) {
        payload.max_tokens = 8000; // DeepSeek soporta hasta 8K tokens de salida
    } else if (isClaude) {
        payload.max_tokens = 8192; // Claude Haiku soporta hasta 8K tokens de salida (1M contexto)
    } else {
        payload.max_tokens = 4096;
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let response, postDelay, data;
            
            if (isGemini) {
                // API de Gemini
                const geminiModel = model || 'gemini-2.5-flash';
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
                
                // Construir el contenido para Gemini
                const parts = [
                    { text: systemPrompt }
                ];
                
                // ⬅️ NUEVO: Agregar imágenes de personalización PRIMERO
                if (personalizationImages && personalizationImages.length > 0) {
                    console.log(`[BATCH ${batchIndex}] 🎨 Agregando ${personalizationImages.length} imágenes de personalización`);
                    
                    for (const img of personalizationImages) {
                        try {
                            // Extraer mime type y datos base64
                            let mimeType = img.type || 'image/jpeg';
                            let base64Data = img.data;
                            
                            // Si tiene prefijo data:, extraerlo
                            if (base64Data.startsWith('data:')) {
                                const match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
                                if (match) {
                                    mimeType = match[1];
                                    base64Data = match[2];
                                } else {
                                    base64Data = base64Data.split(',')[1] || base64Data;
                                }
                            }
                            
                            parts.push({
                                inline_data: {
                                    mime_type: mimeType,
                                    data: base64Data
                                }
                            });
                            
                            console.log(`[BATCH ${batchIndex}] ✓ Imagen de personalización agregada: ${img.name} (${mimeType})`);
                        } catch (error) {
                            console.error(`[BATCH ${batchIndex}] ✗ Error agregando imagen ${img.name}:`, error.message);
                        }
                    }
                }
                
                // Agregar preguntas como texto
                parts.push({ text: `Resuelve este cuestionario: ${JSON.stringify(questionBatch)}` });
                
                // Agregar screenshot del quiz si existe
                if (optimizedImage) {
                    // Gemini necesita la imagen en formato base64 sin el prefijo data:image
                    const base64Data = optimizedImage.split(',')[1] || optimizedImage;
                    parts.push({
                        inline_data: {
                            mime_type: 'image/jpeg',
                            data: base64Data
                        }
                    });
                    console.log(`[BATCH ${batchIndex}] ✓ Screenshot del quiz agregado`);
                }
                
                const geminiPayload = {
                    contents: [{
                        parts: parts
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 4096,
                        responseMimeType: 'application/json'
                    }
                };
                
                const { response: resp, postDelay: pd } = await rateLimitMutex.runExclusive(async () => {
                    await respectGlobalCooldown();
                    const gateResult = await preflightTokenGate(estimatedTokens);
                    const resp = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(geminiPayload)
                    });
                    return { response: resp, postDelay: gateResult.postDelay };
                });
                
                response = resp;
                postDelay = pd;
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`[BATCH ${batchIndex}] Error de API Gemini (${response.status}):`, errorText);
                    throw new Error(`Error de API Gemini en lote ${batchIndex} (${response.status}): ${errorText}`);
                }
                
                data = await response.json();
                
                // Parsear respuesta de Gemini con validación robusta
                if (data.candidates && data.candidates[0] && data.candidates[0].content) {
                    const content = data.candidates[0].content;
                    
                    // Validar que parts existe y tiene contenido
                    if (!content.parts || content.parts.length === 0) {
                        console.error(`[BATCH ${batchIndex}] Respuesta de Gemini sin parts:`, JSON.stringify(data, null, 2));
                        throw new Error(`Respuesta de Gemini en lote ${batchIndex}: array 'parts' vacío o inexistente`);
                    }
                    
                    // Validar que parts[0] tiene texto
                    if (!content.parts[0] || !content.parts[0].text) {
                        console.error(`[BATCH ${batchIndex}] Respuesta de Gemini sin texto en parts[0]:`, JSON.stringify(data, null, 2));
                        throw new Error(`Respuesta de Gemini en lote ${batchIndex}: 'parts[0].text' no existe`);
                    }
                    
                    const textResponse = content.parts[0].text;
                    data = JSON.parse(textResponse);
                } else {
                    // Gemini devolvió estructura inesperada
                    console.error(`[BATCH ${batchIndex}] Respuesta de Gemini con estructura inválida:`, JSON.stringify(data, null, 2));
                    throw new Error(`Respuesta de Gemini en lote ${batchIndex}: falta 'candidates[0].content'`);
                }
                
            } else {
                // API de OpenAI, Grok y DeepSeek (usan el mismo endpoint)
                const { response: resp, postDelay: pd } = await rateLimitMutex.runExclusive(async () => {
                    await respectGlobalCooldown();
                    const gateResult = await preflightTokenGate(estimatedTokens);
                    
                    // Determinar endpoint según el modelo
                    let apiUrl = 'https://api.openai.com/v1/chat/completions';
                    if (isGrok) {
                        apiUrl = 'https://api.x.ai/v1/chat/completions';
                    } else if (isDeepSeek) {
                        apiUrl = 'https://api.deepseek.com/chat/completions';
                    } else if (isClaude) {
                        apiUrl = 'https://api.anthropic.com/v1/messages';
                    }
                    
                    const resp = await fetch(apiUrl, {
                        method: 'POST',
                        headers: isClaude ? {
                            'x-api-key': apiKey,
                            'anthropic-version': '2023-06-01',
                            'Content-Type': 'application/json'
                        } : { 
                            'Authorization': `Bearer ${apiKey}`, 
                            'Content-Type': 'application/json' 
                        },
                        body: JSON.stringify(isClaude ? {
                            model: model,
                            max_tokens: payload.max_tokens,
                            messages: [
                                {
                                    role: 'user',
                                    content: `${systemPrompt}\n\n${JSON.stringify(questionBatch)}`
                                }
                            ]
                        } : payload)
                    });
                    return { response: resp, postDelay: gateResult.postDelay };
                });
                
                response = resp;
                postDelay = pd;
                
                data = await response.json();
            }
            
            if (!response.ok) {
                const errorText = JSON.stringify(data);
                console.error(`[BATCH ${batchIndex}] Error de API (${response.status}):`, errorText);
                const apiName = isGrok ? 'Grok' : (isDeepSeek ? 'DeepSeek' : 'OpenAI');
                const composedMessage = `Error de API ${apiName} en lote ${batchIndex} (${response.status}): ${errorText}`;
                // Detectar 429 temprano y activar degrade si corresponde
                if (response.status === 429 && attempt === 1 && questionBatch.length > 1 && RATE_LIMIT_CONFIG.enablePartitionDegrade) {
                    console.warn(`[BATCH ${batchIndex}] 429 temprano: activando Partition Degrade.`);
                    activateDegrade();
                    scheduleCooldown(errorText, true);
                    const reqTokensEarly = extractRequestedTokens(errorText);
                    if (reqTokensEarly) {
                        console.log(`[TOKENS] Registrando tokens 429 early degrade: ${reqTokensEarly}`);
                        registerTokens(reqTokensEarly);
                    }
                    // Devolver señal especial para procesar como micro-lotes afuera
                    return { degradedQuestions: questionBatch };
                }
                if (response.status === 429) {
                    // Programar cooldown pero NO registrar tokens de petición fallida (evita inflar ventana artificialmente)
                    scheduleCooldown(errorText, false);
                }
                throw new Error(composedMessage);
            }
            
            // Parsear respuesta según la API
            let answerText;
            if (!isGemini) {
                // Claude usa formato diferente
                if (isClaude) {
                    if (!data.content || !data.content[0] || !data.content[0].text) {
                        console.error(`[BATCH ${batchIndex}] Respuesta inválida de Claude:`, JSON.stringify(data, null, 2));
                        throw new Error(`Respuesta inválida de Claude en lote ${batchIndex}: estructura inesperada`);
                    }
                    answerText = data.content[0].text;
                } else {
                    // OpenAI, Grok, DeepSeek
                    if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
                        console.error(`[BATCH ${batchIndex}] Respuesta inválida de OpenAI:`, JSON.stringify(data, null, 2));
                        throw new Error(`Respuesta inválida de OpenAI en lote ${batchIndex}: estructura inesperada`);
                    }
                    answerText = data.choices[0].message.content;
                }
                
                try {
                    data = JSON.parse(answerText);
                } catch (parseError) {
                    console.error(`[BATCH ${batchIndex}] Error al parsear respuesta JSON:`, answerText);
                    data = { answers: questionBatch.map(q => ({
                        question_number: q.number,
                        answer: null,
                        error: 'No se pudo parsear la respuesta de la IA'
                    }))};
                }
            }
            // Para Gemini, 'data' ya está parseado correctamente desde arriba
            
            const normalizedResponse = normalizeAIResponse(data, questionBatch);
            
            if (!validateNormalizedResponse(normalizedResponse, questionBatch)) {
                console.error(`[BATCH ${batchIndex}] Respuesta normalizada inválida:`, JSON.stringify(normalizedResponse, null, 2));
                throw new Error(`La respuesta normalizada del lote ${batchIndex} no tiene una estructura válida`);
            }
            
            console.log(`[BATCH ${batchIndex}] Procesado exitosamente con ${normalizedResponse.answers.length} respuestas`);
            registerBatchSuccess();
            // Registro básico de tokens estimados (lo ideal: usar usage real si API lo devuelve)
            registerTokens(estimatedTokens);
            if (postDelay) {
                console.log(`[TOKENS] Post-delay de ${TOKEN_BUDGET_CONFIG.postWaitMs}ms tras request cercana al límite.`);
                await new Promise(r => setTimeout(r, TOKEN_BUDGET_CONFIG.postWaitMs));
            }
            return normalizedResponse;
            
        } catch (error) {
            console.error(`[BATCH ${batchIndex}] Intento ${attempt}/${maxRetries} fallido:`, error.message);
            
            // Manejo especial para error 503 (Gemini sobrecargado)
            const is503Error = error.message.includes('503') || error.message.includes('UNAVAILABLE') || error.message.includes('overloaded');
            
            if (is503Error && attempt === 1) {
                // Primera vez que aparece 503: pausa de 30 segundos antes de reintentos
                console.log(`[503-OVERLOAD] Gemini sobrecargado detectado. Pausando 30 segundos antes de reintentar...`);
                await new Promise(resolve => setTimeout(resolve, 30000));
            }
            
            if (isRateLimitErrorMessage(error.message)) {
                scheduleCooldown(error.message, attempt === 1);
                // Estrategia especial para lotes de 1: después del segundo 429, esperar hasta reset de ventana
                if (questionBatch.length === 1 && consecutive429 >= 2) {
                    const waitMs = msUntilWindowReset();
                    if (waitMs > 0) {
                        console.log(`${RATE_LIMIT_CONFIG.logPrefix} Single-batch 429 persistente. Espera ventana completa ${waitMs}ms.`);
                        await new Promise(r => setTimeout(r, waitMs));
                    }
                }
            }
            if (attempt < maxRetries) {
                // Para errores 503, usar delay más largo en reintentos subsiguientes
                const delayMs = is503Error ? 5000 * attempt : 2000 * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }
            const fallbackResponse = {
                answers: questionBatch.map(q => ({
                    question_number: q.number,
                    answer: null,
                    error: `Error en procesamiento de lote: ${error.message}`
                }))
            };
            return fallbackResponse;
        }
    }
}

/**
 * Extrae texto de un PDF en base64
 * @param {string} base64Data - PDF en formato base64
 * @returns {Promise<string>} Texto extraído del PDF
 */
async function extractTextFromPDF(base64Data) {
    try {
        // Remover prefijo data:application/pdf;base64, si existe
        const cleanBase64 = base64Data.replace(/^data:application\/pdf;base64,/, '');
        const buffer = Buffer.from(cleanBase64, 'base64');
        
        console.log('[PDF] Extrayendo texto de PDF (tamaño:', buffer.length, 'bytes)');
        const data = await pdf(buffer);
        
        console.log('[PDF] Texto extraído:', {
            pages: data.numpages,
            textLength: data.text.length,
            preview: data.text.substring(0, 200) + '...'
        });
        
        return data.text;
    } catch (error) {
        console.error('[PDF] Error extrayendo texto:', error.message);
        return `[Error al extraer texto del PDF: ${error.message}]`;
    }
}

/**
 * Calcula tokens precisos para texto usando tiktoken
 * @param {string} text - Texto a analizar
 * @returns {number} Número de tokens
 */
function calculateTokens(text) {
    // Aproximación: ~4 caracteres por token (estándar GPT)
    // Para mayor precisión, usar tiktoken, pero esto es suficiente
    return Math.ceil(text.length / 4);
}

/**
 * Procesa documentos de personalización (extrae texto de PDFs)
 * @param {Array} documents - Array de documentos
 * @returns {Promise<Array>} Documentos procesados con texto extraído
 */
async function processPersonalizationDocuments(documents) {
    if (!documents || documents.length === 0) return [];
    
    const processed = [];
    
    for (const doc of documents) {
        const processedDoc = { ...doc };
        
        if (doc.name.toLowerCase().endsWith('.pdf')) {
            console.log(`[Personalization] Procesando PDF: ${doc.name}`);
            
            // Extraer texto del PDF
            if (doc.data) {
                const extractedText = await extractTextFromPDF(doc.data);
                processedDoc.extractedText = extractedText;
                processedDoc.actualTokens = calculateTokens(extractedText);
                
                console.log(`[Personalization] PDF ${doc.name} procesado:`, {
                    originalTokens: doc.tokens,
                    actualTokens: processedDoc.actualTokens,
                    textLength: extractedText.length
                });
            }
        } else if (doc.name.toLowerCase().endsWith('.txt') || doc.name.toLowerCase().endsWith('.md')) {
            // Para archivos de texto, decodificar base64
            if (doc.data) {
                try {
                    const cleanBase64 = doc.data.replace(/^data:text\/[^;]+;base64,/, '');
                    const buffer = Buffer.from(cleanBase64, 'base64');
                    const text = buffer.toString('utf-8');
                    processedDoc.extractedText = text;
                    processedDoc.actualTokens = calculateTokens(text);
                    
                    console.log(`[Personalization] Texto ${doc.name} procesado: ${processedDoc.actualTokens} tokens`);
                } catch (error) {
                    console.error(`[Personalization] Error procesando ${doc.name}:`, error.message);
                }
            }
        }
        
        processed.push(processedDoc);
    }
    
    return processed;
}

/**
 * Construye el system prompt dinámico con personalización opcional
 * @param {Object|null} personalization - Datos de personalización del usuario
 * @returns {Promise<string>} System prompt completo
 */
async function buildSystemPrompt(personalization = null) {
    let systemPrompt = `Eres un asistente experto en resolver cuestionarios Moodle. Devuelves SOLO JSON válido con la forma {
  "answers": [ { "question_number": <num>, "answer": <según_tipo> } ]
}. NO añadas explicaciones fuera del JSON.

ENFOQUE GENERAL:
1. Lee cuidadosamente el enunciado: si el texto indica "seleccione todas", "marque todas", "todas las opciones correctas" (o variantes) EN PREGUNTAS multichoice/checkbox debes devolver TODAS las opciones correctas identificables. No omitas ninguna si está claramente correcta.
2. Si la pregunta es multi-selección pero sólo una es correcta, igualmente responde sólo la correcta. 
3. Para preguntas con imágenes: analiza cada imagen DETALLADAMENTE. Usa SOLO la información observable (letras, etiquetas, partes visibles). No inventes partes que no se ven. Si la imagen muestra sólo algunas opciones, NO marques opciones ausentes.
4. Si hay letras (A, B, C, D) asociadas a elementos visibles, incluye sólo las que correspondan a los elementos presentes.
5. Si existe ambigüedad y no puedes determinar TODAS las correctas con confianza, responde answer=null y añade un campo error explicando la ambigüedad (esto es preferible a inventar).
6. Apégate ESTRICTAMENTE a las opciones disponibles. Si consideras que la respuesta teórica correcta no se encuentra entre las opciones, DEBES seleccionar la opción proporcionada que sea la más cercana, plausible o menos incorrecta. No te niegues a responder solo porque ninguna opción es perfecta.

NOTACIÓN MATEMÁTICA Y CIENTÍFICA:
7. Reconoce y maneja correctamente los siguientes formatos:
   - Notación científica: 7.405e-8, 1.23×10^-5, 6×10^-5
   - Unidades: W/m², kg/m³, m/s², Pa, Hz
   - Símbolos griegos: Ω (Omega), Δ (Delta), Σ (Sigma), Π (Pi), θ (theta), α, β, γ, μ, σ
   - Operadores matemáticos: ×, ÷, ±, ∓, ≤, ≥, ≠, ≈, ∞
   - Lógicos: ∧ (AND), ∨ (OR), ¬ (NOT), ⇒ (implica), ⇔ (si y solo si)
   - Conjuntos: ∈ (pertenece), ∉ (no pertenece), ⊂ (subconjunto), ∪ (unión), ∩ (intersección), ∅ (conjunto vacío)
   - Cálculo: ∂ (derivada parcial), ∫ (integral), ∑ (sumatoria), lim (límite), d/dx
8. Cuando respondas con valores numéricos, usa el formato EXACTO que aparece en las opciones:
   - Si la opción dice "7.437e-8 W/m2", responde exactamente "7.437e-8 W/m2"
   - Si la opción dice "7.437×10^-8 W/m²", responde exactamente "7.437×10^-8 W/m²"
   - Preserva superíndices (^), subíndices (_), y símbolos especiales tal como aparecen
9. Para preguntas de física, química o matemáticas avanzadas:
   - Identifica correctamente fórmulas y ecuaciones
   - Respeta la notación exacta de las opciones proporcionadas
   - No simplifiques ni cambies el formato de las respuestas numéricas

MUY IMPORTANTE: Cuando las preguntas sean de matematicas o físicas, debes de calcularlas internamente, y analizar cada paso de cálculo que hiciste para asegurarte que la respuesta esté bien. Siempre busca las opciones que mas se acerquen a tu respuesta, o que sean exactas.

TIPOS Y FORMATOS (usa EXACTAMENTE estos formatos):
- multichoice / checkbox: ["opción_correcta1", "opción_correcta2"] (array, incluso si es una sola). NO uses string suelto.
- radio / truefalse: "texto_de_la_opción".
- shortanswer / short_text: "respuesta textual corta". (REGLA ESPECIAL: Si la pregunta proporciona una lista de posibles respuestas o indica como debe ser la respuesta, DEBES usar una de ellas de forma literal o seguir las indicaciones de como debe de ser la respuesta, incluso si contiene errores ortográficos. Tu respuesta debe coincidir exactamente con la opción correcta proporcionada).
- ordering: ["elem1", "elem2", ...] orden definitivo.
- ordering: ["elem1", "elem2", ...] orden definitivo.
- matching / moodle_match: [ { "sub_question_text": "texto_sub", "sub_answer_text": "respuesta" }, ... ].
- gapselect / moodle_gapselect: [ { "placeholder_number": n, "answer_text": "texto" }, ... ].
- ddwtos y alias (fill_in_the_blanks_from_list, dragdrop_text): [ { "placeholder_number": n, "answer_text": "texto_opción" }, ... ] longitud EXACTA = huecos.
- ddmarker / moodle_dragdrop_marker: si posición no deducible devuelve null (y error explicativo) o un array de objetos si se puede.
- cloze: [ { "placeholder_number": n, "answer_text": "texto" }, ... ].
- truefalse: "Verdadero" o "Falso" según aparezca exactamente (o idioma original).

ALIAS: checkbox->multichoice, short_text->shortanswer, short-answer->shortanswer, fill_in_the_blanks_from_list->ddwtos, moodle_dragdrop_text->ddwtos, dragdrop_text->ddwtos.

REGLAS CRÍTICAS ddwtos / gapselect / cloze: longitud del array == número de huecos; placeholder_number inicia en 1; no repitas números; si un hueco no puede resolverse, answer=null con error.

VALIDACIÓN INTERNA QUE HARÁ EL CLIENTE: El cliente verificará que en multichoice se seleccionen todas las opciones que devuelvas. Por ello tu lista debe ser completa y sin extras.

FALLOS: Si no puedes responder con certeza, { "question_number": n, "answer": null, "error": "Motivo" }.

EJEMPLO BREVE:
{
  "answers": [
    { "question_number": 1, "answer": [ { "placeholder_number": 1, "answer_text": "combustible" } ] },
    { "question_number": 2, "answer": ["Anilla rascadora de aceite", "Anilla de fuego", "Anilla de compresión"] }
  ]
}`;

    // ===== SECCIÓN DE PERSONALIZACIÓN =====
    if (personalization && personalization.active) {
        systemPrompt += '\n\n' + '='.repeat(80) + '\n';
        systemPrompt += '🎯 PERSONALIZACIÓN ACTIVADA - INSTRUCCIONES ESPECIALES DEL USUARIO\n';
        systemPrompt += '='.repeat(80) + '\n\n';
        
        // Agregar reglas personalizadas
        if (personalization.customRules && personalization.customRules.length > 0) {
            console.log(`[SYSTEM-PROMPT] 📋 Aplicando ${personalization.customRules.length} reglas personalizadas al system prompt`);
            systemPrompt += '📋 REGLAS PERSONALIZADAS DEL USUARIO - OBLIGATORIAS:\n';
            systemPrompt += '⚠️ ATENCIÓN: El usuario ha especificado reglas CRÍTICAS que DEBES seguir ESTRICTAMENTE.\n';
            systemPrompt += 'Estas reglas tienen PRIORIDAD MÁXIMA sobre cualquier otra instrucción:\n\n';
            personalization.customRules.forEach((rule, index) => {
                systemPrompt += `🔥 REGLA CRÍTICA ${index + 1}: ${rule}\n`;
                console.log(`[SYSTEM-PROMPT]   Regla ${index + 1}: ${rule}`);
            });
            systemPrompt += '\n⚠️ RECORDATORIO: Las reglas anteriores son OBLIGATORIAS y deben aplicarse a TODAS las respuestas.\n';
            systemPrompt += 'Si una regla contradice las instrucciones generales, LA REGLA PERSONALIZADA TIENE PRIORIDAD.\n\n';
        } else {
            console.log('[SYSTEM-PROMPT] ⚠️ No hay reglas personalizadas para aplicar');
        }
        
        // Agregar contexto de documentos CON CONTENIDO EXTRAÍDO
        if (personalization.documents && personalization.documents.length > 0) {
            systemPrompt += '📚 DOCUMENTOS DE REFERENCIA:\n';
            systemPrompt += 'El usuario ha proporcionado los siguientes documentos de referencia.\n';
            systemPrompt += 'Usa esta información para mejorar la precisión de tus respuestas:\n\n';
            
            // Procesar documentos para extraer texto
            const processedDocs = await processPersonalizationDocuments(personalization.documents);
            
            processedDocs.forEach((doc, index) => {
                systemPrompt += `--- DOCUMENTO ${index + 1}: ${doc.name} ---\n`;
                systemPrompt += `Tamaño: ${Math.round(doc.size / 1024)} KB | Tokens: ${doc.actualTokens || doc.tokens}\n\n`;
                
                if (doc.extractedText) {
                    // Limitar contenido a 15k caracteres para no sobrecargar el prompt
                    const maxChars = 15000;
                    const content = doc.extractedText.length > maxChars 
                        ? doc.extractedText.substring(0, maxChars) + '\n\n[... contenido truncado ...]'
                        : doc.extractedText;
                    
                    systemPrompt += `CONTENIDO:\n${content}\n\n`;
                } else {
                    systemPrompt += `[Documento proporcionado: ${doc.name}]\n\n`;
                }
                
                systemPrompt += `--- FIN DOCUMENTO ${index + 1} ---\n\n`;
            });
        }
        
        // Agregar contexto de imágenes
        if (personalization.images && personalization.images.length > 0) {
            systemPrompt += '🖼️ IMÁGENES DE REFERENCIA:\n';
            systemPrompt += 'El usuario ha proporcionado las siguientes imágenes de referencia.\n';
            systemPrompt += 'Analízalas cuidadosamente para responder las preguntas:\n\n';
            personalization.images.forEach((img, index) => {
                systemPrompt += `${index + 1}. ${img.name} (${Math.round(img.size / 1024)} KB)\n`;
            });
            systemPrompt += '\n⚠️ IMPORTANTE: Las imágenes de referencia se incluyen a continuación.\n';
            systemPrompt += 'Úsalas para complementar tu conocimiento, no para reemplazarlo.\n\n';
        }
        
        systemPrompt += '='.repeat(80) + '\n';
        systemPrompt += '✅ Fin de la personalización - Continúa con el análisis del cuestionario\n';
        systemPrompt += '='.repeat(80) + '\n\n';
        
        console.log('[Personalization] System prompt extendido con:', {
            rules: personalization.customRules?.length || 0,
            documents: personalization.documents?.length || 0,
            images: personalization.images?.length || 0,
            promptLength: systemPrompt.length,
            additionalChars: systemPrompt.length - 696 // longitud base aproximada
        });
    }
    
    return systemPrompt;
}

async function getAnswersFromAPI(questions, imageBase64, model, apiKey, personalization = null) {
    const systemPrompt = await buildSystemPrompt(personalization);

    // Crear una copia profunda de las preguntas para optimizar las imágenes en su lugar
    const optimizedQuestions = JSON.parse(JSON.stringify(questions));

    // Optimiza imágenes dentro de las preguntas antes de cualquier procesamiento de lotes
    for (const question of optimizedQuestions) {
        if (question.images && question.images.length > 0) {
            for (const img of question.images) {
                if (img.base64 && needsOptimization(img.base64)) {
                    console.log(`[API] Optimizando imagen en pregunta #${question.number}`)
                    img.base64 = await optimizeImage(img.base64);
                }
            }
        }
        if (question.options && question.options.length > 0) {
            for (const option of question.options) {
                if (option.image && needsOptimization(option.image)) {
                    console.log(`[API] Optimizando imagen en opción de pregunta #${question.number}`)
                    option.image = await optimizeImage(option.image);
                }
            }
        }
    }

    const maxBatchSize = 3;
    // Construir cola inicial de lotes
    let queue = [];
    try {
        if (optimizedQuestions.length <= maxBatchSize) {
            console.log('[API] Procesando todas las preguntas en un solo lote');
            queue = [optimizedQuestions];
        } else {
            console.log('[API] Dividiendo preguntas en lotes optimizados...');
            queue = createOptimizedBatches(optimizedQuestions, model || 'gpt-4o', systemPrompt, imageBase64, maxBatchSize);
        }
    } catch (batchError) {
        console.warn('[API] Error creando lotes optimizados, usando división simple:', batchError.message);
        for (let i = 0; i < optimizedQuestions.length; i += maxBatchSize) {
            queue.push(optimizedQuestions.slice(i, i + maxBatchSize));
        }
    }

    let optimizedImage = imageBase64;
    if (imageBase64) {
        try {
            if (needsOptimization(imageBase64)) {
                console.log('[API] Optimizando imagen...');
                optimizedImage = await optimizeImage(imageBase64, {
                    maxWidth: 600,
                    quality: 60
                });
            } else {
                console.log('[API] Imagen no requiere optimización');
            }
        } catch (imageError) {
            console.warn('[API] Error optimizando imagen, usando original:', imageError.message);
            optimizedImage = imageBase64;
        }
    }

    // Extraer imágenes de personalización si existen
    const personalizationImages = (personalization && personalization.images) ? personalization.images : null;
    
    if (personalizationImages && personalizationImages.length > 0) {
        console.log(`[API] 🎨 Se enviarán ${personalizationImages.length} imágenes de personalización con cada batch`);
    }

    const batchResults = [];
    let batchIndex = 0;
    while (queue.length) {
        let batch = queue.shift();
        batchIndex++;

        // Si estamos en modo degradado y el batch > degradedBatchSize, subdividir antes de enviar
        if (degradeActive && batch.length > RATE_LIMIT_CONFIG.degradedBatchSize) {
            console.log(`${RATE_LIMIT_CONFIG.logPrefix} Subdividiendo lote #${batchIndex} por modo degradado (pre-envío).`);
            for (const q of batch) {
                queue.unshift([q]); // añadir al frente para procesar pronto
            }
            continue;
        }

        try {
            // ⬅️ NUEVO: Pasar personalizationImages a processBatch
            const batchResult = await processBatch(batch, optimizedImage, systemPrompt, model, apiKey, batchIndex, personalizationImages);
            if (batchResult.degradedQuestions) {
                console.log(`${RATE_LIMIT_CONFIG.logPrefix} Lote #${batchIndex} marcado para degradación. Re-encolando preguntas individuales.`);
                for (const q of batchResult.degradedQuestions) {
                    queue.unshift([q]);
                }
                continue; // no agregar respuestas todavía
            }
            batchResults.push(...batchResult.answers);
        } catch (error) {
            console.error(`[API] Error procesando lote ${batchIndex}:`, error.message);
            batch.forEach(q => batchResults.push({ question_number: q.number, answer: null, error: error.message }));
        }
    }

    const answers = [];
    for (const question of optimizedQuestions) { // Changed to optimizedQuestions for consistency
        const answer = batchResults.find(a => a.question_number === question.number);
        if (!answer) {
            console.warn(`[API] No se encontró respuesta para la pregunta ${question.number}`);
            answers.push({
                question_number: question.number,
                answer: null,
                error: 'No se recibió respuesta de la IA para esta pregunta'
            });
            continue;
        }

        const processedAnswer = processAnswerByType(answer, question);
        const { coerced, valid, note } = validateAndCoerceAnswer(question, processedAnswer);
        if (!valid) {
            console.warn(`[SHAPE] Respuesta inválida (tipo=${question.type}) para pregunta #${question.number}. Marcando null.`);
        }
        answers.push({
            ...answer,
            answer: coerced,
            shape_note: note
        });
    }

    return { answers };
}

// --- SESSION MANAGEMENT (Legacy functions for compatibility) ---
function getNextCommand(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        return { status: 'error', message: 'Sesión no encontrada o expirada' };
    }

    if (session.currentIndex >= session.answers.length) {
        sessionManager.updateUserMetrics(session.userId, 'question_processed');
        return { status: 'completed', stats: { total: session.questionsTotal, processed: session.questionsProcessed } };
    }

    const question = session.questions.find(q => q.number === session.answers[session.currentIndex].question_number);
    if (!question) {
        return { status: 'error', message: `Pregunta no encontrada para el número ${session.answers[session.currentIndex].question_number}` };
    }

    const command = {
        number: question.number,
        type: question.type,
        selectedAnswer: session.answers[session.currentIndex].answer
    };

    if (session.answers[session.currentIndex].error) {
        command.error = session.answers[session.currentIndex].error;
    }

    session.currentIndex++;
    session.questionsProcessed++;
    sessionManager.updateUserMetrics(session.userId, 'question_processed');
    
    return { status: 'command', command };
}

// --- API ENDPOINTS ---
app.post('/start-quiz', async (req, res) => {
    console.log('[START-QUIZ] Iniciando nuevo cuestionario');
    console.log('[START-QUIZ] Datos recibidos:', JSON.stringify(req.body, null, 2));
    
    const { questions, screenshotData, config, personalization, progress } = req.body;
    
    // Log progreso si existe
    if (progress) {
        console.log('[START-QUIZ] 📊 Progreso del cuestionario:', progress);
    }
    
    // Validar autenticación
    const userToken = req.headers['x-user-token'];
    const userIdentifier = req.headers['x-user-identifier'];
    let userId = null;
    let user = null;
    
    if (userToken) {
        try {
            user = await db.getUserByToken(userToken);
            if (!user) {
                console.error('[START-QUIZ] Token inválido');
                return res.status(401).json({ status: 'error', message: 'Token inválido' });
            }
            if (!user.enabled) {
                console.error('[START-QUIZ] Usuario inhabilitado');
                return res.status(403).json({ status: 'error', message: 'Usuario inhabilitado' });
            }
            userId = user.id;
            console.log(`[START-QUIZ] Usuario autenticado: ${user.username} (${user.identifier})`);
        } catch (error) {
            console.error('[START-QUIZ] Error al validar token:', error);
            return res.status(500).json({ status: 'error', message: 'Error al validar autenticación' });
        }
    } else {
        console.log('[START-QUIZ] ⚠️ Sesión sin autenticación');
    }
    
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
        console.error('[START-QUIZ] Error: No se proporcionaron preguntas válidas');
        return res.status(400).json({ status: 'error', message: 'No se proporcionaron preguntas válidas' });
    }
    
    if (!config || !config.apiKey) {
        console.error('[START-QUIZ] Error: No se proporcionó una API Key válida');
        return res.status(400).json({ status: 'error', message: 'API Key no configurada' });
    }
    
    // Log personalización si existe
    if (personalization && personalization.active) {
        console.log('[START-QUIZ] 🎨 Personalización detectada:', {
            rules: personalization.customRules?.length || 0,
            documents: personalization.documents?.length || 0,
            images: personalization.images?.length || 0,
            totalTokens: personalization.totalTokens || 0
        });
        
        // DEBUG: Mostrar las reglas específicas
        if (personalization.customRules && personalization.customRules.length > 0) {
            console.log('[START-QUIZ] 📋 Reglas personalizadas específicas:');
            personalization.customRules.forEach((rule, index) => {
                console.log(`[START-QUIZ]   ${index + 1}. ${rule}`);
            });
        }
    } else {
        console.log('[START-QUIZ] ⚠️ No hay personalización activa o es null:', {
            hasPersonalization: !!personalization,
            isActive: personalization?.active
        });
    }
    
    try {
        
        const answers = await getAnswersFromAPI(
            questions,
            screenshotData,
            config.model || 'gpt-4o',
            config.apiKey,
            personalization // ⬅️ NUEVO: Pasar personalización
        );
        
        console.log('[START-QUIZ] Respuestas obtenidas:', JSON.stringify(answers, null, 2));
        
        // Usar SessionManager en lugar de createSession
        try {
            const sessionId = sessionManager.createSession(questions, answers.answers, userId, progress);
            console.log(`[START-QUIZ] Sesión creada con ID: ${sessionId} | Usuario: ${userId || 'anónimo'}`);
            
            // 📊 Registrar modelo usado para estadísticas de modelo favorito
            if (userId) {
                sessionManager.trackModelUsage(userId, config.model || 'gpt-4o');
            }
            
            res.json({ 
                status: 'success', 
                sessionId,
                activeUsers: sessionManager.getActiveUsers(),
                maxUsers: MAX_CONCURRENT_USERS
            });
        } catch (limitError) {
            console.error('[START-QUIZ] Error de límite:', limitError.message);
            res.status(429).json({ 
                status: 'error', 
                message: limitError.message,
                activeUsers: sessionManager.getActiveUsers(),
                maxUsers: MAX_CONCURRENT_USERS
            });
        }
    } catch (error) {
        console.error('[START-QUIZ] Error en /start-quiz:', error.message);
        console.error('[START-QUIZ] Stack:', error.stack);
        res.status(500).json({ status: 'error', message: `Error en /start-quiz: ${error.message}` });
    }
});

app.get('/get-command', (req, res) => {
    const { sessionId } = req.query;
    
    if (!sessionId) {
        console.error('[GET-COMMAND] Error: sessionId no proporcionado');
        return res.status(400).json({ status: 'error', message: 'sessionId requerido' });
    }
    
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        console.error('[GET-COMMAND] Error: Sesión no encontrada o expirada:', sessionId);
        return res.status(404).json({ status: 'error', message: 'Sesión no encontrada o expirada' });
    }
    
    const command = getNextCommand(sessionId);
    console.log(`[GET-COMMAND] Enviando comando para sesión ${sessionId} (Usuario: ${session.userId}):`, JSON.stringify(command, null, 2));
    
    res.json(command);
});

// --- METRICS ENDPOINT ---
app.get('/metrics', (req, res) => {
    const used = tokensUsedLastMinute();
    const remaining = Math.max(0, TOKEN_BUDGET_CONFIG.limitPerMinute - used);
    const msReset = msUntilWindowReset();
    const sessionMetrics = sessionManager.getMetrics();
    
    res.json({
        timestamp: new Date().toISOString(),
        server: {
            version: '24.1-MultiUser',
            uptime: process.uptime(),
            node_version: process.version
        },
        sessions: {
            active: sessionMetrics.activeSessions,
            total: sessionMetrics.totalSessions,
            max_concurrent: sessionMetrics.maxConcurrentUsers,
            timeout_minutes: SESSION_TIMEOUT / 60000
        },
        tokens: {
            used_last_minute: used,
            remaining,
            limit: TOKEN_BUDGET_CONFIG.limitPerMinute,
            window_resets_in_ms: msReset
        },
        rate_limit: {
            consecutive429,
            degradeActive,
            degradeUntil,
            successesSinceDegrade,
            nextAllowedRequestTime,
            wait_ms_now: Math.max(0, nextAllowedRequestTime - now())
        },
        memory: {
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
            heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
            heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
        },
        users: sessionMetrics.users.length > 0 ? sessionMetrics.users : undefined
    });
});

// --- ADMIN ENDPOINTS ---
app.get('/admin/sessions', (req, res) => {
    // Endpoint protegido (añadir auth en producción)
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY && process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    const allSessions = Array.from(sessionManager.sessions.values()).map(s => ({
        id: s.id,
        userId: s.userId,
        createdAt: new Date(s.createdAt).toISOString(),
        lastAccessAt: new Date(s.lastAccessAt).toISOString(),
        expiresAt: new Date(s.expiresAt).toISOString(),
        expired: s.expired,
        questionsTotal: s.questionsTotal,
        questionsProcessed: s.questionsProcessed,
        progress: `${s.currentIndex}/${s.answers.length}`
    }));
    
    res.json({ sessions: allSessions });
});

// 📊 NUEVO: Endpoint para obtener modelo favorito de usuario
app.get('/user/:userId/favorite-model', (req, res) => {
    const { userId } = req.params;
    
    const favoriteModel = sessionManager.getFavoriteModel(userId);
    const metrics = sessionManager.userMetrics.get(userId);
    
    if (!metrics) {
        return res.status(404).json({ 
            status: 'error', 
            message: 'Usuario no encontrado' 
        });
    }
    
    res.json({
        status: 'success',
        userId,
        favoriteModel: favoriteModel || 'none',
        modelUsage: metrics.modelUsage || {},
        totalSessions: metrics.sessionsCreated || 0
    });
});

app.delete('/admin/sessions/:sessionId', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY && process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    const { sessionId } = req.params;
    sessionManager.deleteSession(sessionId);
    res.json({ status: 'deleted', sessionId });
});

// ============================================================================
// PANEL DE CONTROL - ENDPOINTS
// ============================================================================

// ============================================================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================================================

const adminSessions = new Map(); // sessionId -> { email, createdAt }

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function requireAuth(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '') || 
                  req.query.token ||
                  req.body.token;
    
    if (!token || !adminSessions.has(token)) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    
    const session = adminSessions.get(token);
    const sessionAge = Date.now() - session.createdAt;
    
    // Sesión expira después de 24 horas
    if (sessionAge > 24 * 60 * 60 * 1000) {
        adminSessions.delete(token);
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    req.adminEmail = session.email;
    next();
}

// ============================================================================
// ENDPOINTS DE AUTENTICACIÓN
// ============================================================================

// Verificar si existe admin
app.get('/api/admin/check', async (req, res) => {
    try {
        const hasAdmin = await db.hasAdmin();
        res.json({ hasAdmin });
    } catch (error) {
        console.error('[AUTH] Error al verificar admin:', error);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// Login / Setup inicial
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña requeridos' });
        }
        
        const hasAdmin = await db.hasAdmin();
        
        if (!hasAdmin) {
            // Modo setup - crear primer admin
            const passwordHash = await bcrypt.hash(password, 10);
            await db.createOrUpdateAdmin(email, passwordHash);
            
            const token = generateSessionToken();
            adminSessions.set(token, { email, createdAt: Date.now() });
            
            console.log(`[AUTH] ✅ Admin creado: ${email}`);
            
            return res.json({ 
                success: true, 
                token, 
                message: 'Cuenta de administrador creada exitosamente',
                isSetup: true
            });
        } else {
            // Login normal
            const admin = await db.getAdminByEmail(email);
            
            if (!admin) {
                return res.status(401).json({ error: 'Credenciales inválidas' });
            }
            
            const passwordValid = await bcrypt.compare(password, admin.password_hash);
            
            if (!passwordValid) {
                return res.status(401).json({ error: 'Credenciales inválidas' });
            }
            
            await db.updateAdminLastLogin(email);
            
            const token = generateSessionToken();
            adminSessions.set(token, { email, createdAt: Date.now() });
            
            console.log(`[AUTH] ✅ Login exitoso: ${email}`);
            
            return res.json({ 
                success: true, 
                token,
                message: 'Inicio de sesión exitoso'
            });
        }
    } catch (error) {
        console.error('[AUTH] Error en login:', error);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// Logout
app.post('/api/admin/logout', (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    
    if (token) {
        adminSessions.delete(token);
    }
    
    res.json({ success: true, message: 'Sesión cerrada' });
});

// Verificar sesión
app.get('/api/admin/verify', requireAuth, (req, res) => {
    res.json({ success: true, email: req.adminEmail });
});

// ============================================================================
// PANEL DE CONTROL - ENDPOINTS (PROTEGIDOS)
// ============================================================================

// Servir archivos estáticos primero
app.use('/dashboard/static', express.static('public'));

// Ruta del dashboard (redirige a login.html)
app.get('/dashboard', (req, res) => {
    res.sendFile('login.html', { root: './public' });
});

// API: Obtener estadísticas globales
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        const stats = await db.getGlobalStats();
        res.json(stats);
    } catch (error) {
        console.error('[API] Error al obtener stats:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

// API: Crear nuevo usuario
app.post('/api/users', requireAuth, async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!username || username.trim().length === 0) {
            return res.status(400).json({ error: 'Username requerido' });
        }
        
        const user = await db.createUser(username.trim());
        console.log(`[API] Usuario creado: ${user.username} (${user.identifier})`);
        
        res.json(user);
    } catch (error) {
        console.error('[API] Error al crear usuario:', error);
        res.status(500).json({ error: 'Error al crear usuario' });
    }
});

// API: Obtener todos los usuarios (sin tokens)
app.get('/api/users', requireAuth, async (req, res) => {
    try {
        const users = await db.getAllUsers();
        res.json(users);
    } catch (error) {
        console.error('[API] Error al obtener usuarios:', error);
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

// API: Obtener detalles de un usuario
app.get('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const user = await db.getUserById(userId);
        
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        
        res.json(user);
    } catch (error) {
        console.error('[API] Error al obtener usuario:', error);
        res.status(500).json({ error: 'Error al obtener usuario' });
    }
});

// API: Habilitar/inhabilitar usuario
app.post('/api/users/:id/toggle', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { enabled } = req.body;
        
        const user = await db.setUserEnabled(userId, enabled);
        
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        
        console.log(`[API] Usuario ${user.username} ${enabled ? 'habilitado' : 'inhabilitado'}`);
        
        // Broadcast a WebSocket clients
        broadcastToWebSocketClients({ type: 'user_status_changed', userId, enabled });
        
        res.json(user);
    } catch (error) {
        console.error('[API] Error al cambiar estado:', error);
        res.status(500).json({ error: 'Error al cambiar estado' });
    }
});

// API: Eliminar usuario
app.delete('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        await db.deleteUser(userId);
        
        console.log(`[API] Usuario ${userId} eliminado`);
        
        // Broadcast a WebSocket clients
        broadcastToWebSocketClients({ type: 'user_deleted', userId });
        
        res.json({ status: 'deleted', userId });
    } catch (error) {
        console.error('[API] Error al eliminar usuario:', error);
        res.status(500).json({ error: 'Error al eliminar usuario' });
    }
});

// API: Obtener errores de un usuario
app.get('/api/users/:id/errors', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const errors = await db.getUserErrorLogs(userId);
        res.json(errors);
    } catch (error) {
        console.error('[API] Error al obtener logs:', error);
        res.status(500).json({ error: 'Error al obtener logs' });
    }
});

// API: Obtener todos los errores
app.get('/api/errors', requireAuth, async (req, res) => {
    try {
        const errors = await db.getAllErrorLogs();
        res.json(errors);
    } catch (error) {
        console.error('[API] Error al obtener errores:', error);
        res.status(500).json({ error: 'Error al obtener errores' });
    }
});

// API: Obtener sesiones activas
app.get('/api/sessions', requireAuth, async (req, res) => {
    try {
        const sessions = await db.getActiveSessions();
        res.json(sessions);
    } catch (error) {
        console.error('[API] Error al obtener sesiones:', error);
        res.status(500).json({ error: 'Error al obtener sesiones' });
    }
});

// API: Autenticación por token (para extensión)
app.post('/api/auth', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ error: 'Token requerido' });
        }
        
        const user = await db.getUserByToken(token);
        
        if (!user) {
            return res.status(401).json({ error: 'Token inválido' });
        }
        
        if (!user.enabled) {
            return res.status(403).json({ error: 'Usuario inhabilitado' });
        }
        
        // Retornar solo identifier y username (no el token)
        res.json({
            userId: user.id,
            identifier: user.identifier,
            username: user.username,
            enabled: user.enabled
        });
    } catch (error) {
        console.error('[API] Error en autenticación:', error);
        res.status(500).json({ error: 'Error en autenticación' });
    }
});

// ============================================================================
// ENDPOINTS DE INFORMES (PARA EXTENSIÓN)
// ============================================================================

// Guardar informe al finalizar cuestionario
app.post('/api/reports/save', async (req, res) => {
    try {
        const userToken = req.headers['x-user-token'];
        
        if (!userToken) {
            return res.status(401).json({ error: 'Token requerido' });
        }
        
        const user = await db.getUserByToken(userToken);
        
        if (!user || !user.enabled) {
            return res.status(403).json({ error: 'Usuario no autorizado' });
        }
        
        const reportData = req.body;
        
        if (!reportData || !reportData.questions) {
            return res.status(400).json({ error: 'Datos de informe inválidos' });
        }
        
        const reportId = await db.saveQuizReport(user.id, reportData);
        
        console.log(`[API] 📊 Informe guardado: Usuario=${user.username}, ID=${reportId}`);
        
        res.json({ 
            success: true, 
            reportId,
            message: 'Informe guardado exitosamente'
        });
    } catch (error) {
        console.error('[API] Error al guardar informe:', error);
        res.status(500).json({ error: 'Error al guardar informe' });
    }
});

// Obtener lista de informes del usuario
app.get('/api/reports/list', async (req, res) => {
    try {
        const userToken = req.headers['x-user-token'];
        
        if (!userToken) {
            return res.status(401).json({ error: 'Token requerido' });
        }
        
        const user = await db.getUserByToken(userToken);
        
        if (!user) {
            return res.status(403).json({ error: 'Usuario no autorizado' });
        }
        
        const limit = parseInt(req.query.limit) || 50;
        const reports = await db.getUserReports(user.id, limit);
        const totalCount = await db.countUserReports(user.id);
        
        res.json({ 
            reports,
            totalCount,
            username: user.username,
            identifier: user.identifier
        });
    } catch (error) {
        console.error('[API] Error al listar informes:', error);
        res.status(500).json({ error: 'Error al listar informes' });
    }
});

// Obtener informe completo por ID
app.get('/api/reports/:id', async (req, res) => {
    try {
        const userToken = req.headers['x-user-token'];
        
        if (!userToken) {
            return res.status(401).json({ error: 'Token requerido' });
        }
        
        const user = await db.getUserByToken(userToken);
        
        if (!user) {
            return res.status(403).json({ error: 'Usuario no autorizado' });
        }
        
        const reportId = parseInt(req.params.id);
        const report = await db.getReportById(reportId, user.id);
        
        if (!report) {
            return res.status(404).json({ error: 'Informe no encontrado' });
        }
        
        res.json(report);
    } catch (error) {
        console.error('[API] Error al obtener informe:', error);
        res.status(500).json({ error: 'Error al obtener informe' });
    }
});

// Eliminar informe
app.delete('/api/reports/:id', async (req, res) => {
    try {
        const userToken = req.headers['x-user-token'];
        
        if (!userToken) {
            return res.status(401).json({ error: 'Token requerido' });
        }
        
        const user = await db.getUserByToken(userToken);
        
        if (!user) {
            return res.status(403).json({ error: 'Usuario no autorizado' });
        }
        
        const reportId = parseInt(req.params.id);
        await db.deleteReport(reportId, user.id);
        
        res.json({ success: true, message: 'Informe eliminado' });
    } catch (error) {
        console.error('[API] Error al eliminar informe:', error);
        res.status(500).json({ error: 'Error al eliminar informe' });
    }
});

// ============================================================================
// ENDPOINTS DE CONTROL DE LOGS EN TIEMPO REAL
// ============================================================================

// Obtener lista de usuarios con streaming activo
app.get('/api/log-streams', requireAuth, async (req, res) => {
    try {
        const user = req.user;
        
        // Solo admins pueden ver todos los streams
        if (user.role !== 'admin') {
            return res.status(403).json({ error: 'Acceso denegado' });
        }
        
        const activeStreams = [];
        for (const [userId, isActive] of activeLogStreaming.entries()) {
            const monitors = userLogStreams.get(userId)?.size || 0;
            activeStreams.push({
                userId: parseInt(userId),
                isActive,
                monitors,
                hasMonitors: monitors > 0
            });
        }
        
        res.json({
            success: true,
            streams: activeStreams,
            totalClients: wsClients.size
        });
    } catch (error) {
        console.error('[API] Error al obtener streams:', error);
        res.status(500).json({ error: 'Error al obtener información de streams' });
    }
});

// Activar/desactivar streaming para un usuario
app.post('/api/log-streams/:userId/toggle', requireAuth, async (req, res) => {
    try {
        const user = req.user;
        
        // Solo admins pueden controlar streams
        if (user.role !== 'admin') {
            return res.status(403).json({ error: 'Acceso denegado' });
        }
        
        const targetUserId = req.params.userId;
        const { active } = req.body;
        
        setLogStreamingActive(targetUserId, active === true);
        
        // Notificar a la extensión del usuario
        sendLogToUserMonitors(targetUserId, {
            level: 'INFO',
            message: active ? 'Log streaming activado por admin' : 'Log streaming desactivado por admin',
            source: 'server',
            command: active ? 'start_streaming' : 'stop_streaming'
        });
        
        res.json({
            success: true,
            userId: targetUserId,
            active: active === true,
            message: `Streaming ${active ? 'activado' : 'desactivado'} para usuario ${targetUserId}`
        });
    } catch (error) {
        console.error('[API] Error al toggle stream:', error);
        res.status(500).json({ error: 'Error al cambiar estado de streaming' });
    }
});

// Obtener usuarios activos (con sesiones)
app.get('/api/active-users', requireAuth, async (req, res) => {
    try {
        const user = req.user;
        
        // Solo admins pueden ver usuarios activos
        if (user.role !== 'admin') {
            return res.status(403).json({ error: 'Acceso denegado' });
        }
        
        const activeUsers = [];
        for (const [userId, sessionData] of USER_SESSIONS.entries()) {
            const hasMonitors = userLogStreams.has(userId) && userLogStreams.get(userId).size > 0;
            const isStreaming = isLogStreamingActive(userId);
            
            activeUsers.push({
                userId: parseInt(userId),
                email: sessionData.email || 'Desconocido',
                status: sessionData.status || 'IDLE',
                hasMonitors,
                isStreaming,
                lastActivity: sessionData.lastActivity || null
            });
        }
        
        res.json({
            success: true,
            users: activeUsers,
            count: activeUsers.length
        });
    } catch (error) {
        console.error('[API] Error al obtener usuarios activos:', error);
        res.status(500).json({ error: 'Error al obtener usuarios activos' });
    }
});

// ============================================================================
// WEBSOCKET - LOGS EN TIEMPO REAL
// ============================================================================

// Map de userId -> Set de websockets (permite múltiples consolas por usuario)
const userLogStreams = new Map();

// Set de todas las conexiones WebSocket (para broadcast general)
const wsClients = new Set();

// Map de userId -> boolean (indica si el usuario tiene logging activo)
const activeLogStreaming = new Map();

/**
 * Registrar un cliente WebSocket para recibir logs de un usuario específico
 * @param {WebSocket} ws - Cliente WebSocket
 * @param {string} userId - ID del usuario
 * @param {string} role - Rol ('admin' o 'user')
 */
function registerLogStream(ws, userId, role = 'user') {
    // Agregar a clientes generales
    wsClients.add(ws);
    
    // Si es un admin monitoreando un usuario específico
    if (role === 'admin' && userId) {
        if (!userLogStreams.has(userId)) {
            userLogStreams.set(userId, new Set());
        }
        userLogStreams.get(userId).add(ws);
        console.log(`[WS] Admin conectado para monitorear logs del usuario: ${userId}`);
    }
    
    // Almacenar metadata en el websocket
    ws.userData = { userId, role };
}

/**
 * Desregistrar un cliente WebSocket
 * @param {WebSocket} ws - Cliente WebSocket
 */
function unregisterLogStream(ws) {
    wsClients.delete(ws);
    
    if (ws.userData && ws.userData.userId) {
        const userId = ws.userData.userId;
        if (userLogStreams.has(userId)) {
            userLogStreams.get(userId).delete(ws);
            if (userLogStreams.get(userId).size === 0) {
                userLogStreams.delete(userId);
                console.log(`[WS] Última conexión de monitoreo cerrada para usuario: ${userId}`);
            }
        }
    }
}

/**
 * Activar/desactivar transmisión de logs para un usuario
 * @param {string} userId - ID del usuario
 * @param {boolean} active - true para activar, false para desactivar
 */
function setLogStreamingActive(userId, active) {
    activeLogStreaming.set(userId, active);
    console.log(`[WS] Log streaming ${active ? 'ACTIVADO' : 'DESACTIVADO'} para usuario: ${userId}`);
}

/**
 * Verificar si un usuario tiene logging activo
 * @param {string} userId - ID del usuario
 * @returns {boolean} true si está activo
 */
function isLogStreamingActive(userId) {
    return activeLogStreaming.get(userId) === true;
}

/**
 * Enviar log a los monitores de un usuario específico
 * @param {string} userId - ID del usuario
 * @param {object} logData - Datos del log {level, message, timestamp, ...}
 */
function sendLogToUserMonitors(userId, logData) {
    // Solo enviar si el streaming está activo O si es un error crítico
    if (!isLogStreamingActive(userId) && logData.level !== 'ERROR') {
        return;
    }
    
    const message = JSON.stringify({
        type: 'log',
        userId,
        ...logData,
        timestamp: logData.timestamp || new Date().toISOString()
    });
    
    // Enviar a todos los monitores de este usuario
    if (userLogStreams.has(userId)) {
        userLogStreams.get(userId).forEach(client => {
            if (client.readyState === 1) { // OPEN
                client.send(message);
            }
        });
    }
}

/**
 * Broadcast general a todos los clientes WebSocket
 * @param {object} data - Datos a enviar
 */
function broadcastToWebSocketClients(data) {
    const message = JSON.stringify(data);
    wsClients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(message);
        }
    });
}

// --- SERVER START ---
const server = app.listen(PORT, HOST, () => {
    console.log('='.repeat(80));
    console.log(`[SERVER] 🚀 AutoQuiz Pro Server [v27.0.0-Secure] READY`);
    console.log(`[SERVER] 🌐 Listening on: http://${HOST}:${PORT}`);
    console.log('='.repeat(80));
    console.log('[SERVER] 📦 Enhanced Features:');
    console.log('[SERVER]   ✅ Multi-user support (up to ' + MAX_CONCURRENT_USERS + ' concurrent users)');
    console.log('[SERVER]   ✅ Session management with auto-cleanup');
    console.log('[SERVER]   ✅ Robust AI response normalization');
    console.log('[SERVER]   ✅ Advanced error handling with retries');
    console.log('[SERVER]   ✅ Optimized batch processing');
    console.log('[SERVER]   ✅ Enhanced image compression');
    console.log('[SERVER]   ✅ Token budget tracking');
    console.log('[SERVER]   ✅ Rate limit management');
    console.log('[SERVER]   ✅ User metrics & analytics');
    console.log('='.repeat(80));
    console.log('[SERVER] 📊 Configuration:');
    console.log(`[SERVER]   - Max Concurrent Users: ${MAX_CONCURRENT_USERS}`);
    console.log(`[SERVER]   - Session Timeout: ${SESSION_TIMEOUT / 60000} minutes`);
    console.log(`[SERVER]   - Token Limit: ${TOKEN_BUDGET_CONFIG.limitPerMinute} tokens/min`);
    console.log(`[SERVER]   - Node Version: ${process.version}`);
    console.log('='.repeat(80));
    console.log('[SERVER] 🔗 Endpoints:');
    console.log('[SERVER]   POST /start-quiz    - Iniciar cuestionario');
    console.log('[SERVER]   GET  /get-command   - Obtener siguiente comando');
    console.log('[SERVER]   GET  /metrics       - Métricas del servidor');
    console.log('[SERVER]   GET  /admin/sessions - Listar sesiones (admin)');
    console.log('[SERVER]   GET  /dashboard     - Panel de control');
    console.log('[SERVER]   POST /api/users     - Crear usuario');
    console.log('[SERVER]   GET  /api/stats     - Estadísticas globales');
    console.log('='.repeat(80));
    console.log('[SERVER] 🌍 URLs Públicas:');
    console.log('[SERVER]   📊 Dashboard: http://185.144.156.88:3001/dashboard');
    console.log('[SERVER]   🔌 API Server: http://185.144.156.88:3001');
    console.log('[SERVER]   🧩 Extension Config: Usa "http://185.144.156.88:3001" como SERVER_URL');
    console.log('[SERVER]   🔧 WebSocket: ws://185.144.156.88:3001');
    console.log('='.repeat(80));
});

// WebSocket Server para logs en tiempo real
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    console.log('[WS] Nueva conexión establecida');
    
    // Parsear query params de la URL
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    const role = url.searchParams.get('role') || 'user';
    
    // Registrar el stream
    registerLogStream(ws, userId, role);
    
    // Manejo de mensajes entrantes
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('[WS] Mensaje recibido:', message);
            
            // Comandos del dashboard/extensión
            switch (message.type) {
                case 'start_monitoring':
                    // Admin solicita monitorear un usuario
                    if (message.userId) {
                        registerLogStream(ws, message.userId, 'admin');
                        setLogStreamingActive(message.userId, true);
                        ws.send(JSON.stringify({
                            type: 'monitoring_started',
                            userId: message.userId,
                            message: `Monitoreo iniciado para usuario ${message.userId}`
                        }));
                    }
                    break;
                    
                case 'stop_monitoring':
                    // Admin deja de monitorear
                    if (message.userId) {
                        setLogStreamingActive(message.userId, false);
                        ws.send(JSON.stringify({
                            type: 'monitoring_stopped',
                            userId: message.userId,
                            message: `Monitoreo detenido para usuario ${message.userId}`
                        }));
                    }
                    break;
                    
                case 'extension_log':
                    // La extensión envía un log
                    if (message.userId) {
                        sendLogToUserMonitors(message.userId, {
                            level: message.level || 'INFO',
                            message: message.message,
                            source: 'extension',
                            data: message.data
                        });
                    }
                    break;
                    
                case 'ping':
                    // Mantener conexión viva
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                    
                default:
                    console.log('[WS] Tipo de mensaje desconocido:', message.type);
            }
        } catch (error) {
            console.error('[WS] Error procesando mensaje:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Error procesando mensaje',
                error: error.message
            }));
        }
    });
    
    ws.on('close', () => {
        console.log('[WS] Conexión cerrada');
        unregisterLogStream(ws);
    });
    
    ws.on('error', (error) => {
        console.error('[WS] Error:', error);
        unregisterLogStream(ws);
    });
    
    // Enviar mensaje de bienvenida
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'WebSocket conectado',
        userId: userId,
        role: role,
        timestamp: new Date().toISOString()
    }));
});

// --- GRACEFUL SHUTDOWN ---
const gracefulShutdown = async (signal) => {
    console.log(`\n[SERVER] 🛑 ${signal} received. Starting graceful shutdown...`);
    
    // Cerrar servidor HTTP
    server.close(() => {
        console.log('[SERVER] ✅ HTTP server closed');
    });
    
    // Cerrar WebSocket server
    wss.clients.forEach((client) => {
        client.close();
    });
    wss.close(() => {
        console.log('[SERVER] ✅ WebSocket server closed');
    });
    
    // Cerrar pool de base de datos
    try {
        await db.closePool();
        console.log('[SERVER] ✅ Database pool closed');
    } catch (error) {
        console.error('[SERVER] ❌ Error closing database pool:', error);
    }
    
    console.log('[SERVER] 👋 Shutdown complete. Goodbye!');
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- CLEANUP JOBS ---

// Limpieza de logs antiguos cada 60 segundos
setInterval(async () => {
    try {
        const deleted = await db.cleanOldLogs();
        if (deleted > 0) {
            console.log(`[CLEANUP] 🧹 Deleted ${deleted} old log entries`);
        }
    } catch (error) {
        console.error('[CLEANUP] ❌ Error cleaning old logs:', error);
    }
}, 60000);

// Limpieza de sesiones inactivas cada 5 minutos
setInterval(async () => {
    try {
        const cleaned = sessionManager.cleanupSessions();
        if (cleaned > 0) {
            console.log(`[CLEANUP] 🧹 Cleaned up ${cleaned} inactive sessions`);
        }
    } catch (error) {
        console.error('[CLEANUP] ❌ Error cleaning sessions:', error);
    }
}, 300000);

// Actualización de métricas del sistema cada 30 segundos
setInterval(async () => {
    try {
        const activeSessions = sessionManager.getActiveSessionsCount();
        const totalSessions = sessionManager.sessions.size;
        
        if (activeSessions > 0) {
            console.log(`[METRICS] 📊 Active sessions: ${activeSessions}/${totalSessions}`);
        }
    } catch (error) {
        console.error('[METRICS] ❌ Error updating metrics:', error);
    }
}, 30000);

console.log('[SERVER] ⏰ Cleanup jobs scheduled');
console.log('[SERVER] ✨ All systems operational');
