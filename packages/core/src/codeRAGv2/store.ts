import pg from 'pg'

const { Pool } = pg

export interface StoredChunk {
  repoId: string
  filePath: string
  language: string
  chunkType: 'function' | 'class' | 'file_header'
  name: string
  content: string
  embedding?: number[]
  gitHash?: string
}

export interface SearchResult {
  id: bigint
  repoId: string
  filePath: string
  chunkType: string
  name: string
  content: string
  score: number
}

export interface BM25Result {
  id: bigint
  repoId: string
  filePath: string
  chunkType: string
  name: string
  content: string
  rank: number
}

export class ChunkStore {
  private pool: pg.Pool

  constructor(private pgDsn = 'postgresql://postgres:postgres@localhost:5432/postgres') {
    this.pool = new Pool({ connectionString: pgDsn })
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS coderag_chunks (
        id          BIGSERIAL PRIMARY KEY,
        repo_id     TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        language    TEXT NOT NULL,
        chunk_type  TEXT NOT NULL,
        name        TEXT NOT NULL,
        content     TEXT NOT NULL,
        embedding   vector(1536),
        ts_content  TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
        git_hash    TEXT,
        indexed_at  BIGINT NOT NULL DEFAULT extract(epoch from now())::BIGINT,
        CONSTRAINT coderag_chunks_uq UNIQUE (repo_id, file_path, name, chunk_type)
      )
    `)
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS coderag_vec_idx ON coderag_chunks
        USING hnsw (embedding vector_cosine_ops)
    `)
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS coderag_fts_idx ON coderag_chunks USING GIN (ts_content)
    `)
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS coderag_repo_idx ON coderag_chunks (repo_id, file_path)
    `)
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const chunk of chunks) {
        const embeddingVal = chunk.embedding ? `[${chunk.embedding.join(',')}]` : null
        await client.query(
          `INSERT INTO coderag_chunks
             (repo_id, file_path, language, chunk_type, name, content, embedding, git_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
           ON CONFLICT (repo_id, file_path, name, chunk_type) DO UPDATE SET
             language   = EXCLUDED.language,
             content    = EXCLUDED.content,
             embedding  = EXCLUDED.embedding,
             git_hash   = EXCLUDED.git_hash,
             indexed_at = extract(epoch from now())::BIGINT`,
          [
            chunk.repoId,
            chunk.filePath,
            chunk.language,
            chunk.chunkType,
            chunk.name,
            chunk.content,
            embeddingVal,
            chunk.gitHash ?? null,
          ]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async deleteRepo(repoId: string): Promise<void> {
    await this.pool.query('DELETE FROM coderag_chunks WHERE repo_id = $1', [repoId])
  }

  async getGitHash(repoId: string, filePath: string): Promise<string | null> {
    const res = await this.pool.query<{ git_hash: string | null }>(
      'SELECT git_hash FROM coderag_chunks WHERE repo_id = $1 AND file_path = $2 LIMIT 1',
      [repoId, filePath]
    )
    return res.rows[0]?.git_hash ?? null
  }

  async updateEmbeddings(updates: Array<{ id: bigint; embedding: number[] }>): Promise<void> {
    if (updates.length === 0) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const { id, embedding } of updates) {
        await client.query(
          `UPDATE coderag_chunks SET embedding = $1::vector WHERE id = $2`,
          [`[${embedding.join(',')}]`, id]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async vectorSearch(
    embedding: number[],
    repoIds: string[],
    topK: number
  ): Promise<SearchResult[]> {
    const vec = `[${embedding.join(',')}]`
    const res = await this.pool.query<{
      id: string
      repo_id: string
      file_path: string
      chunk_type: string
      name: string
      content: string
      score: number
    }>(
      `SELECT id, repo_id, file_path, chunk_type, name, content,
              1 - (embedding <=> $1::vector) AS score
       FROM coderag_chunks
       WHERE embedding IS NOT NULL
         AND ($2::text[] IS NULL OR repo_id = ANY($2::text[]))
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [vec, repoIds.length > 0 ? repoIds : null, topK]
    )
    return res.rows.map(r => ({
      id: BigInt(r.id),
      repoId: r.repo_id,
      filePath: r.file_path,
      chunkType: r.chunk_type,
      name: r.name,
      content: r.content,
      score: Number(r.score),
    }))
  }

  async bm25Search(
    query: string,
    repoIds: string[],
    topK: number
  ): Promise<BM25Result[]> {
    const res = await this.pool.query<{
      id: string
      repo_id: string
      file_path: string
      chunk_type: string
      name: string
      content: string
      rank: number
    }>(
      `SELECT id, repo_id, file_path, chunk_type, name, content,
              ts_rank(ts_content, websearch_to_tsquery('english', $1)) AS rank
       FROM coderag_chunks
       WHERE ts_content @@ websearch_to_tsquery('english', $1)
         AND ($2::text[] IS NULL OR repo_id = ANY($2::text[]))
       ORDER BY rank DESC
       LIMIT $3`,
      [query, repoIds.length > 0 ? repoIds : null, topK]
    )
    return res.rows.map(r => ({
      id: BigInt(r.id),
      repoId: r.repo_id,
      filePath: r.file_path,
      chunkType: r.chunk_type,
      name: r.name,
      content: r.content,
      rank: Number(r.rank),
    }))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
