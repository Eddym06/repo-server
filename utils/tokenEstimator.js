/**
 * @file tokenEstimator.js
 * @description Utilidad para estimar tokens antes de enviar a OpenAI API
 * 
 * Funcionalidades:
 * - Estimar tokens de texto usando gpt-3-encoder
 * - Estimar tokens de imágenes basado en resolución
 * - Calcular límites de lote dinámicamente
 * - Validar tamaños de payload antes del envío
 */

import { encode } from 'gpt-3-encoder';
import { estimateImageSize } from './imageOptimizer.js';

// Límites de tokens para diferentes modelos de OpenAI y Gemini
const MODEL_LIMITS = {
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4': 8192,
    'gpt-4-32k': 32768,
    'gpt-3.5-turbo': 4096,
    'gpt-3.5-turbo-16k': 16384,
    // Gemini models (verificados 27-10-2025)
    'gemini-2.5-flash': 1048576,                    // 1M tokens ✅
    'gemini-2.5-flash-preview-05-20': 1048576,      // 1M tokens ✅
    'gemini-2.0-flash': 1048576,                    // 1M tokens ✅
    'gemini-2.0-flash-exp': 1048576,                // 1M tokens ✅
    // Legacy names
    'gemini-2.5-flash-latest': 1048576,
    'gemini-2.5-pro-latest': 2097152
};

// Reservar tokens para la respuesta y overhead del sistema
const RESPONSE_BUFFER = 2000;
const SYSTEM_OVERHEAD = 1000;

/**
 * Estima el número de tokens en un texto
 * @param {string} text - Texto a analizar
 * @returns {number} - Número estimado de tokens
 */
export function estimateTextTokens(text) {
    if (!text || typeof text !== 'string') {
        return 0;
    }
    
    try {
        return encode(text).length;
    } catch (error) {
        console.warn('[TOKEN_EST] Error estimando tokens, usando aproximación:', error.message);
        // Fallback: aproximadamente 4 caracteres por token
        return Math.ceil(text.length / 4);
    }
}

/**
 * Estima tokens para una imagen basado en su resolución y tamaño
 * @param {string} base64Image - Imagen en formato base64
 * @returns {number} - Número estimado de tokens
 */
export function estimateImageTokens(base64Image) {
    if (!base64Image) {
        return 0;
    }
    
    // Para imágenes, OpenAI usa un cálculo basado en resolución
    // Estimación: imagen típica optimizada ~1000-2000 tokens
    const imageSizeKB = estimateImageSize(base64Image) / 1024;
    
    // Estimación basada en el tamaño: más grande = más tokens
    let estimatedTokens;
    if (imageSizeKB < 100) {
        estimatedTokens = 500;
    } else if (imageSizeKB < 200) {
        estimatedTokens = 1000;
    } else if (imageSizeKB < 400) {
        estimatedTokens = 1500;
    } else {
        estimatedTokens = 2000;
    }
    
    console.log(`[TOKEN_EST] Imagen ${imageSizeKB.toFixed(1)}KB → ~${estimatedTokens} tokens`);
    return estimatedTokens;
}

/**
 * Estima el total de tokens para un payload de OpenAI
 * @param {string} systemPrompt - Prompt del sistema
 * @param {Array} questions - Array de preguntas
 * @param {string} imageBase64 - Imagen en base64 (opcional)
 * @returns {number} - Total de tokens estimados
 */
export function estimatePayloadTokens(systemPrompt, questions, imageBase64) {
    let totalTokens = 0;
    
    // Tokens del sistema
    const systemTokens = estimateTextTokens(systemPrompt);
    totalTokens += systemTokens;
    
    // Tokens de las preguntas
    const questionsText = JSON.stringify(questions);
    const questionsTokens = estimateTextTokens(questionsText);
    totalTokens += questionsTokens;
    
    // Tokens de la imagen (si existe)
    if (imageBase64) {
        const imageTokens = estimateImageTokens(imageBase64);
        totalTokens += imageTokens;
    }
    
    // Overhead del sistema
    totalTokens += SYSTEM_OVERHEAD;
    
    console.log(`[TOKEN_EST] Breakdown: Sistema(${systemTokens}) + Preguntas(${questionsTokens}) + Imagen(${imageBase64 ? estimateImageTokens(imageBase64) : 0}) + Overhead(${SYSTEM_OVERHEAD}) = ${totalTokens} tokens`);
    
    return totalTokens;
}

/**
 * Calcula el tamaño máximo de lote basado en límites de tokens
 * @param {string} model - Modelo de OpenAI a usar
 * @param {string} systemPrompt - Prompt del sistema
 * @param {Array} sampleQuestions - Muestra de preguntas para estimar tamaño promedio
 * @param {string} imageBase64 - Imagen en base64
 * @param {number} maxBatchSize - Tamaño máximo de lote (por defecto 6)
 * @returns {number} - Tamaño de lote recomendado
 */
