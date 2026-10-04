#!/usr/bin/env node
// 自测驱动：用项目自带 esbuild 把 TS 源码与用例打成一个 Node ESM 包后执行，避免为测试引入额外依赖。
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'node_modules', '.selftest')
const entry = path.join(root, 'scripts', 'selftest.mjs')

rmSync(outDir, { recursive: true, force: true })

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: path.join(outDir, 'selftest.bundle.mjs'),
  alias: { '@': path.join(root, 'src') },
  logLevel: 'warning',
})

await import(pathToFileURL(path.join(outDir, 'selftest.bundle.mjs')).href)
