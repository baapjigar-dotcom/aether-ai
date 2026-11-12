/**
 * NovaOS AI — local document retrieval engine.
 * This is lexical retrieval (BM25 + phrase boosts), NOT a neural embedding model.
 * Plug a real embedding provider into the same ingest/search boundary when desired.
 */
const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','been','being','but','by','can','could','did','do','does',
  'for','from','had','has','have','how','i','in','into','is','it','its','may','might','more','of',
  'on','or','our','should','that','the','their','them','there','these','this','those','to','was',
  'were','what','when','where','which','who','why','will','with','would','you','your'
]);

function tokenize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
}

function splitLongText(text, maxChars, overlapChars) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    if (word.length > maxChars) {
      if (current) chunks.push(current);
      current = '';
      for (let i = 0; i < word.length; i += maxChars - overlapChars) {
        chunks.push(word.slice(i, i + maxChars));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      chunks.push(current);
      const tail = current.slice(-overlapChars).replace(/^\S*\s?/, '').trim();
      current = tail ? `${tail} ${word}` : word;
    } else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

function chunkText(rawText, maxChars = 1000, overlapChars = 160) {
  const paragraphs = String(rawText || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const units = [];
  for (const paragraph of paragraphs.length ? paragraphs : [String(rawText || '').trim()]) {
    if (!paragraph) continue;
    if (paragraph.length <= maxChars) {
      units.push(paragraph);
      continue;
    }
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];
    for (const sentence of sentences) {
      const unit = sentence.trim();
      if (unit.length <= maxChars) units.push(unit);
      else units.push(...splitLongText(unit, maxChars, overlapChars));
    }
  }

  const packed = [];
  let current = '';
  for (const unit of units) {
    const next = current ? `${current}\n${unit}` : unit;
    if (next.length <= maxChars) current = next;
    else {
      if (current) packed.push(current);
      const overlap = current.slice(-overlapChars).replace(/^\S*\s?/, '').trim();
      current = overlap ? `${overlap}\n${unit}` : unit;
      if (current.length > maxChars) {
        packed.push(...splitLongText(current, maxChars, overlapChars));
        current = '';
      }
    }
  }
  if (current) packed.push(current);
  return packed.length ? packed : (String(rawText || '').trim() ? [String(rawText).trim().slice(0, maxChars)] : []);
}

export class RagEngine {
  constructor(options = {}) {
    this.documents = [];
    this.maxChunkChars = options.maxChunkChars || 1000;
    this.overlapChars = options.overlapChars || 160;
  }

  // Kept as a compatibility method for existing callers; this is a sparse lexical vector.
  computeEmbedding(text) {
    const vector = Object.create(null);
    for (const token of tokenize(text)) {
      if (!STOP_WORDS.has(token)) vector[token] = (vector[token] || 0) + 1;
    }
    return vector;
  }

  cosineSimilarity(a, b) {
    if (!a || !b) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (const [term, value] of Object.entries(a)) {
      normA += value * value;
      if (b[term]) dot += value * b[term];
    }
    for (const value of Object.values(b)) normB += value * value;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }

  ingestDocument(fileName, rawText) {
    const chunkTexts = chunkText(rawText, this.maxChunkChars, this.overlapChars);
    const chunks = chunkTexts.map((text, index) => ({
      chunkId: `${fileName}#chunk-${index + 1}`,
      fileName,
      chunkIndex: index + 1,
      text,
      terms: tokenize(text).filter((term) => !STOP_WORDS.has(term))
    }));
    const docEntry = {
      id: `DOC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fileName,
      chunkCount: chunks.length,
      chunks
    };
    this.documents = this.documents.filter((doc) => doc.fileName !== fileName);
    this.documents.push(docEntry);
    return docEntry;
  }

  loadDocuments(documents) {
    this.documents = Array.isArray(documents) ? documents.filter((doc) => doc && typeof doc.fileName === 'string' && Array.isArray(doc.chunks)) : [];
    for (const doc of this.documents) {
      for (const chunk of doc.chunks) {
        if (!Array.isArray(chunk.terms)) chunk.terms = tokenize(chunk.text).filter((term) => !STOP_WORDS.has(term));
      }
    }
  }

  searchRelevantChunks(query, topK = 3) {
    const queryTerms = [...new Set(tokenize(query).filter((term) => !STOP_WORDS.has(term)))];
    if (!queryTerms.length) return [];
    const chunks = this.documents.flatMap((doc) => doc.chunks);
    if (!chunks.length) return [];

    const documentFrequency = new Map();
    for (const chunk of chunks) {
      for (const term of new Set(chunk.terms || [])) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
    const averageLength = chunks.reduce((sum, chunk) => sum + (chunk.terms || []).length, 0) / chunks.length || 1;
    const k1 = 1.5, b = 0.75;
    const queryPhrase = queryTerms.join(' ');

    return chunks.map((chunk) => {
      const terms = chunk.terms || [];
      const frequencies = new Map();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
      let score = 0;
      for (const term of queryTerms) {
        const tf = frequencies.get(term) || 0;
        if (!tf) continue;
        const df = documentFrequency.get(term) || 0;
        const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
        const denominator = tf + k1 * (1 - b + b * terms.length / averageLength);
        score += idf * (tf * (k1 + 1)) / denominator;
      }
      const normalizedText = terms.join(' ');
      if (queryPhrase.length > 5 && normalizedText.includes(queryPhrase)) score += 1.5;
      const matched = queryTerms.filter((term) => frequencies.has(term)).length;
      if (matched === queryTerms.length && matched > 1) score *= 1.15;
      return { ...chunk, score, matchedTerms: matched };
    }).filter((item) => item.score > 0 && item.matchedTerms > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, Number(topK) || 3)));
  }
}
