// Merge the outputs of a batch into one INDEX.md plus merged manifest and
// source lists, so a calling agent reads one file instead of N folders.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { jobDir } from './paths.mjs'
import { listJobs, readBatch, summarizeJobs } from './store.mjs'
import { DshoError, excerpt, fmtDuration, readJson, writeJsonAtomic } from './util.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__'])

/** Files below dir (relative paths), newest first, hidden entries skipped. */
export function listFiles(dir, { sinceMs = 0, limit = 500 } = {}) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const st = statSync(full)
        if (st.mtimeMs >= sinceMs) found.push({ path: relative(dir, full), bytes: st.size, mtime: st.mtime.toISOString() })
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  found.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return found.slice(0, limit)
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function jobResult(id) {
  const file = join(jobDir(id), 'result.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

export const jobDuration = (job) =>
  job.startedAt ? (job.endedAt ? Date.parse(job.endedAt) : Date.now()) - Date.parse(job.startedAt) : null

function readOutputArray(dir, filename, job, required, warnings) {
  const warn = (message) => warnings.push({ job: job.id, file: filename, message })
  let value
  try {
    value = readJson(join(dir, filename))
  } catch (err) {
    warn(`Cannot read output: ${excerpt(err.message, 200)}`)
    return []
  }
  if (value === undefined) {
    if (required) warn('Required output is missing')
    return []
  }
  if (!Array.isArray(value)) {
    warn('Expected a JSON array')
    return []
  }
  return value.filter((item, index) => {
    const key = filename === 'sources.json' ? 'url' : 'file'
    if (!item || typeof item[key] !== 'string' || !item[key].trim()) {
      warn(`Entry ${index + 1} needs a non-empty ${key} string`)
      return false
    }
    return true
  })
}

export function collectBatch(batchId, { output } = {}) {
  const batch = readBatch(batchId)
  if (!batch) throw new DshoError(`Batch ${batchId} not found`, 3)
  const jobs = listJobs({ batch: batchId, order: 'index' })
  const summary = summarizeJobs(jobs)
  const manifest = []
  const sources = new Map()
  const sections = []
  const warnings = []

  for (const job of jobs) {
    const dir = job.outDir ?? job.cwd
    const files = listFiles(dir)
    const result = jobResult(job.id)
    const warningStart = warnings.length
    const template = job.template ?? batch.template
    const jobManifest = readOutputArray(dir, 'manifest.json', job, template === 'materials', warnings)
    for (const item of jobManifest) {
      const file = relative(batch.root, join(dir, item.file))
      manifest.push({ ...item, file, job: job.id })
    }
    const jobSources = readOutputArray(dir, 'sources.json', job, template === 'research', warnings)
    for (const source of jobSources) {
      const existing = sources.get(source.url)
      if (existing) {
        if (!existing.jobs.includes(job.id)) existing.jobs.push(job.id)
      } else {
        sources.set(source.url, { ...source, job: job.id, jobs: [job.id] })
      }
    }
    const jobWarnings = warnings.slice(warningStart)
    const nn = String(job.index ?? 0).padStart(2, '0')
    sections.push(
      [
        `## ${nn} · ${job.name ?? job.id} (${job.status}, ${fmtDuration(jobDuration(job))})`,
        '',
        `- Job: \`${job.id}\``,
        `- Folder: \`${relative(batch.root, dir) || '.'}\``,
        `- Task: ${excerpt(job.prompt, 300)}`,
        job.error ? `- Error: ${excerpt(job.error, 300)}` : null,
        ...jobWarnings.map((warning) => `- Warning (${warning.file}): ${warning.message}`),
        files.length ? `- Files: ${files.slice(0, 40).map((f) => `\`${f.path}\``).join(', ')}${files.length > 40 ? ` and ${files.length - 40} more` : ''}` : '- Files: none',
        '',
        result ? result.trim() : '_No final answer._',
        '',
      ]
        .filter((l) => l !== null)
        .join('\n'),
    )
  }

  const counts = Object.entries(summary.counts).map(([k, v]) => `${k} ${v}`).join(', ')
  const index = [
    `# ${batch.name ?? batch.id}`,
    '',
    `Batch \`${batch.id}\` · status ${summary.status} (${counts}) · ${jobs.length} jobs · created ${new Date(batch.createdAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    manifest.length ? `\nMaterial: ${manifest.length} files, see \`manifest.json\`.` : '',
    sources.size ? `Sources: ${sources.size} unique URLs, see \`sources.json\`.` : '',
    warnings.length ? `Collection warnings: ${warnings.length}. See the affected jobs below.` : '',
    '',
    ...sections,
  ].join('\n')

  const indexPath = output ?? join(batch.root, 'INDEX.md')
  const manifestPath = join(batch.root, 'manifest.json')
  const sourcesPath = join(batch.root, 'sources.json')
  // Replace empty aggregates too, so repeated collection cannot retain old entries.
  writeJsonAtomic(manifestPath, manifest)
  writeJsonAtomic(sourcesPath, [...sources.values()])
  writeFileSync(indexPath, index)
  return { batch: batch.id, status: summary.status, counts: summary.counts, index: indexPath, manifest: manifest.length ? manifestPath : null, sources: sources.size ? sourcesPath : null, materialFiles: manifest.length, sourceCount: sources.size, warnings }
}
