import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBatch, createJob } from '../src/store.mjs'
import { collectBatch } from '../src/collect.mjs'

function fixture(t, templates = ['research']) {
  const root = mkdtempSync(join(tmpdir(), 'dsho-collect-'))
  const previousHome = process.env.DSHO_HOME
  process.env.DSHO_HOME = join(root, 'state')
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSHO_HOME
    else process.env.DSHO_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  })
  const batch = createBatch({ root })
  const jobs = templates.map((template, index) => {
    const cwd = join(root, String(index))
    mkdirSync(cwd)
    return createJob({ batch: batch.id, cwd, template, index, status: 'done' })
  })
  const write = (index, file, data) => writeFileSync(join(jobs[index].cwd, file), JSON.stringify(data))
  return { root, batch, jobs, write }
}

test('shared sources retain legacy attribution and all contributing jobs without duplicates', (t) => {
  const { root, batch, jobs, write } = fixture(t, ['research', 'research'])
  write(0, 'sources.json', [{ url: 'https://example.com', title: 'First' }])
  write(1, 'sources.json', [{ url: 'https://example.com' }, { url: 'https://example.com' }])
  const result = collectBatch(batch.id)
  assert.equal(result.sourceCount, 1)
  assert.deepEqual(result.warnings, [])
  const [source] = JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8'))
  assert.equal(source.job, jobs[0].id)
  assert.equal(source.title, 'First')
  assert.deepEqual(source.jobs, jobs.map((job) => job.id))
})

test('repeated collection replaces stale source and material aggregates with empty arrays', (t) => {
  const { root, batch, write } = fixture(t, ['raw'])
  write(0, 'sources.json', [{ url: 'https://example.com' }])
  write(0, 'manifest.json', [{ file: 'image.png' }])
  collectBatch(batch.id)
  write(0, 'sources.json', [])
  write(0, 'manifest.json', [])
  const result = collectBatch(batch.id)
  assert.equal(result.sources, null)
  assert.equal(result.manifest, null)
  for (const file of ['sources.json', 'manifest.json']) {
    assert.deepEqual(JSON.parse(readFileSync(join(root, file), 'utf8')), [])
  }
})

test('invalid JSON and missing required files produce per-job warnings while valid jobs survive', (t) => {
  const { batch, jobs, write } = fixture(t, ['research', 'materials', 'research'])
  writeFileSync(join(jobs[0].cwd, 'sources.json'), '{broken')
  write(2, 'sources.json', [{ url: 'https://example.com' }])
  const result = collectBatch(batch.id)
  assert.equal(result.sourceCount, 1)
  assert.equal(result.warnings.length, 2)
  assert.equal(result.warnings[0].job, jobs[0].id)
  assert.equal(result.warnings[1].file, 'manifest.json')
  assert.match(readFileSync(result.index, 'utf8'), /Required output is missing/)
})

test('wrong structures and invalid entries are reported and valid entries are retained', (t) => {
  const { batch, write } = fixture(t, ['research', 'materials'])
  write(0, 'sources.json', { url: 'https://example.com' })
  write(1, 'manifest.json', [null, { file: 42 }, { file: 'image.png' }])
  const result = collectBatch(batch.id)
  assert.equal(result.warnings.length, 3)
  assert.equal(result.materialFiles, 1)
})

test('missing optional files do not warn for raw jobs', (t) => {
  const { batch } = fixture(t, ['raw'])
  assert.deepEqual(collectBatch(batch.id).warnings, [])
})

test('collect exposes warnings through JSON and ordinary CLI output', (t) => {
  const { batch } = fixture(t)
  const cli = fileURLToPath(new URL('../bin/dsho.mjs', import.meta.url))
  const run = (...args) => execFileSync(process.execPath, [cli, 'collect', batch.id, ...args], { encoding: 'utf8' })
  const result = JSON.parse(run('--json'))
  assert.equal(result.warnings.length, 1)
  assert.match(run(), /Warning: .*sources.json: Required output is missing/)
})
