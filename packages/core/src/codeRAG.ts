/**
 * CodeRAG — Reference-Augmented Code Generation for FSC
 *
 * 从 DeepCode 移植的核心思路，适配 FSC 的 Docker Agent 架构：
 * 1. 根据任务描述搜索 GitHub 相关仓库
 * 2. Clone 并用轻量级方式索引（AST提取，非LLM）
 * 3. 生成 JSON 索引文件
 * 4. Task 执行时按文件/关键词查询参考代码
 * 5. 注入 taskSolverPrompt 作为上下文
 *
 * 与 DeepCode 的区别：
 * - 不依赖 MCP，纯 TS 实现
 * - 索引阶段不调 LLM（成本控制），用启发式正则提取
 * - 支持并行索引多个 repo
 * - 索引结果可复用（持久化到 .fsc-rag/）
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join, basename, extname, relative } from 'path';

// ==================== Types ====================

export interface FileReference {
  filePath: string;
  language: string;
  exports: string[];
  imports: string[];
  functions: string[];
  classes: string[];
  lineCount: number;
  summary: string;
}

export interface RepoIndex {
  repoName: string;
  repoUrl: string;
  totalFiles: number;
  files: FileReference[];
  indexedAt: number;
}

export interface RAGQueryResult {
  repoName: string;
  filePath: string;
  relevanceScore: number;
  language: string;
  exports: string[];
  functions: string[];
  classes: string[];
  summary: string;
}

export interface CodeRAGConfig {
  /** 存储索引和 clone 的根目录 */
  ragDir: string;
  /** 最大搜索结果数 */
  maxSearchResults: number;
  /** 最大索引文件数（每个 repo） */
  maxFilesPerRepo: number;
  /** 查询时返回的最大参考数 */
  maxReferences: number;
  /** GitHub token（可选，提高 API 限额） */
  githubToken?: string;
}

const DEFAULT_RAG_CONFIG: CodeRAGConfig = {
  ragDir: '.fsc-rag',
  maxSearchResults: 5,
  maxFilesPerRepo: 200,
  maxReferences: 8,
};

// ==================== Language Detection ====================

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
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv',
  'venv', '.next', '.nuxt', 'target', 'vendor', '.tox', 'coverage',
  '.idea', '.vscode', 'bin', 'obj',
]);

// ==================== Core Class ====================

export class CodeRAG {
  private config: CodeRAGConfig;
  private indexes: Map<string, RepoIndex> = new Map();

  constructor(config: Partial<CodeRAGConfig> = {}) {
    this.config = { ...DEFAULT_RAG_CONFIG, ...config };
    this.ensureDirs();
    this.loadExistingIndexes();
  }

  private ensureDirs(): void {
    const dirs = [
      this.config.ragDir,
      join(this.config.ragDir, 'repos'),
      join(this.config.ragDir, 'indexes'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  private loadExistingIndexes(): void {
    const indexDir = join(this.config.ragDir, 'indexes');
    if (!existsSync(indexDir)) return;

    for (const file of readdirSync(indexDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(indexDir, file), 'utf-8')) as RepoIndex;
        this.indexes.set(data.repoName, data);
      } catch { /* skip corrupt indexes */ }
    }
  }

  // ==================== 1. Search GitHub ====================

  async searchRepos(query: string): Promise<Array<{ name: string; url: string; stars: number; description: string }>> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'FSC-CodeRAG',
    };
    if (this.config.githubToken) {
      headers['Authorization'] = `Bearer ${this.config.githubToken}`;
    }

