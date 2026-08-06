/**
 * Build: index.html (dev, CDN-driven) -> dist/index.html (self-contained).
 *
 * The dev file loads Tailwind, React and Babel from CDNs and compiles JSX in the
 * browser on every page load. This script does that work once, ahead of time:
 *
 *   1. Compile the JSX with @babel/core (classic runtime -> React.createElement).
 *   2. Generate only the Tailwind CSS the markup actually uses.
 *   3. Inline React + ReactDOM from node_modules.
 *
 * The result has zero external requests: it renders instantly and works offline.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformAsync } from '@babel/core'

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, 'dist')
const tmp = join(root, '.build-tmp')

const read = (...p) => readFileSync(join(...p), 'utf8')

// Every page that gets compiled and shipped. Tailwind scans all of them so one
// stylesheet covers the whole site.
const PAGES = ['index.html', 'training.html', 'results.html']

/** Pull the app source out of the single <script type="text/babel"> block. */
function extractAppSource(html) {
  const open = html.indexOf('<script type="text/babel"')
  if (open === -1) throw new Error('no <script type="text/babel"> block found in index.html')
  const bodyStart = html.indexOf('>', open) + 1
  const bodyEnd = html.indexOf('</script>', bodyStart)
  if (bodyEnd === -1) throw new Error('unterminated <script type="text/babel"> block')
  return html.slice(bodyStart, bodyEnd)
}

/** Generate the minimal Tailwind stylesheet for the classes used in index.html. */
function buildCss() {
  mkdirSync(tmp, { recursive: true })
  const input = join(tmp, 'input.css')
  const output = join(tmp, 'output.css')
  writeFileSync(input, `@import "tailwindcss";\n@source "${join(root, 'index.html').replace(/\\/g, '/')}";\n`)
  // Invoke the CLI's JS entry directly rather than through npx: no shell involved,
  // so this behaves identically on Windows and on the Linux CI runner.
  const cli = join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs')
  execFileSync(process.execPath, [cli, '-i', input, '-o', output, '--minify'], {
    cwd: root,
    stdio: 'pipe',
  })
  return read(output)
}

// Tailwind once, covering every page.
const css = buildCss()

// React itself, so the pages need no network at all.
const react = read(root, 'node_modules/react/umd/react.production.min.js')
const reactDom = read(root, 'node_modules/react-dom/umd/react-dom.production.min.js')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const kb = (n) => (n / 1024).toFixed(1) + ' kB'

for (const page of PAGES) {
  const html = read(root, page)

  // JSX -> React.createElement, matching the runtime the dev files pin.
  const { code: app } = await transformAsync(extractAppSource(html), {
    presets: [['@babel/preset-react', { runtime: 'classic' }]],
    filename: page.replace('.html', '.jsx'),
    compact: false,
    babelrc: false,
    configFile: false,
  })

  const title = (html.match(/<title>([^<]*)<\/title>/) || [, 'Image Rating Calculator'])[1]
  // Keep any robots directive the source page set, so the results dashboard
  // and the training pages stay out of search results.
  const robots = /<meta name="robots"[^>]*>/.exec(html)
  const head = robots ? '\n    ' + robots[0] : ''

  const out = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />${head}
    <title>${title}</title>
    <style>${css}</style>
  </head>
  <body class="bg-slate-950">
    <div id="root"></div>
    <script>${react}</script>
    <script>${reactDom}</script>
    <script>${app}</script>
  </body>
</html>
`

  writeFileSync(join(dist, page), out)
  console.log(`built dist/${page.padEnd(14)} app ${kb(Buffer.byteLength(app)).padStart(9)}  total ${kb(Buffer.byteLength(out))}`)
}

// GitHub Pages runs Jekyll by default, which skips files it does not recognise.
writeFileSync(join(dist, '.nojekyll'), '')
rmSync(tmp, { recursive: true, force: true })
console.log(`shared css ${kb(Buffer.byteLength(css))}`)
