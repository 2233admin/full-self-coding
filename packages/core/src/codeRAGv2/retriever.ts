import type { ChunkStore, SearchResult, BM25Result } from './store.js'
import { embedText } from './embedder.js'

// ==================== Types ====================

export interface RetrievedChunk {
  repoId: string
  filePath: string
  chunkType: string
  name: string
  content: string
  score: number       // RRF score
  source: 'vec' | 'bm25' | 'both'
}

interface RRFItem {
  id: bigint
  score: number
  source: 'vec' | 'bm25' | 'both'
}

// ==================== RRF ====================

// score(d) = Σ 1/(k + rank_i(d)), k=60
// rank is 1-based (position in sorted list)
function rrf(
  vecResults: SearchResult[],
  bm25Results: BM25Result[],
  k = 60,
): RRFItem[] {
  const scores = new Map<bigint, RRFItem>()

  for (let i = 0; i < vecResults.length; i++) {
    const id = vecResults[i]!.id
    const contribution = 1 / (k + i + 1)
    const existing = scores.get(id)
    if (existing) {
      existing.score += contribution
      existing.source = 'both'
    } else {
      scores.set(id, { id, score: contribution, source: 'vec' })
    }
  }

  for (let i = 0; i < bm25Results.length; i++) {
    const id = bm25Results[i]!.id
    const contribution = 1 / (k + i + 1)
    const existing = scores.get(id)
    if (existing) {
      existing.score += contribution
      existing.source = 'both'
    } else {
      scores.set(id, { id, score: contribution, source: 'bm25' })
    }
  }

  return [...scores.values()].sort((a, b) => b.score - a.score)
}

// ==================== Retrieve ====================

export async function retrieve(
  store: ChunkStore,
  query: string,
  repoIds: string[],   // empty = all repos
  topK = 8,
): Promise<RetrievedChunk[]> {
  const CANDIDATE_K = 20

  const [embedding, bm25Raw] = await Promise.all([
    embedText(query),
    store.bm25Search(query, repoIds, CANDIDATE_K),
  ])

  const vecRaw = await store.vectorSearch(embedding, repoIds, CANDIDATE_K)

  const ranked = rrf(vecRaw, bm25Raw)

  // Build lookup map from both result sets
  const byId = new Map<bigint, SearchResult | BM25Result>()
  for (const r of vecRaw) byId.set(r.id, r)
  for (const r of bm25Raw) byId.set(r.id, r)

  const out: RetrievedChunk[] = []
  for (const item of ranked.slice(0, topK)) {
    const row = byId.get(item.id)
    if (!row) continue
    out.push({
      repoId: row.repoId,
      filePath: row.filePath,
      chunkType: row.chunkType,
      name: row.name,
      content: row.content,
      score: item.score,
      source: item.source,
    })
  }

  return out
}
