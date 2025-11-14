import sharp from 'sharp';
import { encoding_for_model } from '@dqbd/tiktoken';

export async function optimizeImage(base64Data, options = {}) {
    console.log('[IMAGE-OPTIMIZER] Starting image optimization...');
    
    const defaultOptions = {
        maxWidth: 600,
        maxHeight: 600,
        quality: 60,
        format: 'jpeg'
    };
    
    const config = { ...defaultOptions, ...options };
    
    try {
        const base64String = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
        const buffer = Buffer.from(base64String, 'base64');
        
        console.log('[IMAGE-OPTIMIZER] Original image size:', buffer.length, 'bytes');
        
        let image = sharp(buffer);
        
        const metadata = await image.metadata();
        console.log('[IMAGE-OPTIMIZER] Image metadata:', {
            width: metadata.width,
            height: metadata.height,
            format: metadata.format
        });
        
        if (metadata.width > config.maxWidth || metadata.height > config.maxHeight) {
            image = image.resize({
                width: config.maxWidth,
                height: config.maxHeight,
                fit: 'inside',
                withoutEnlargement: true
            });
            console.log('[IMAGE-OPTIMIZER] Resizing image to max dimensions:', {
                width: config.maxWidth,
                height: config.maxHeight
            });
        }
        
        image = image.toFormat(config.format, { quality: config.quality });
        
        const optimizedBuffer = await image.toBuffer();
        const optimizedBase64 = `data:image/${config.format};base64,${optimizedBuffer.toString('base64')}`;
        
        console.log('[IMAGE-OPTIMIZER] Optimized image size:', optimizedBuffer.length, 'bytes');
        console.log('[IMAGE-OPTIMIZER] Optimization completed successfully');
        
        return optimizedBase64;
    } catch (error) {
        console.error('[IMAGE-OPTIMIZER] Error optimizing image:', error.message);
        console.error('[IMAGE-OPTIMIZER] Stack:', error.stack);
        throw new Error(`Failed to optimize image: ${error.message}`);
    }
}

export function needsOptimization(base64Data) {
    try {
        const base64String = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
        const buffer = Buffer.from(base64String, 'base64');
        
        // Optimize if image is larger than 100KB
        return buffer.length > 100000;
    } catch (error) {
        console.warn('[IMAGE-OPTIMIZER] Error checking optimization need:', error.message);
        return true; // Default to optimizing if there's an error
    }
}

export function estimatePayloadTokens(systemPrompt, questions, imageBase64, model = 'gpt-4o') {
    console.log('[TOKEN-ESTIMATOR] Estimating tokens for payload...');
    
    try {
        const encoder = encoding_for_model(model);
        
        const systemPromptTokens = encoder.encode(systemPrompt).length;
        console.log('[TOKEN-ESTIMATOR] System prompt tokens:', systemPromptTokens);
        
        const questionsText = JSON.stringify(questions);
        const questionsTokens = encoder.encode(questionsText).length;
        console.log('[TOKEN-ESTIMATOR] Questions tokens:', questionsTokens);
        
        let imageTokens = 0;
        if (imageBase64) {
            const base64String = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
            imageTokens = Math.ceil(base64String.length / 750);
            console.log('[TOKEN-ESTIMATOR] Image tokens (approximated):', imageTokens);
        }
        
        const overheadTokens = 50; 
        const totalTokens = systemPromptTokens + questionsTokens + imageTokens + overheadTokens;
        
        console.log('[TOKEN-ESTIMATOR] Total estimated tokens:', totalTokens);
        return totalTokens;
    } catch (error) {
        console.error('[TOKEN-ESTIMATOR] Error estimating tokens:', error.message);
        console.error('[TOKEN-ESTIMATOR] Stack:', error.stack);
        return 1000; 
    }
}

export function createOptimizedBatches(questions, model, systemPrompt, imageBase64, maxBatchSize = 3) {
    console.log('[BATCH-OPTIMIZER] Creating optimized batches...');
    
    try {
        const batches = [];
        let currentBatch = [];
        let currentBatchTokens = 0;
        const maxTokens = 3500; 
        
        for (const question of questions) {
            const questionTokens = estimatePayloadTokens(systemPrompt, [question], imageBase64, model);
            
            if (currentBatch.length >= maxBatchSize || currentBatchTokens + questionTokens > maxTokens) {
                if (currentBatch.length > 0) {
                    batches.push(currentBatch);
                    console.log('[BATCH-OPTIMIZER] Created batch with', currentBatch.length, 'questions, tokens:', currentBatchTokens);
                }
                currentBatch = [];
                currentBatchTokens = 0;
            }
            
            currentBatch.push(question);
            currentBatchTokens += questionTokens;
        }
        
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
            console.log('[BATCH-OPTIMIZER] Created final batch with', currentBatch.length, 'questions, tokens:', currentBatchTokens);
        }
        
        console.log('[BATCH-OPTIMIZER] Total batches created:', batches.length);
        return batches;
    } catch (error) {
        console.error('[BATCH-OPTIMIZER] Error creating batches:', error.message);
        console.error('[BATCH-OPTIMIZER] Stack:', error.stack);
        const fallbackBatches = [];
        for (let i = 0; i < questions.length; i += maxBatchSize) {
            fallbackBatches.push(questions.slice(i, i + maxBatchSize));
        }
        console.warn('[BATCH-OPTIMIZER] Using fallback batching:', fallbackBatches.length, 'batches');
        return fallbackBatches;
    }
}