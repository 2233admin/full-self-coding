import { parse } from '@typescript-eslint/typescript-estree'
import type { TSESTree } from '@typescript-eslint/typescript-estree'
import * as path from 'path'

// ==================== Types ====================

export interface ParsedChunk {
  chunkType: 'function' | 'class' | 'file_header'
  name: string
  // embed text: "{chunkType} {name} in {filePath}: {docstring or sig first 100 chars}"
  content: string
  startLine: number
  endLine?: number
}

// ==================== Constants ====================

const MAX_CHUNKS = 100
const MAX_CONTENT = 300

// ==================== Public API ====================

export function parseFile(
  filePath: string,
  source: string,
  language: string,
): ParsedChunk[] {
  const lang = language.toLowerCase()
  let chunks: ParsedChunk[]

  if (lang === 'typescript' || lang === 'javascript' || lang === 'tsx' || lang === 'jsx') {
    chunks = parseTS(filePath, source, lang)
  } else if (lang === 'python') {
    chunks = parsePython(filePath, source)
  } else if (lang === 'rust') {
    chunks = parseRust(filePath, source)
  } else if (lang === 'go') {
    chunks = parseGo(filePath, source)
  } else {
    chunks = parseGeneric(filePath, source, lang)
  }

  // Always prepend file_header
  const header = buildFileHeader(filePath, source)
  const all = [header, ...chunks]

  return truncateChunks(all)
}

// ==================== File Header ====================

function buildFileHeader(filePath: string, source: string): ParsedChunk {
  const lines = source.split('\n')
  const basename = path.basename(filePath)

  // Grab first 3 non-empty comment/import lines for summary
  const summary = lines
    .filter(l => {
      const t = l.trim()
      return t.length > 0 && (
        t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') ||
        t.startsWith('*') || t.startsWith('import') || t.startsWith('from') ||
        t.startsWith('use ') || t.startsWith('package ')
      )
    })
    .slice(0, 3)
    .map(l => l.trim())
    .join(' ')
    .slice(0, 200)

  return {
    chunkType: 'file_header',
    name: basename,
    content: clip(`file ${basename} in ${filePath}: ${summary || '(no summary)'}`),
    startLine: 1,
  }
}

// ==================== TypeScript / JavaScript ====================

function parseTS(filePath: string, source: string, lang: string): ParsedChunk[] {
  try {
    const ast = parse(source, {
      jsx: lang === 'tsx' || lang === 'jsx',
      loc: true,
      range: false,
      tolerant: true,
    })
    return extractFromAST(filePath, source, ast)
  } catch {
    // fallback to regex
    return parseTSRegex(filePath, source)
  }
}

type ASTNode = TSESTree.Node

