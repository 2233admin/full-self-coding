import { execFileSync } from 'child_process'
import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join, extname, relative, basename } from 'path'
import { createHash } from 'crypto'

import { ChunkStore } from './store.js'
import { embedBatch } from './embedder.js'
import { parseFile } from './parser.js'
import { retrieve, type RetrievedChunk } from './retriever.js'

// ==================== Constants ====================

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
  '.c': 'c',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.vue': 'vue',
  '.svelte': 'svelte',
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv',
  'venv', '.next', '.nuxt', 'target', 'vendor', '.tox', 'coverage',
  '.idea', '.vscode', 'bin', 'obj',
])

// ==================== Config ====================

export interface CodeRAGv2Config {
  pgDsn?: string
  ollamaBase?: string
  maxFilesPerRepo?: number   // default 500
  githubToken?: string
}

// ==================== Walk ====================

function walkRepo(repoPath: string, maxFiles: number): string[] {
  const files: string[] = []

  function walk(dir: string): void {
    if (files.length >= maxFiles) return
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (entry.isFile()) {
        const ext = extname(entry.name)
        if (LANG_MAP[ext]) files.push(full)
      }
    }
  }

  walk(repoPath)
  return files
}

// ==================== Git hash helper ====================

function getFileGitHash(repoPath: string, filePath: string): string {
  try {
    const relPath = relative(repoPath, filePath)
    const hash = execFileSync(
      'git',
      ['-C', repoPath, 'log', '-1', '--format=%H', '--', relPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (hash) return hash
  } catch {
    // not a git repo or file not tracked
  }
  // fallback: md5 of content
  const content = readFileSync(filePath, 'utf8')
  return createHash('md5').update(content).digest('hex')
}

// ==================== CodeRAGv2 ====================

export class CodeRAGv2 {
  private store: ChunkStore
  private maxFilesPerRepo: number

  constructor(private config: CodeRAGv2Config = {}) {
    this.store = new ChunkStore(config.pgDsn)
    this.maxFilesPerRepo = config.maxFilesPerRepo ?? 500
  }

  async init(): Promise<void> {
    await this.store.ensureSchema()
  }

  // Index local repo, return repoId
  async indexLocal(repoPath: string): Promise<string> {
    const dir = repoPath.replace(/\\/g, '/')
    const dirName = basename(dir)
    const hash8 = createHash('md5').update(dir).digest('hex').slice(0, 8)
    const repoId = `local/${dirName}-${hash8}`

    const files = walkRepo(repoPath, this.maxFilesPerRepo)

    for (const filePath of files) {
      const relPath = relative(repoPath, filePath).replace(/\\/g, '/')
      const gitHash = getFileGitHash(repoPath, filePath)

      // Incremental: skip unchanged files
      const storedHash = await this.store.getGitHash(repoId, relPath)
      if (storedHash === gitHash) continue

      const content = readFileSync(filePath, 'utf8')
      const ext = extname(filePath)
      const language = LANG_MAP[ext] ?? 'text'

      const chunks = parseFile(relPath, content, language)
      if (chunks.length === 0) continue

      const embeddings = await embedBatch(chunks.map(c => c.content))

      await this.store.upsertChunks(
        chunks.map((chunk, i) => ({
          repoId,
          filePath: relPath,
          language,
          chunkType: chunk.chunkType,
          name: chunk.name,
          content: chunk.content,
          embedding: embeddings[i],
          gitHash,
        }))
      )
    }

    return repoId
  }

  // Search GitHub repos, clone locally, index each. Returns repoIds.
  async indexGitHub(searchQuery: string, ragDir = '/tmp/coderag-repos'): Promise<string[]> {
    const token = this.config.githubToken ?? process.env['GITHUB_TOKEN'] ?? ''
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
    }
    if (token) headers['Authorization'] = `token ${token}`

    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=stars&per_page=5`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`GitHub search failed [${res.status}]`)

    const data = (await res.json()) as { items: Array<{ full_name: string; clone_url: string }> }
    const repoIds: string[] = []

    for (const repo of data.items) {
      const repoDir = join(ragDir, repo.full_name.replace('/', '_'))
      if (!existsSync(repoDir)) {
        const env = token
          ? {
              ...process.env,
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'http.extraHeader',
              GIT_CONFIG_VALUE_0: `Authorization: token ${token}`,
            }
          : process.env
        execFileSync('git', ['clone', '--depth', '1', repo.clone_url, repoDir], {
          stdio: 'ignore',
          env,
        })
      } else {
        execFileSync('git', ['-C', repoDir, 'pull', '--ff-only'], {
          stdio: 'ignore',
        })
      }
      const repoId = await this.indexLocal(repoDir)
      repoIds.push(repoId)
    }

    return repoIds
  }

  // Main query interface — returns formatted prompt fragment
  async getReferenceContext(
    taskDescription: string,
    repoIds: string[] = [],
    topK = 8,
  ): Promise<string> {
    const results = await retrieve(this.store, taskDescription, repoIds, topK)
    return this.formatResults(results)
  }

  private formatResults(results: RetrievedChunk[]): string {
    if (results.length === 0) return ''

    const lines: string[] = ['## Reference Code\n']
    for (const r of results) {
      const tag = r.source === 'both' ? '★' : r.source === 'vec' ? 'v' : 'k'
      lines.push(`### [${tag}] ${r.repoId} — ${r.filePath}`)
      lines.push(`**${r.chunkType}** \`${r.name}\``)
      lines.push('')
      lines.push('```')
      lines.push(r.content)
      lines.push('```')
      lines.push('')
    }

    return lines.join('\n')
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}
