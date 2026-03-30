const OLLAMA_BASE = 'http://localhost:11434'
const EMBED_MODEL = 'qwen3-embedding:0.6b'
const BATCH_SIZE = 32

interface OllamaEmbedResponse {
  embeddings: number[][]
}

export async function embedText(text: string): Promise<number[]> {
  const [result] = await embedBatch([text])
  return result!
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  const results: number[][] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Ollama embed failed [${res.status}]: ${body}`)
    }

    const data = (await res.json()) as OllamaEmbedResponse
    results.push(...data.embeddings)
  }

  return results
}