function extractFromAST(filePath: string, source: string, ast: TSESTree.Program): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  const lines = source.split('\n')

  function getLine(node: ASTNode): string {
    if (!node.loc) return ''
    return lines[node.loc.start.line - 1] ?? ''
  }

  function buildContent(chunkType: 'function' | 'class', name: string, node: ASTNode, docstring?: string): string {
    const sig = getLine(node).trim().slice(0, 100)
    const detail = docstring ? docstring.slice(0, 100) : sig
    return clip(`${chunkType} ${name} in ${filePath}: ${detail}`)
  }

  function extractLeadingDoc(node: ASTNode): string | undefined {
    // Look for JSDoc comment just above the node
    if (!node.loc) return undefined
    const startLine = node.loc.start.line
    const candidate = lines[startLine - 2]?.trim() ?? ''
    if (candidate.startsWith('*') || candidate.startsWith('//') || candidate.startsWith('/*')) {
      return candidate.replace(/^[/*\s]+/, '').slice(0, 100)
    }
    return undefined
  }

  function visitFn(node: ASTNode, name: string, className?: string): void {
    if (!node.loc) return
    const fullName = className ? `${className}.${name}` : name
    chunks.push({
      chunkType: 'function',
      name: fullName,
      content: buildContent('function', fullName, node, extractLeadingDoc(node)),
      startLine: node.loc.start.line,
      endLine: node.loc.end.line,
    })
  }

  function visitClass(node: TSESTree.ClassDeclaration | TSESTree.ClassExpression, name: string): void {
    if (!node.loc) return
    chunks.push({
      chunkType: 'class',
      name,
      content: buildContent('class', name, node, extractLeadingDoc(node)),
      startLine: node.loc.start.line,
      endLine: node.loc.end.line,
    })
    // Extract methods
    for (const member of node.body.body) {
      if (
        member.type === 'MethodDefinition' ||
        member.type === 'PropertyDefinition'
      ) {
        const m = member as TSESTree.MethodDefinition
        if (m.key && m.key.type === 'Identifier' && m.value) {
          visitFn(m.value, (m.key as TSESTree.Identifier).name, name)
        }
      }
    }
  }

  function walk(node: ASTNode, className?: string): void {
    switch (node.type) {
      case 'FunctionDeclaration': {
        const n = node as TSESTree.FunctionDeclaration
        if (n.id) visitFn(n, n.id.name, className)
        break
      }
      case 'VariableDeclaration': {
        const n = node as TSESTree.VariableDeclaration
        for (const decl of n.declarations) {
          if (
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')
          ) {
            visitFn(decl.init, (decl.id as TSESTree.Identifier).name, className)
          }
        }
        break
      }
      case 'ClassDeclaration': {
        const n = node as TSESTree.ClassDeclaration
        if (n.id) visitClass(n, n.id.name)
        return // methods already handled inside visitClass
      }
      case 'ExportNamedDeclaration': {
        const n = node as TSESTree.ExportNamedDeclaration
        if (n.declaration) walk(n.declaration, className)
        break
      }
      case 'ExportDefaultDeclaration': {
        const n = node as TSESTree.ExportDefaultDeclaration
        walk(n.declaration as ASTNode, className)
        break
      }
    }
    // Shallow walk top-level only — don't recurse into function bodies
  }

  for (const stmt of ast.body) {
    walk(stmt as ASTNode)
  }

  return chunks
}

// Regex fallback for TS/JS when parse fails
function parseTSRegex(filePath: string, source: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  const lines = source.split('\n')
  let currentClass: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    const lineNum = i + 1

    // Class
    const cls = t.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/)
    if (cls) {
      currentClass = cls[1]
      chunks.push({
        chunkType: 'class',
        name: cls[1],
        content: clip(`class ${cls[1]} in ${filePath}: ${t.slice(0, 100)}`),
        startLine: lineNum,
      })
      continue
    }

    // Arrow function or function declaration
    const fn =
      t.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) ??
      t.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/)
    if (fn) {
      const name = currentClass ? `${currentClass}.${fn[1]}` : fn[1]
      chunks.push({
        chunkType: 'function',
        name,
        content: clip(`function ${name} in ${filePath}: ${t.slice(0, 100)}`),
        startLine: lineNum,
      })
    }
  }

  return chunks
}

// ==================== Python ====================

function parsePython(filePath: string, source: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  const lines = source.split('\n')
  let currentClass: string | null = null
  let currentClassIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trim()
    const lineNum = i + 1
    const indent = raw.length - raw.trimStart().length

    // Track class scope by indent
    if (currentClass !== null && indent <= currentClassIndent && t.length > 0 && !t.startsWith('#')) {
      currentClass = null
      currentClassIndent = -1
    }

    // Class declaration
    const cls = t.match(/^class\s+(\w+)/)
    if (cls) {
      currentClass = cls[1]
      currentClassIndent = indent

      // Look for docstring on next non-empty line
      let doc = ''
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim()
        if (next.startsWith('"""') || next.startsWith("'''")) {
          doc = next.replace(/^["']{3}/, '').replace(/["']{3}.*$/, '').trim().slice(0, 100)
          break
        }
        if (next.length > 0) break
      }

      chunks.push({
        chunkType: 'class',
        name: cls[1],
        content: clip(`class ${cls[1]} in ${filePath}: ${doc || t.slice(0, 100)}`),
        startLine: lineNum,
      })
      continue
    }

    // Function / method (top-level or one level of indentation)
    const fn = t.match(/^(?:async\s+)?def\s+(\w+)\s*\(/)
    if (fn && indent <= 8) {
      const isMethod = currentClass !== null && indent > 0
      const name = isMethod ? `${currentClass}.${fn[1]}` : fn[1]

      // Docstring on next line
      let doc = ''
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim()
        if (next.startsWith('"""') || next.startsWith("'''")) {
          doc = next.replace(/^["']{3}/, '').replace(/["']{3}.*$/, '').trim().slice(0, 100)
          break
        }
        if (next.length > 0) break
      }

      chunks.push({
        chunkType: 'function',
        name,
        content: clip(`function ${name} in ${filePath}: ${doc || t.slice(0, 100)}`),
        startLine: lineNum,
      })
    }
  }

  return chunks
}

// ==================== Rust ====================

function parseRust(filePath: string, source: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  const lines = source.split('\n')
  let currentImpl: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    const lineNum = i + 1

    // impl block — capture the type name
    const impl = t.match(/^impl(?:<[^>]*>)?\s+([\w:]+)/)
    if (impl) {
      currentImpl = impl[1]
      continue
    }
    // End of impl block (rough heuristic: standalone closing brace at col 0)
    if (lines[i] === '}') {
      currentImpl = null
    }

    // struct, enum, trait
    const typeDef = t.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/)
    if (typeDef) {
      const keyword = t.includes('struct') ? 'class' : 'class'
      chunks.push({
        chunkType: keyword,
        name: typeDef[1],
        content: clip(`class ${typeDef[1]} in ${filePath}: ${t.slice(0, 100)}`),
        startLine: lineNum,
      })
      continue
    }

    // fn (with various visibility/qualifiers)
    const fn = t.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/)
    if (fn) {
      const name = currentImpl ? `${currentImpl}::${fn[1]}` : fn[1]
      // Doc comment above (/// or //)
      const doc = lines[i - 1]?.trim().replace(/^\/\/\/?!?\s*/, '').slice(0, 100) ?? ''
      chunks.push({
        chunkType: 'function',
        name,
        content: clip(`function ${name} in ${filePath}: ${doc || t.slice(0, 100)}`),
        startLine: lineNum,
      })
    }
  }

  return chunks
}

