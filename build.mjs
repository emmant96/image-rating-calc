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

const html = read(root, 'index.html')

// 1. JSX -> React.createElement, matching the runtime the dev file pins.
const { code: app } = await transformAsync(extractAppSource(html), {
  presets: [['@babel/preset-react', { runtime: 'classic' }]],
  filename: 'app.jsx',
  compact: false,
  babelrc: false,
  configFile: false,
})

// 2. Only the utilities the markup references.
const css = buildCss()

// 3. React itself, so the page needs no network at all.
const react = read(root, 'node_modules/react/umd/react.production.min.js')
const reactDom = read(root, 'node_modules/react-dom/umd/react-dom.production.min.js')

const title = (html.match(/<title>([^<]*)<\/title>/) || [, 'Project Hedgehog Decision Calculator'])[1]

const out = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
writeFileSync(join(dist, 'index.html'), out)
// GitHub Pages runs Jekyll by default, which skips files it does not recognise.
writeFileSync(join(dist, '.nojekyll'), '')
rmSync(tmp, { recursive: true, force: true })

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' kB'
console.log(`built dist/index.html  (css ${kb(css)}, app ${kb(app)}, total ${kb(out)})`)