export function calculateOptimalBatchSize(model, systemPrompt, sampleQuestions, imageBase64, maxBatchSize = 6) {
    const modelLimit = MODEL_LIMITS[model] || MODEL_LIMITS['gpt-4o'];
    const availableTokens = modelLimit - RESPONSE_BUFFER;
    
    console.log(`[TOKEN_EST] Modelo: ${model}, Límite: ${modelLimit}, Disponible: ${availableTokens}`);
    
    // Calcular tokens base (sistema + imagen + overhead)
    const baseTokens = estimateTextTokens(systemPrompt) + 
                      (imageBase64 ? estimateImageTokens(imageBase64) : 0) + 
                      SYSTEM_OVERHEAD;
    
    if (baseTokens >= availableTokens) {
        throw new Error(`Los tokens base (${baseTokens}) exceden el límite disponible (${availableTokens}). Considere optimizar la imagen o el prompt.`);
    }
    
    // Calcular tokens promedio por pregunta
    const avgTokensPerQuestion = sampleQuestions.length > 0 
        ? estimateTextTokens(JSON.stringify(sampleQuestions)) / sampleQuestions.length
        : 100; // Estimación conservadora
    
    console.log(`[TOKEN_EST] Tokens promedio por pregunta: ${avgTokensPerQuestion.toFixed(1)}`);
    
    // Calcular cuántas preguntas caben
    const tokensForQuestions = availableTokens - baseTokens;
    const maxQuestionsbyTokens = Math.floor(tokensForQuestions / avgTokensPerQuestion);
    
    // El tamaño de lote es el menor entre el límite de tokens y el máximo configurado
    const optimalBatchSize = Math.min(maxQuestionsbyTokens, maxBatchSize);
    
    console.log(`[TOKEN_EST] Lote óptimo: ${optimalBatchSize} preguntas (límite por tokens: ${maxQuestionsbyTokens}, máximo configurado: ${maxBatchSize})`);
    
    if (optimalBatchSize <= 0) {
        throw new Error(`No es posible procesar preguntas dentro del límite de tokens. Tokens base: ${baseTokens}, disponibles: ${availableTokens}`);
    }
    
    return optimalBatchSize;
}

/**
 * Valida si un lote específico cabe dentro de los límites de tokens
 * @param {string} model - Modelo de OpenAI
 * @param {string} systemPrompt - Prompt del sistema
 * @param {Array} questionBatch - Lote de preguntas
 * @param {string} imageBase64 - Imagen en base64
 * @returns {boolean} - true si el lote es válido
 */
export function validateBatch(model, systemPrompt, questionBatch, imageBase64) {
    const modelLimit = MODEL_LIMITS[model] || MODEL_LIMITS['gpt-4o'];
    const availableTokens = modelLimit - RESPONSE_BUFFER;
    
    const totalTokens = estimatePayloadTokens(systemPrompt, questionBatch, imageBase64);
    
    const isValid = totalTokens <= availableTokens;
    
    if (!isValid) {
        console.warn(`[TOKEN_EST] Lote inválido: ${totalTokens} tokens > ${availableTokens} disponibles`);
    }
    
    return isValid;
}

/**
 * Divide un array de preguntas en lotes optimizados
 * @param {Array} questions - Array completo de preguntas
 * @param {string} model - Modelo de OpenAI
 * @param {string} systemPrompt - Prompt del sistema
 * @param {string} imageBase64 - Imagen en base64
 * @param {number} maxBatchSize - Tamaño máximo de lote
 * @returns {Array} - Array de lotes de preguntas
 */
export function createOptimizedBatches(questions, model, systemPrompt, imageBase64, maxBatchSize = 6) {
    if (!questions || questions.length === 0) {
        return [];
    }
    
    // Calcular tamaño óptimo de lote
    const sampleSize = Math.min(3, questions.length);
    const sampleQuestions = questions.slice(0, sampleSize);
    
    const optimalBatchSize = calculateOptimalBatchSize(
        model, 
        systemPrompt, 
        sampleQuestions, 
        imageBase64, 
        maxBatchSize
    );
    
    // Dividir preguntas en lotes
    const batches = [];
    for (let i = 0; i < questions.length; i += optimalBatchSize) {
        const batch = questions.slice(i, i + optimalBatchSize);
        
        // Validar cada lote
        if (validateBatch(model, systemPrompt, batch, imageBase64)) {
            batches.push(batch);
        } else {
            // Si el lote es demasiado grande, dividirlo más
            console.warn(`[TOKEN_EST] Lote demasiado grande, dividiéndolo más...`);
            const smallerBatchSize = Math.max(1, Math.floor(optimalBatchSize / 2));
            
            for (let j = 0; j < batch.length; j += smallerBatchSize) {
                const smallerBatch = batch.slice(j, j + smallerBatchSize);
                batches.push(smallerBatch);
            }
        }
    }
    
    console.log(`[TOKEN_EST] Creados ${batches.length} lotes para ${questions.length} preguntas`);
    return batches;
}