// ==================== Go ====================

function parseGo(filePath: string, source: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    const lineNum = i + 1

    // type X struct / type X interface
    const typeDef = t.match(/^type\s+(\w+)\s+(struct|interface)/)
    if (typeDef) {
      chunks.push({
        chunkType: 'class',
        name: typeDef[1],
        content: clip(`class ${typeDef[1]} in ${filePath}: ${t.slice(0, 100)}`),
        startLine: lineNum,
      })
      continue
    }

    // func (recv RecvType) MethodName(
    const method = t.match(/^func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(\w+)\s*\(/)
    if (method) {
      const name = `${method[1]}.${method[2]}`
      const doc = lines[i - 1]?.trim().replace(/^\/\/\s*/, '').slice(0, 100) ?? ''
      chunks.push({
        chunkType: 'function',
        name,
        content: clip(`function ${name} in ${filePath}: ${doc || t.slice(0, 100)}`),
        startLine: lineNum,
      })
      continue
    }

    // func FunctionName(
    const fn = t.match(/^func\s+(\w+)\s*\(/)
    if (fn) {
      const doc = lines[i - 1]?.trim().replace(/^\/\/\s*/, '').slice(0, 100) ?? ''
      chunks.push({
        chunkType: 'function',
        name: fn[1],
        content: clip(`function ${fn[1]} in ${filePath}: ${doc || t.slice(0, 100)}`),
        startLine: lineNum,
      })
    }
  }

  return chunks
}

// ==================== Generic (Java, C++, etc.) ====================

function parseGeneric(filePath: string, source: string, _lang: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    const lineNum = i + 1

    // Class-like
    const cls = t.match(/^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+(\w+)/)
    if (cls) {
      chunks.push({
        chunkType: 'class',
        name: cls[1],
        content: clip(`class ${cls[1]} in ${filePath}: ${t.slice(0, 100)}`),
        startLine: lineNum,
      })
      continue
    }

    // Method/function-like (Java/C++ style: return-type name(...))
    const fn = t.match(/^(?:public|private|protected|static|virtual|override|inline|\w+)\s+(?:\w+[*&]?\s+)+(\w+)\s*\(/)
    if (fn && !['if', 'for', 'while', 'switch', 'catch'].includes(fn[1])) {
      chunks.push({
        chunkType: 'function',
        name: fn[1],
        content: clip(`function ${fn[1]} in ${filePath}: ${t.slice(0, 100)}`),
        startLine: lineNum,
      })
    }
  }

  return chunks
}

// ==================== Helpers ====================

function clip(s: string): string {
  return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) : s
}

function truncateChunks(chunks: ParsedChunk[]): ParsedChunk[] {
  if (chunks.length <= MAX_CHUNKS) return chunks

  // Keep file_header + all classes, then fill with functions up to limit
  const header = chunks.filter(c => c.chunkType === 'file_header')
  const classes = chunks.filter(c => c.chunkType === 'class')
  const functions = chunks.filter(c => c.chunkType === 'function')

  const result = [...header, ...classes]
  const remaining = MAX_CHUNKS - result.length
  result.push(...functions.slice(0, remaining))

  return result
}