    const encoded = encodeURIComponent(query);
    const url = `https://api.github.com/search/repositories?q=${encoded}&sort=stars&per_page=${this.config.maxSearchResults}`;

    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        console.warn(`GitHub search failed: ${resp.status} ${resp.statusText}`);
        return [];
      }
      const data = await resp.json() as { items: Array<{ full_name: string; clone_url: string; stargazers_count: number; description: string | null }> };
      return (data.items || []).map(item => ({
        name: item.full_name,
        url: item.clone_url,
        stars: item.stargazers_count,
        description: item.description || '',
      }));
    } catch (err) {
      console.warn(`GitHub search error: ${err}`);
      return [];
    }
  }

  // ==================== 2. Clone Repo ====================

  cloneRepo(repoUrl: string, repoName: string): string {
    const safeName = repoName.replace(/\//g, '__');
    const repoDir = join(this.config.ragDir, 'repos', safeName);

    if (existsSync(repoDir)) {
      console.log(`[CodeRAG] Repo already cloned: ${safeName}`);
      return repoDir;
    }

    console.log(`[CodeRAG] Cloning ${repoUrl} → ${repoDir}`);
    try {
      execFileSync('git', ['clone', '--depth', '1', '--single-branch', repoUrl, repoDir], {
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err) {
      console.error(`[CodeRAG] Clone failed: ${err}`);
      if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
      throw new Error(`Failed to clone ${repoUrl}`);
    }

    return repoDir;
  }

  // ==================== 3. Index Repo ====================

  indexRepo(repoDir: string, repoName: string, repoUrl: string): RepoIndex {
    const cached = this.indexes.get(repoName);
    if (cached) {
      console.log(`[CodeRAG] Using cached index for ${repoName}`);
      return cached;
    }

    console.log(`[CodeRAG] Indexing ${repoName}...`);
    const files: FileReference[] = [];
    this.walkDir(repoDir, repoDir, files);

    const index: RepoIndex = {
      repoName,
      repoUrl,
      totalFiles: files.length,
      files: files.slice(0, this.config.maxFilesPerRepo),
      indexedAt: Date.now(),
    };

    const safeName = repoName.replace(/\//g, '__');
    const indexPath = join(this.config.ragDir, 'indexes', `${safeName}.json`);
    writeFileSync(indexPath, JSON.stringify(index, null, 2));

    this.indexes.set(repoName, index);
    console.log(`[CodeRAG] Indexed ${files.length} files from ${repoName}`);
    return index;
  }

  private walkDir(baseDir: string, currentDir: string, results: FileReference[]): void {
    if (results.length >= this.config.maxFilesPerRepo) return;

    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= this.config.maxFilesPerRepo) return;

      const fullPath = join(currentDir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry) && !entry.startsWith('.')) {
          this.walkDir(baseDir, fullPath, results);
        }
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        const lang = LANG_MAP[ext];
        if (!lang) continue;
        if (stat.size > 100_000) continue;

        try {
          const content = readFileSync(fullPath, 'utf-8');
          const ref = this.extractFileReference(relative(baseDir, fullPath), content, lang);
          if (ref.functions.length > 0 || ref.classes.length > 0 || ref.exports.length > 0) {
            results.push(ref);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  private extractFileReference(filePath: string, content: string, language: string): FileReference {
    const lines = content.split('\n');
    const lineCount = lines.length;

    const functions: string[] = [];
    const classes: string[] = [];
    const exports: string[] = [];
    const imports: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Imports
      if (/^import\s/.test(trimmed) || /^from\s/.test(trimmed) || /^require\(/.test(trimmed)) {
        imports.push(trimmed.slice(0, 100));
        continue;
      }

      // Exports
      if (/^export\s/.test(trimmed)) {
        const match = trimmed.match(/^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/);
        if (match) exports.push(match[1]);
      }

      // Functions
      const fnPatterns = [
        /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
        /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
        /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
        /^def\s+(\w+)\s*\(/,
        /^func\s+(\w+)\s*\(/,
        /^fn\s+(\w+)\s*[<(]/,
        /^(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?\w+\s+(\w+)\s*\(/,
      ];
      for (const pat of fnPatterns) {
        const match = trimmed.match(pat);
        if (match && match[1] && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(match[1])) {
          functions.push(match[1]);
          break;
        }
      }

      // Classes
      const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) classes.push(classMatch[1]);

      const pyClassMatch = trimmed.match(/^class\s+(\w+)/);
      if (pyClassMatch && !classMatch) classes.push(pyClassMatch[1]);
    }

    const summaryLines = lines
      .filter(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('#') && !l.trim().startsWith('*'))
      .slice(0, 5)
      .join(' ')
      .slice(0, 200);

    return {
      filePath,
      language,
      exports: [...new Set(exports)],
      imports: imports.slice(0, 20),
      functions: [...new Set(functions)],
      classes: [...new Set(classes)],
      lineCount,
      summary: summaryLines,
    };
  }

  // ==================== 4. Query ====================

  query(taskDescription: string, targetFile?: string): RAGQueryResult[] {
    const keywords = this.extractKeywords(taskDescription);
    const allResults: RAGQueryResult[] = [];

    for (const [, index] of this.indexes) {
      for (const file of index.files) {
        const score = this.calculateRelevance(file, keywords, targetFile);
        if (score > 0.1) {
          allResults.push({
            repoName: index.repoName,
            filePath: file.filePath,
            relevanceScore: score,
            language: file.language,
            exports: file.exports,
            functions: file.functions,
            classes: file.classes,
            summary: file.summary,
          });
        }
      }
    }

    return allResults
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, this.config.maxReferences);
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'must',
      'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at', 'by',
      'for', 'with', 'about', 'to', 'from', 'in', 'on', 'of', 'that',
      'this', 'it', 'its', 'not', 'no', 'so', 'as', 'into', 'also',
      'please', 'add', 'create', 'implement', 'make', 'update', 'fix',
      'change', 'modify', 'write', 'build', 'ensure', 'use', 'using',
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  private calculateRelevance(file: FileReference, keywords: string[], targetFile?: string): number {
    let score = 0;

    if (targetFile) {
      const targetName = basename(targetFile, extname(targetFile)).toLowerCase();
      const refName = basename(file.filePath, extname(file.filePath)).toLowerCase();
      if (targetName === refName) score += 0.4;
      else if (targetName.includes(refName) || refName.includes(targetName)) score += 0.25;
      if (extname(targetFile) === extname(file.filePath)) score += 0.1;
    }

    const searchableText = [
      ...file.functions,
      ...file.classes,
      ...file.exports,
      file.summary,
      file.filePath,
    ].join(' ').toLowerCase();

    let keywordHits = 0;
    for (const kw of keywords) {
      if (searchableText.includes(kw)) keywordHits++;
    }
    if (keywords.length > 0) {
      score += (keywordHits / keywords.length) * 0.5;
    }

    return Math.min(score, 1.0);
  }

  // ==================== 5. Format for Prompt ====================

  formatForPrompt(results: RAGQueryResult[]): string {
    if (results.length === 0) return '';

    const lines: string[] = [
      '## Reference Code (from similar open-source projects)',
      '',
    ];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`### ${i + 1}. ${r.repoName} — ${r.filePath} (relevance: ${(r.relevanceScore * 100).toFixed(0)}%)`);
      if (r.classes.length > 0) lines.push(`   Classes: ${r.classes.join(', ')}`);
      if (r.functions.length > 0) lines.push(`   Functions: ${r.functions.slice(0, 10).join(', ')}`);
      if (r.exports.length > 0) lines.push(`   Exports: ${r.exports.slice(0, 10).join(', ')}`);
      lines.push(`   Summary: ${r.summary}`);
      lines.push('');
    }

    lines.push('Use the above references as inspiration for implementation patterns, naming conventions, and architectural decisions. Do not copy code directly.');
    return lines.join('\n');
  }

  // ==================== 6. High-Level Pipeline ====================

  async prepare(searchQuery: string): Promise<number> {
    console.log(`[CodeRAG] Preparing references for: "${searchQuery}"`);

    const repos = await this.searchRepos(searchQuery);
    if (repos.length === 0) {
      console.log('[CodeRAG] No repos found on GitHub');
      return 0;
    }

    console.log(`[CodeRAG] Found ${repos.length} repos:`);
    for (const r of repos) {
      console.log(`  ${r.stars} stars | ${r.name}: ${r.description.slice(0, 80)}`);
    }

    let indexed = 0;
    for (const repo of repos) {
      try {
        const repoDir = this.cloneRepo(repo.url, repo.name);
        this.indexRepo(repoDir, repo.name, repo.url);
        indexed++;
      } catch (err) {
        console.warn(`[CodeRAG] Failed to process ${repo.name}: ${err}`);
      }
    }

    console.log(`[CodeRAG] Indexed ${indexed}/${repos.length} repos`);
    return indexed;
  }

  getReferenceContext(taskTitle: string, taskDescription: string): string {
    const query = `${taskTitle} ${taskDescription}`;
    const results = this.query(query);
    return this.formatForPrompt(results);
  }

  getIndexedRepos(): string[] {
    return [...this.indexes.keys()];
  }

  cleanup(): void {
    if (existsSync(this.config.ragDir)) {
      rmSync(this.config.ragDir, { recursive: true, force: true });
    }
    this.indexes.clear();
    console.log('[CodeRAG] Cleaned up all RAG data');
  }
}
