/**
 * @file imageOptimizer.js
 * @description Utilidad para optimizar imágenes antes de enviarlas a la API de OpenAI
 * 
 * Funcionalidades:
 * - Redimensionar imágenes a un ancho máximo de 800px
 * - Convertir a formato JPEG con calidad del 70%
 * - Soporte para entrada en Buffer y base64
 * - Preservar aspect ratio durante el redimensionado
 */

import sharp from 'sharp';

/**
 * Optimiza una imagen para reducir su tamaño antes de enviarla a la API
 * @param {string|Buffer} imageInput - Imagen en formato base64 o Buffer
 * @param {Object} options - Opciones de optimización
 * @param {number} options.maxWidth - Ancho máximo en píxeles (por defecto 800)
 * @param {number} options.quality - Calidad JPEG de 1-100 (por defecto 70)
 * @returns {Promise<string>} - Imagen optimizada en formato base64
 */
export async function optimizeImage(imageInput, options = {}) {
    const { maxWidth = 800, quality = 70 } = options;
    
    try {
        let imageBuffer;
        
        // Convertir entrada a Buffer si es base64
        if (typeof imageInput === 'string') {
            // Remover el prefijo data:image/...;base64, si existe
            const base64Data = imageInput.replace(/^data:image\/[a-zA-Z]*;base64,/, '');
            imageBuffer = Buffer.from(base64Data, 'base64');
        } else if (Buffer.isBuffer(imageInput)) {
            imageBuffer = imageInput;
        } else {
            throw new Error('Formato de imagen no soportado. Use Buffer o string base64.');
        }
        
        // Obtener metadatos para verificar el tamaño actual
        const metadata = await sharp(imageBuffer).metadata();
        console.log(`[IMAGE_OPT] Imagen original: ${metadata.width}x${metadata.height}, formato: ${metadata.format}`);
        
        // Solo redimensionar si la imagen es más ancha que el máximo
        let sharpInstance = sharp(imageBuffer);
        
        if (metadata.width > maxWidth) {
            sharpInstance = sharpInstance.resize({
                width: maxWidth,
                height: undefined, // Mantener aspect ratio
                fit: 'inside',
                withoutEnlargement: true
            });
        }
        
        // Convertir a JPEG con la calidad especificada
        const optimizedBuffer = await sharpInstance
            .jpeg({ quality, progressive: true })
            .toBuffer();
        
        // Convertir de vuelta a base64 con el prefijo apropiado
        const optimizedBase64 = `data:image/jpeg;base64,${optimizedBuffer.toString('base64')}`;
        
        // Calcular la reducción de tamaño
        const originalSize = imageBuffer.length;
        const optimizedSize = optimizedBuffer.length;
        const reduction = ((originalSize - optimizedSize) / originalSize * 100).toFixed(1);
        
        console.log(`[IMAGE_OPT] Optimización completada:`);
        console.log(`[IMAGE_OPT] - Tamaño original: ${(originalSize / 1024).toFixed(1)} KB`);
        console.log(`[IMAGE_OPT] - Tamaño optimizado: ${(optimizedSize / 1024).toFixed(1)} KB`);
        console.log(`[IMAGE_OPT] - Reducción: ${reduction}%`);
        
        return optimizedBase64;
        
    } catch (error) {
        console.error('[IMAGE_OPT] Error optimizando imagen:', error.message);
        throw new Error(`Error en optimización de imagen: ${error.message}`);
    }
}

/**
 * Estima el tamaño en bytes que ocupará una imagen base64 en el payload JSON
 * @param {string} base64Image - Imagen en formato base64 
 * @returns {number} - Tamaño estimado en bytes
 */
export function estimateImageSize(base64Image) {
    if (typeof base64Image !== 'string') {
        return 0;
    }
    
    // Remover el prefijo data:image/...;base64, si existe
    const base64Data = base64Image.replace(/^data:image\/[a-zA-Z]*;base64,/, '');
    
    // Cada carácter base64 representa 6 bits, entonces 4 caracteres = 3 bytes
    // Agregar overhead del JSON y estructura
    const estimatedBytes = (base64Data.length * 3) / 4;
    
    return Math.ceil(estimatedBytes);
}

/**
 * Verifica si una imagen necesita optimización basada en su tamaño
 * @param {string} base64Image - Imagen en formato base64
 * @param {number} maxSizeKB - Tamaño máximo en KB (por defecto 500KB)
 * @returns {boolean} - true si necesita optimización
 */
export function needsOptimization(base64Image, maxSizeKB = 500) {
    const sizeBytes = estimateImageSize(base64Image);
    const sizeKB = sizeBytes / 1024;
    
    console.log(`[IMAGE_OPT] Tamaño de imagen: ${sizeKB.toFixed(1)} KB (límite: ${maxSizeKB} KB)`);
    
    return sizeKB > maxSizeKB;
}