// answerShape.js
// Funciones reutilizables para validación y coerción de respuestas por tipo de pregunta

export function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return str;
  const trimmed = str.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + '…' : trimmed;
}

export function coerceArrayStrings(arr, maxLenEach = 300) {
  if (!Array.isArray(arr)) return arr;
  return arr
    .map(v => sanitizeString(String(v), maxLenEach))
    .filter(v => v.length > 0);
}

// Valida y fuerza la forma de la respuesta normalizada según el tipo.
// Devuelve { coerced, valid, note }
export function validateAndCoerceAnswer(question, processedAnswer) {
  const typeRaw = (question.type || 'unknown').toLowerCase();
  const aliasMap = {
    'checkbox': 'multichoice',
    'short_text': 'shortanswer',
    'short-answer': 'shortanswer',
    'fill_in_the_blanks_from_list': 'ddwtos',
    'moodle_dragdrop_text': 'ddwtos',
    'dragdrop_text': 'ddwtos'
  };
  const type = aliasMap[typeRaw] || typeRaw;
  let coerced = processedAnswer;
  let valid = true;
  let note = undefined;

  switch (type) {
    case 'multichoice':
      if (typeof coerced === 'string') {
        coerced = [sanitizeString(coerced)];
        note = 'coerced_string_to_array';
      }
      if (!Array.isArray(coerced)) { valid = false; }
      else { coerced = coerceArrayStrings(coerced); }
      break;
    case 'radio':
    case 'truefalse':
    case 'shortanswer':
      if (Array.isArray(coerced)) { coerced = coerced[0]; note = 'took_first_array_item'; }
      if (typeof coerced !== 'string') { valid = false; }
      else coerced = sanitizeString(coerced, 400);
      break;
    case 'ordering':
      if (!Array.isArray(coerced)) valid = false; else coerced = coerceArrayStrings(coerced);
      break;
    case 'matching':
    case 'moodle_match':
      if (!Array.isArray(coerced)) valid = false;
      break;
    case 'gapselect':
    case 'moodle_gapselect':
    case 'ddwtos':
      if (!Array.isArray(coerced)) valid = false; else {
        const expected = Array.isArray(question.placeholders) ? question.placeholders.length : (Array.isArray(question.gaps)? question.gaps.length : null);
        if (expected && coerced.length !== expected) {
          note = 'length_mismatch';
          valid = false;
        }
      }
      break;
    case 'ddmarker':
      if (!Array.isArray(coerced)) valid = false;
      break;
    case 'cloze':
      if (Array.isArray(coerced)) {
        coerced = coerced.map((o, idx) => {
          if (typeof o === 'string') {
            return { placeholder_number: idx + 1, answer_text: sanitizeString(o, 200) };
          }
            if (o && typeof o === 'object') {
              return {
                placeholder_number: o.placeholder_number || o.number || (idx + 1),
                answer_text: sanitizeString(o.answer_text || o.answer || '', 200)
              };
            }
            return { placeholder_number: idx + 1, answer_text: '' };
        });
        const expected = Array.isArray(question.placeholders) ? question.placeholders.length : null;
        if (expected && coerced.length !== expected) {
          note = 'length_mismatch';
          valid = false;
        }
      } else if (typeof coerced === 'object' && coerced && coerced.answers && Array.isArray(coerced.answers)) {
        coerced = coerced.answers; // ya normalizado afuera
      } else {
        valid = false;
      }
      break;
    default:
      // Desconocido: permitir valores tal cual (cliente decidirá)
      break;
  }

  if (!valid) {
    note = note || 'invalid_shape';
    coerced = null;
  }
  return { coerced, valid, note };
}
