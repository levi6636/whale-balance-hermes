import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// Media assets are intentionally absent from public builds (see README 'Licensing').
// These reads are therefore optional: when a file exists the asset-specific
// assertions run against it, otherwise they are skipped rather than failing.
const readOptional = async url => {
  try { return await readFile(url) } catch { return null }
}
const assetBytes = await readOptional(new URL('../assets/DSniang1.png', import.meta.url))
const assetSha256 = assetBytes ? createHash('sha256').update(assetBytes).digest('hex') : null
const pressAudioBytes = await readOptional(new URL('../assets/Ya1.mp3', import.meta.url))
const releaseAudioBytes = await readOptional(new URL('../assets/Ya2.mp3', import.meta.url))
const hasArtwork = assetBytes !== null
const hasSounds = pressAudioBytes !== null && releaseAudioBytes !== null
// Playback assertions describe behaviour that only exists when the clips are
// present. Public builds strip all audio (README 'Licensing'), so those cases are
// skipped there rather than weakened into meaningless passes.
const SKIP_NO_AUDIO = hasSounds ? false : 'no bundled audio in this build'
const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const viewport = { width: 1000, height: 800 }

// Disk-plugin import allowlist (from apps/desktop/src/contrib/runtime-loader.ts).
const allowedImports = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])

function makeTarget() {
  let captured = false
  return {
    setPointerCapture() { captured = true },
    hasPointerCapture() { return captured },
    releasePointerCapture() { captured = false }
  }
}

let state = []
let index = 0
let effects = []
let rendered = []
let cleanups = []
let refreshed = 0
let queryOptions
let queries = []
let queryResponse = { data: null, isError: false, isFetching: false }
let restCalls
let loadPluginAssetCalls
const stored = new Map()

const jsx = (type, props) => {
  if (props && props.ref && typeof props.ref === 'object' && 'current' in props.ref) {
    props.ref.current = { style: {}, offsetWidth: 0, classList: { add() {}, remove() {}, toggle() {}, contains() { return false } } }
  }
  return { type, props }
}
const hooks = {
  Fragment: 'fragment',
  useState(initial) {
    const i = index++
    if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
    return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
  },
  useRef(initial) {
    const i = index++
    if (!(i in state)) state[i] = { current: initial }
    return state[i]
  },
  useEffect(fn, deps = []) {
    const i = index++
    const previous = state[i]
    if (!previous || deps.some((value, position) => !Object.is(value, previous.deps[position])) || deps.length !== previous.deps.length) {
      state[i] = { deps }
      effects.push({ i, fn })
    }
  }
}
const eventListeners = new Map()
let hostState = { viewport, profile: 'test-profile', gateway: 'open', focusedSessionId: null, focusedUsage: null }
const sdk = {
  STATUSBAR_AREAS: { right: 'statusBar.right' },
  host: { state: hostState },
  useValue: x => x,
  useQuery: options => {
    // The widget asks for more than one query now (balance + ledger). Existing
    // assertions mean the balance one, so pick by key instead of by call order.
    queries.push(options)
    if (!options.queryKey || options.queryKey[1] === 'balance') queryOptions = options
    return { ...queryResponse, refetch: async () => { refreshed++ } }
  }
}

const sandbox = { Date, Math, Number, clearTimeout: () => {}, setTimeout: () => 0 }
const context = vm.createContext(sandbox)
const module = new vm.SourceTextModule(source, { context })
await module.link(async specifier => {
  const exports = specifier === '@hermes/plugin-sdk' ? sdk : specifier === 'react' ? hooks : { jsx, jsxs: jsx }
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  }, { context })
})
await module.evaluate()
const ns = module.namespace

function render(component) {
  index = 0
  effects = []
  const tree = component()
  for (const { i, fn } of effects) {
    cleanups[i]?.()
    const cleanup = fn()
    cleanups[i] = cleanup || (() => {})
  }
  return tree
}

function emitEvent(type, event) {
  for (const listener of [...(eventListeners.get(type) || [])]) listener(event)
}

async function renderWidget(seed = {}, options = {}) {
  state = []
  index = 0
  effects = []
  cleanups = []
  refreshed = 0
  queryOptions = undefined
  queries = []
  queryResponse = { data: null, isError: false, isFetching: false }
  restCalls = []
  loadPluginAssetCalls = []
  stored.clear()
  eventListeners.clear()
  hostState.focusedSessionId = 'sess-a'
  hostState.focusedUsage = { total: 12.5, calls: 3, cost_usd: 0.42 }
  for (const [key, value] of Object.entries(seed)) stored.set(key, value)
  let contribution
  let unsubscribed = 0
  const ctx = {
    source: 'plugin:whale-balance-hermes',
    register(value) { contribution = value },
    storage: {
      get: (key, fallback) => stored.get(key) ?? fallback,
      // `dropWrites` models the host's best-effort localStorage: the write is
      // accepted and silently lost, exactly like a swallowed quota error.
      set: (key, value) => {
        if (options.dropWrites) return
        stored.set(key, value)
      }
    },
    loadPluginAsset: name => { loadPluginAssetCalls.push(name); return sandbox.assetResolver ? sandbox.assetResolver(name) : null },
    rest: async path => {
      restCalls.push(path)
      // The gallery route answers with a data URL; the default stub keeps every
      // other endpoint at the old `{ path }` shape so existing tests are
      // unaffected. `options.bubbleImage` lets a test supply the payload or
      // simulate a rejection.
      if (path.startsWith('/bubble-image/')) {
        if (options.bubbleImageError) throw new Error('boom')
        return options.bubbleImage ? options.bubbleImage(path.slice('/bubble-image/'.length)) : { path }
      }
      return { path }
    },
    os: {
      openExternal: async url => { options.onOpenExternal?.(url); return true }
    },
    onEvent(type, listener) {
      const listeners = eventListeners.get(type) || new Set()
      eventListeners.set(type, listeners)
      listeners.add(listener)
      return () => { unsubscribed++; listeners.delete(listener) }
    }
  }
  ns.default.register(ctx)
  const entry = contribution.render()
  const mascot = entry.type(entry.props)
  const component = () => mascot.type(mascot.props)
  const tree = render(component)
  const frame = (type, payload = {}, overrides = {}) => ({
    type, session_id: hostState.focusedSessionId, payload, ...overrides
  })
  return {
    tree,
    renderAgain: () => render(component),
    setQueryResult: value => { queryResponse = value },
    setFocusedSession: id => { hostState.focusedSessionId = id },
    emit: (type, payload, overrides) => emitEvent(type, frame(type, payload, overrides)),
    subscriptions: type => (eventListeners.get(type) || new Set()).size,
    unsubscribed: () => unsubscribed,
    stored,
    contribution
  }
}

function widgetSection(tree) { return tree.props.children[1] }
function widgetImg(section) { return section.props.children[0].props.children[0] }
function widgetText(section) {
  const component = section.props.children[0].props.children[1].props.children[1]
  return component.type(component.props)
}
function widgetMenu(tree) { return tree.props.children[2] }
function menuControl(menu, index) { return menu.props.children[index].props.children[1] }
function findByClass(node, className) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== 'object' || !node.props) return undefined
  if (node.props.className === className) return node
  return findByClass(node.props.children, className)
}
function editorTree(tree) {
  const element = tree.props.children[3]
  return element?.type(element.props)
}
function openEditor(widget) {
  const section = widgetSection(widget.tree)
  section.props.children[1].props.onClick({ stopPropagation() {} })
  const menu = widget.renderAgain()
  menuControl(widgetMenu(menu), 6).props.onClick({ stopPropagation() {} })
  return widget.renderAgain()
}
function pointer(x, y, target, overrides = {}) {
  return { button: 0, pointerId: 1, currentTarget: target, clientX: x, clientY: y, ...overrides }
}
function findAll(node, predicate, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (!node || typeof node !== 'object' || !node.props) return out
  if (predicate(node)) out.push(node)
  findAll(node.props.children, predicate, out)
  return out
}
function byLabel(node, label) {
  return findAll(node, item => item.props['aria-label'] === label)[0]
}
function byClassIncludes(node, className) {
  return findAll(node, item => typeof item.props.className === 'string' && item.props.className.split(' ').includes(className))
}
function audioTree(tree) {
  const element = tree.props.children[4]
  return element ? element.type(element.props) : undefined
}
function openAudio(widget) {
  widgetSection(widget.tree).props.children[1].props.onClick({ stopPropagation() {} })
  const menu = widget.renderAgain()
  menuControl(widgetMenu(menu), 7).props.onClick({ stopPropagation() {} })
  return widget.renderAgain()
}
function installAudio() {
  const calls = []
  sandbox.Audio = class FakeAudio {
    constructor(url) { this.url = url; this.currentTime = 0; this.volume = 1; calls.push(['construct', url]) }
    play() { calls.push(['play', this.url, this.volume]); return Promise.resolve() }
    pause() { calls.push(['pause', this.url]) }
  }
  return calls
}
const AUDIO_LABELS = [
  '启用音效', '主音量',
  '音效分组 小黄鸭', '音效分组 音效1', '试听小黄鸭按下', '试听小黄鸭松开', '试听音效1按下', '试听音效1松开',
  '启用任务完成音效', '任务完成音效选择', '继承主音量·任务完成', '任务完成音量', '试听任务完成',
  '启用需要输入音效', '需要输入音效选择', '继承主音量·需要输入', '需要输入音量', '试听需要输入',
  '启用需要批准音效', '需要批准音效选择', '继承主音量·需要批准', '需要批准音量', '试听需要批准'
]

test('plugin imports only the disk-loader allowlist', () => {
  const found = new Set()
  for (const m of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/g)) found.add(m[2])
  for (const spec of found) assert.ok(allowedImports.has(spec), `unsupported import ${spec}`)
  assert.ok(found.has('@hermes/plugin-sdk'))
  assert.ok(found.has('react/jsx-runtime'))
})

test('embedded artwork is byte-for-byte the local asset when one is supplied', () => {
  assert.equal(ns.ARTWORK_SHA256, 'dcc456613dbb1102a4b7ef636a8b622371e33b763489d6249c434fb54248ba5c')
  if (!hasArtwork) {
    // Public builds ship no artwork. The payload must be empty and the URI must
    // stay empty too, so the renderer takes the placeholder branch instead of
    // emitting a broken `data:` URL.
    assert.equal(ns.ARTWORK_BASE64, '')
    assert.equal(ns.ARTWORK_URI, '')
    return
  }
  assert.equal(ns.ARTWORK_SHA256, assetSha256)
  const decoded = Buffer.from(ns.ARTWORK_BASE64, 'base64')
  assert.deepEqual(decoded, assetBytes)
  assert.equal(ns.ARTWORK_URI, `data:${ns.ARTWORK_MIME};base64,${ns.ARTWORK_BASE64}`)
})

test('classic bubble, text colors, image and body constants match upstream exactly', () => {
  assert.equal(ns.BUBBLE_VIEWBOX, '0 0 1026 700')
  assert.equal(ns.BUBBLE_BIG_D, 'M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z')
  assert.deepEqual(JSON.parse(JSON.stringify(ns.BUBBLE_SMALL)), [{ cx: 352, cy: 561, rx: 37.5, ry: 26 }, { cx: 442, cy: 646, rx: 24.5, ry: 18 }])
  assert.equal(ns.BUBBLE_FILL, '#FFFFFF')
  assert.equal(ns.BUBBLE_STROKE, '#203170')
  assert.equal(ns.BUBBLE_STROKE_WIDTH, 18)
  assert.equal(ns.TEXT_PRIMARY, '#536ba9')
  assert.equal(ns.TEXT_HINT, '#9fb0d9')
  assert.equal(ns.IMAGE_WIDTH_PCT, '59.45%')
  assert.equal(ns.BODY_TRANSFORM_ORIGIN, '50% 100%')
  assert.equal(ns.BODY_TRANSITION, 'transform .22s cubic-bezier(.34,1.56,.64,1)')
  assert.equal(ns.SQUISH, 'scaleY(0.88) scaleX(1.05)')
  assert.equal(ns.PRESS_VISUAL_TAP_MS, 32)
  assert.equal(ns.MIN_SCALE, 0.6)
  assert.equal(ns.MAX_SCALE, 2.5)
  assert.equal(ns.CLICK_SQ, 9)
  assert.equal(ns.REFRESH_MS, 60000)
  assert.deepEqual(JSON.parse(JSON.stringify(ns.SNAP_ZONES)), { L: 10, T: 0, R: 10, B: 15, F: 50 })
})

test('geometry defaults right/bottom, honors anchors and clamps malformed storage', () => {
  const p = ns.geometry({}, { width: 1000, height: 800 })
  assert.equal(p.scale, 1.5)
  assert.equal(p.size, 336)
  assert.equal(p.width, 336)
  assert.equal(p.height, 336)
  assert.equal(p.x, 664)
  assert.equal(p.y, 464)
  assert.equal(p.flip, false)

  const clamped = ns.geometry({ x: -100, y: 9000, scale: 5 }, viewport)
  assert.equal(clamped.x, 0)
  assert.equal(clamped.scale, 2.5)
  assert.ok(clamped.y + clamped.height <= 800)
  assert.equal(ns.geometry({ scale: NaN }, viewport).scale, 1.5)
  assert.equal(ns.geometry({ scale: 0.1 }, viewport).scale, 0.6)

  const tiny = ns.geometry({ scale: 2.5 }, { width: 100, height: 80 })
  assert.ok(tiny.width <= 100 && tiny.height <= 80)

  assert.equal(ns.baseSquare({ width: 1000, height: 800 }, 0.6), 134.4)
  assert.equal(ns.baseSquare({ width: 1000, height: 800 }, 2.5), 560)

  const anchored = ns.geometry({ hAnchor: 'left', vAnchor: 'top', hDist: 20, vDist: 30, scale: 1.5 }, viewport)
  assert.equal(anchored.x, 20)
  assert.equal(anchored.y, 30)
  for (const bad of [undefined, NaN, Infinity, -Infinity, '20', {}, null]) {
    const repaired = ns.geometry({ hAnchor: 'left', vAnchor: 'bottom', hDist: bad, vDist: bad }, viewport)
    assert.ok(Number.isFinite(repaired.x) && Number.isFinite(repaired.y))
  }
  assert.equal(tiny.width, tiny.height)
  assert.equal(ns.baseSquare({ width: 4000, height: 4000 }, 2.5), 625)
})

test('presentation never invents a balance; stale, unavailable, zero stay distinct', () => {
  assert.equal(ns.presentation(null, true).amount, '—')
  const data = { balance: '12.3400', updated_at: new Date().toISOString(), status: 'ok' }
  assert.equal(ns.presentation(data, false).amount, '¥ 12.3400')
  assert.match(ns.presentation({ ...data, stale: true, code: 'timeout' }, false).hint, /旧数据/)
  assert.match(ns.presentation({ ...data, balance: '0', code: 'zero_unconfirmed' }, false).hint, /零值未确认/)
  assert.match(ns.presentation({ code: 'missing_key' }, false).hint, /密钥/)
  assert.equal(ns.presentation({ balance: 'NaN' }, false).amount, '—')
})

test('source menu queries the selected balance backend and presents CCTQ USD', async () => {
  const w = await renderWidget()
  const section = widgetSection(w.tree)
  section.props.children[1].props.onClick({ stopPropagation() {} })
  const opened = w.renderAgain()
  const menu = widgetMenu(opened)
  const sourceSelect = menuControl(menu, 0)
  assert.equal(sourceSelect.type, 'select')
  assert.deepEqual([...sourceSelect.props.children].map(option => option.props.children), ['DeepSeek', 'CCTQ', 'Neko'])
  assert.equal(sourceSelect.props.value, ns.SOURCE_DEEPSEEK)

  sourceSelect.props.onChange({ target: { value: ns.SOURCE_CCTQ } })
  const cctqTree = w.renderAgain()
  const cctqSection = widgetSection(cctqTree)
  const cctqText = widgetText(cctqSection)
  const [cctqLabel, cctqAmount, cctqHint] = cctqText.props.children
  assert.equal(cctqLabel.props.children, 'CCTQ 余额')
  assert.equal(cctqAmount.props.children, '—')
  assert.match(cctqHint.props.children, /用量查询配置/)
  assert.equal(stored.get('source'), ns.SOURCE_CCTQ)
  assert.equal(queryOptions.enabled, true)
  assert.equal(queryOptions.refetchInterval, ns.REFRESH_MS)
  assert.deepEqual(await queryOptions.queryFn(), { path: '/balance/cctq' })
  assert.deepEqual(restCalls, ['/balance/cctq'])
  assert.equal(ns.presentation({ status: 'ok', currency: 'USD', balance: '12.5', updated_at: new Date().toISOString() }, false).amount, '$ 12.5')

  const cctqSelect = menuControl(widgetMenu(cctqTree), 0)
  cctqSelect.props.onChange({ target: { value: ns.SOURCE_NEKO } })
  const nekoTree = w.renderAgain()
  const [nekoLabel, nekoAmount, nekoHint] = widgetText(widgetSection(nekoTree)).props.children
  assert.equal(nekoLabel.props.children, 'Neko 余额')
  assert.equal(nekoAmount.props.children, '—')
  assert.match(nekoHint.props.children, /用量查询配置/)
  assert.equal(stored.get('source'), ns.SOURCE_NEKO)
  assert.equal(queryOptions.enabled, true)
  assert.deepEqual(await queryOptions.queryFn(), { path: '/balance/neko' })
  assert.deepEqual(restCalls, ['/balance/cctq', '/balance/neko'])
  assert.equal(ns.presentation({ status: 'ok', currency: 'USD', balance: '7.25', updated_at: new Date().toISOString() }, false).amount, '$ 7.25')

  // an unknown persisted source must fall back to DeepSeek, not crash
  const nekoSelect = menuControl(widgetMenu(nekoTree), 0)
  nekoSelect.props.onChange({ target: { value: 'bogus' } })
  const fallbackTree = w.renderAgain()
  assert.equal(widgetText(widgetSection(fallbackTree)).props.children[0].props.children, 'DeepSeek 余额')
  assert.deepEqual(await queryOptions.queryFn(), { path: '/balance' })
  assert.deepEqual(restCalls, ['/balance/cctq', '/balance/neko', '/balance'])
})

test('event config migrates legacy fields separately and preserves display semantics', () => {
  const migrated = ns.normalizeBubbleConfig({ label: 'Name', amountPrefix: 'credits', hint: 'Ready' })
  assert.equal(migrated.version, ns.BUBBLE_CONFIG_VERSION)
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.profiles.idle.map(module => module.type))), ['text', 'balance', 'hint'])
  assert.equal(ns.renderBubbleEvent(migrated, 'idle', {}, 0).text, 'Name')
  assert.equal(ns.bubbleLabel(migrated, 'DeepSeek'), 'Name')
  const mixed = ns.normalizeBubbleConfig({ version: 1, profiles: { idle: [
    { type: 'balance', text: 'credits' },
    { type: 'hint', text: 'Ready' },
    { type: 'image', src: 'data:image/png;base64,AA==' },
    { type: 'used', text: 'used' },
    { type: 'cost', text: 'cost' },
    { type: 'session', text: 'session' },
    { type: 'text', text: '{source} label' },
    { type: 'text', enabled: false, text: 'disabled' }
  ] } })
  assert.equal(ns.bubbleLabel(mixed, 'DeepSeek', 'idle', { source: 'CCTQ' }), 'CCTQ label')
  assert.equal(ns.bubbleLabel(ns.normalizeBubbleConfig({ version: 1, profiles: { idle: [{ type: 'text', enabled: false, text: 'disabled' }, { type: 'balance', text: 'credits' }] } }), 'DeepSeek'), 'DeepSeek 余额')
  assert.equal(ns.bubbleAmount(migrated, '¥ 12.34'), 'credits 12.34')
  assert.equal(ns.bubbleAmount(migrated, '—'), '—')
  assert.equal(ns.bubbleHint(migrated, { idle: true, hint: '点击鲸鱼刷新' }, false), 'Ready')
  assert.equal(ns.bubbleHint(migrated, { idle: false, hint: '不可用 · 无余额接口' }, false), '不可用 · 无余额接口')
  assert.deepEqual(JSON.parse(JSON.stringify(ns.EVENT_PROFILES.map(item => item.id))), ['idle', 'refresh_success', 'balance_changed', 'task_complete', 'needs_input', 'needs_approval'])
  const normalized = ns.normalizeBubbleConfig({ version: 1, profiles: { idle: [null, { type: 'image', enabled: true, weight: Infinity, text: 'x'.repeat(900), src: 'https://example.test/image.png' }], unknown: [{}] } })
  assert.equal(normalized.profiles.idle[0].type, 'text')
  assert.equal(normalized.profiles.idle[1].src, '')
  assert.equal(normalized.profiles.idle[1].text.length, ns.BUBBLE_TEXT_MAX)
  assert.ok(new TextEncoder().encode(JSON.stringify(normalized)).length <= ns.BUBBLE_CONFIG_MAX_BYTES)
  assert.deepEqual(JSON.parse(JSON.stringify(ns.guardBubbleConfigSize({ version: 1, profiles: {} }))), { version: 1, profiles: {} })
})

test('variables are allowlisted, unknown tokens survive, and weighted modules are stable', () => {
  assert.equal(ns.resolveBubbleVariables('{balance} {source} {other} {used}', { balance: '¥ 12', source: 'DeepSeek', used: 3, other: 'bad' }), '¥ 12 DeepSeek {other} 3')
  const modules = [{ enabled: false, weight: 100 }, { enabled: true, weight: 1, text: 'a' }, { enabled: true, weight: 3, text: 'b' }, { enabled: true, weight: NaN }]
  assert.equal(ns.chooseWeightedModule(modules, 0), modules[1])
  assert.equal(ns.chooseWeightedModule(modules, 0.5), modules[2])
  assert.equal(ns.chooseWeightedModule([], 0), null)
  const config = ns.normalizeBubbleConfig({ version: 1, profiles: { idle: [{ type: 'text', text: 'Hello {source}', weight: 1 }] } })
  assert.deepEqual(JSON.parse(JSON.stringify(ns.renderBubbleEvent(config, 'idle', { source: 'CCTQ' }, 0))), { type: 'text', text: 'Hello CCTQ' })
  assert.equal(ns.renderBubbleEvent(config, 'needs_approval', {}, 0), null)
})

test('runtime selects refresh_success once per identity, then balance_changed or idle', async () => {
  const now = new Date().toISOString()
  const config = { version: 1, profiles: {
    idle: [{ type: 'text', text: 'idle' }],
    refresh_success: [{ type: 'text', text: 'refreshed' }],
    balance_changed: [{ type: 'text', text: 'changed' }]
  } }
  const w = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config })
  const label = tree => widgetText(widgetSection(tree)).props.children[0].props.children
  const hint = tree => widgetText(widgetSection(tree)).props.children[2].props.children
  const outcome = (data, extra = {}) => {
    w.setQueryResult({ data, isError: false, isFetching: false, ...extra })
    return label(w.renderAgain())
  }

  // Placeholder data is not a sample, so it must not seed the baseline.
  w.setQueryResult({ data: { balance: '9', updated_at: now, status: 'ok' }, isError: false, isFetching: false, isPlaceholderData: true })
  const placeholderTree = w.renderAgain()
  assert.equal(label(placeholderTree), 'DeepSeek 余额')
  assert.equal(hint(placeholderTree), '点击鲸鱼刷新')

  // First fresh success on this identity is a refresh, not a change and not idle.
  assert.equal(outcome({ balance: '10', updated_at: now, status: 'ok' }), 'refreshed')

  // Same balance again is a plain idle re-render.
  assert.equal(outcome({ balance: '10', updated_at: now, status: 'ok' }), 'idle')

  // A genuinely different balance is the transition.
  assert.equal(outcome({ balance: '11', updated_at: now, status: 'ok' }), 'changed')

  // Stale data is not a sample: no event, and the authoritative hint survives.
  const staleHint = hint((w.setQueryResult({ data: { balance: '12', updated_at: now, status: 'ok', stale: true }, isError: false, isFetching: false }), w.renderAgain()))
  assert.equal(label(w.renderAgain()), 'DeepSeek 余额')
  assert.match(staleHint, /旧数据/)

  // The stale sample left the baseline at '11', so a real '12' is still a change.
  assert.equal(outcome({ balance: '12', updated_at: now, status: 'ok' }), 'changed')

  // Errors are not samples either, and the stale-data hint is preserved once more.
  const errorHint = hint((w.setQueryResult({ data: { balance: '13', updated_at: now, status: 'ok' }, isError: true, isFetching: false }), w.renderAgain()))
  assert.equal(label(w.renderAgain()), 'DeepSeek 余额')
  assert.match(errorHint, /旧数据/)
  assert.equal(outcome({ balance: '13', updated_at: now, status: 'ok' }), 'changed')

  // Switching identity resets the baseline: the same amount is a fresh success
  // for the new [source,profile,gateway] rather than an idle repeat.
  w.setQueryResult({ data: { balance: '13', updated_at: now, status: 'ok' }, isError: false, isFetching: false, isPlaceholderData: true })
  widgetSection(w.tree).props.children[1].props.onClick({ stopPropagation() {} })
  menuControl(widgetMenu(w.renderAgain()), 0).props.onChange({ target: { value: ns.SOURCE_CCTQ } })
  const switchedTree = w.renderAgain()
  assert.equal(label(switchedTree), 'CCTQ 余额')
  assert.equal(hint(switchedTree), '点击鲸鱼刷新')
  assert.equal(outcome({ balance: '13', updated_at: now, status: 'ok' }), 'refreshed')

  // And the new identity now has its own baseline.
  assert.equal(outcome({ balance: '13', updated_at: now, status: 'ok' }), 'idle')
  assert.equal(outcome({ balance: '14', updated_at: now, status: 'ok' }), 'changed')
})


test('runtime composes configured module types, weighted alternatives, local images, and focused usage', async () => {
  const image = 'data:image/png;base64,AA=='
  const config = { version: 1, profiles: { refresh_success: [
    { type: 'text', text: 'first label', weight: 1 },
    { type: 'text', text: 'alternate label', weight: 3 },
    { type: 'balance', text: 'credits' },
    { type: 'used', text: 'used {used}' },
    { type: 'cost', text: 'cost {cost}' },
    { type: 'session', text: 'session {session}' },
    { type: 'image', src: image },
    { type: 'image', src: 'https://invalid.test/image.png' }
  ] } }
  const w = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config })
  const now = new Date().toISOString()
  w.setQueryResult({ data: { balance: '12.3400', currency: 'USD', status: 'ok', updated_at: now }, isError: false, isFetching: false })
  const tree = w.renderAgain()
  const section = widgetSection(tree)
  const text = widgetText(section)
  assert.ok(['first label', 'alternate label'].includes(text.props.children[0].props.children))
  assert.equal(text.props.children[1].props.children, 'credits 12.3400')
  assert.equal(text.props.children[2].props.children, '点击鲸鱼刷新')
  const rows = text.props.children.slice(3).map(row => row.props.children)
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), ['used 12.5', 'cost 0.42', 'session sess-a'])
  // Duplicate modules of one type are weighted alternatives of a single slot,
  // not extra slots: both are reachable and only one label ever composes.
  const labels = new Set()
  for (let attempt = 0; attempt < 60; attempt++) {
    const modules = ns.renderBubbleModules(config, 'refresh_success', {}, Math.random())
    assert.equal(modules.length, 6)
    labels.add(modules.find(module => module.type === 'text').text)
  }
  assert.deepEqual([...labels].sort(), ['alternate label', 'first label'])
  const pop = section.props.children[0].props.children[1]
  const localImages = pop.props.children.filter(node => node?.props?.className === 'dshwv-module-image')
  assert.equal(localImages.length, 1)
  assert.equal(localImages[0].props.src, image)
  assert.equal(localImages[0].props.style.pointerEvents, 'none')

  w.setQueryResult({ data: { balance: 'not-a-number', status: 'invalid_response', code: 'invalid_response' }, isError: true, isFetching: false })
  const failed = w.renderAgain()
  const failedText = widgetText(widgetSection(failed))
  assert.equal(failedText.props.children[1].props.children, '—')
  assert.match(failedText.props.children[2].props.children, /连接失败/)
})

test('runtime events ignore replayed and unfocused frames, select complete and clarify, and clear at message start', async () => {
  const config = { version: 1, profiles: {
    task_complete: [{ type: 'text', text: 'completed' }],
    needs_input: [{ type: 'text', text: 'clarify' }],
    needs_approval: [{ type: 'text', text: 'approval remains editable' }]
  } }
  const w = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config })
  const label = () => widgetText(widgetSection(w.renderAgain())).props.children[0].props.children
  w.emit('message.complete', { status: 'complete' }, { session_id: 'other' })
  assert.equal(label(), 'DeepSeek 余额')
  w.emit('message.complete', { status: 'complete' }, { replayed: true })
  assert.equal(label(), 'DeepSeek 余额')
  w.emit('message.complete', { status: 'error' })
  assert.equal(label(), 'DeepSeek 余额')
  w.emit('message.complete', { status: 'interrupted' })
  assert.equal(label(), 'DeepSeek 余额')
  w.emit('message.complete', { status: 'complete' })
  assert.equal(label(), 'completed')
  w.emit('tool.start', { name: 'other-tool' })
  assert.equal(label(), 'completed')
  w.emit('tool.start', { name: 'clarify' })
  assert.equal(label(), 'clarify')
  w.emit('message.start', {})
  assert.equal(label(), 'DeepSeek 余额')
  assert.equal(w.subscriptions('tool.start'), 1)
  w.setFocusedSession('sess-b')
  w.renderAgain()
  assert.equal(w.subscriptions('tool.start'), 1)
  w.emit('message.complete', { status: 'complete' }, { session_id: 'sess-a' })
  assert.equal(label(), 'DeepSeek 余额')
  w.emit('message.complete', { status: 'complete' })
  assert.equal(label(), 'completed')
})

test('balance baseline effects ignore zero, invalid, unavailable, and stale samples', async () => {
  const now = new Date().toISOString()
  const config = { version: 1, profiles: {
    refresh_success: [{ type: 'text', text: 'fresh' }],
    balance_changed: [{ type: 'text', text: 'changed' }],
    idle: [{ type: 'text', text: 'idle' }]
  } }
  const w = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config })
  const label = () => widgetText(widgetSection(w.renderAgain())).props.children[0].props.children
  for (const data of [
    { balance: '0', status: 'error', code: 'zero_unconfirmed', updated_at: now },
    { balance: 'NaN', status: 'ok', updated_at: now },
    { balance: '8', status: 'ok', stale: true, updated_at: now }
  ]) {
    w.setQueryResult({ data, isError: false, isFetching: false })
    assert.equal(label(), 'DeepSeek 余额')
  }
  w.setQueryResult({ data: { balance: '8', status: 'ok', updated_at: now }, isError: false, isFetching: false })
  assert.equal(label(), 'fresh')
  assert.equal(label(), 'idle')
  w.setQueryResult({ data: { balance: '9', status: 'ok', updated_at: now }, isError: false, isFetching: false })
  assert.equal(label(), 'changed')
})

test('bubble editor edits and saves event modules without changing backend amount or hints', async () => {
  const w = await renderWidget()
  assert.equal(w.stored.has(ns.BUBBLE_CONFIG_KEY), false)
  assert.deepEqual(JSON.parse(JSON.stringify(ns.DEFAULT_BUBBLE_CONFIG)), { version: 1, profiles: {} })
  let editor = editorTree(openEditor(w))
  assert.equal(editor.props.role, 'dialog')
  findByClass(editor, 'dshwv-editor-profile').props.onChange({ target: { value: 'needs_approval' } })
  editor = editorTree(w.renderAgain())
  editor.props.children[4].props.onClick()
  editor = editorTree(w.renderAgain())
  const module = findByClass(editor, 'dshwv-editor-module')
  module.props.children[1].props.onChange({ target: { value: 'text' } })
  editor = editorTree(w.renderAgain())
  findByClass(editor, 'dshwv-editor-module').props.children[3].props.onChange({ target: { value: 'Please approve {source}' } })
  editor = editorTree(w.renderAgain())
  findByClass(editor, 'dshwv-editor-save').props.onClick()
  w.renderAgain()
  const config = w.stored.get(ns.BUBBLE_CONFIG_KEY)
  assert.equal(config.version, 1)
  assert.equal(config.profiles.needs_approval[0].text, 'Please approve {source}')
  assert.equal(widgetText(widgetSection(w.renderAgain())).props.children[1].props.children, '—')
  assert.equal(ns.bubbleHint(config, { idle: false, hint: '不可用 · 无余额接口' }, false), '不可用 · 无余额接口')
  const reopened = await renderWidget(Object.fromEntries(w.stored))
  const reopenedEditor = editorTree(openEditor(reopened))
  findByClass(reopenedEditor, 'dshwv-editor-profile').props.onChange({ target: { value: 'needs_approval' } })
  assert.equal(findByClass(editorTree(reopened.renderAgain()), 'dshwv-editor-module').props.children[3].props.value, 'Please approve {source}')
})

test('bubble editor cancel and reset do not persist until saved', async () => {
  const w = await renderWidget()
  let editor = editorTree(openEditor(w))
  editor.props.children[4].props.onClick()
  editor = editorTree(w.renderAgain())
  findByClass(editor, 'dshwv-editor-cancel').props.onClick()
  w.renderAgain()
  assert.equal(w.stored.has(ns.BUBBLE_CONFIG_KEY), false)
  editor = editorTree(openEditor(w))
  findByClass(editor, 'dshwv-editor-reset').props.onClick()
  editor = editorTree(w.renderAgain())
  findByClass(editor, 'dshwv-editor-save').props.onClick()
  w.renderAgain()
  assert.deepEqual(JSON.parse(JSON.stringify(w.stored.get(ns.BUBBLE_CONFIG_KEY))), JSON.parse(JSON.stringify(ns.normalizeBubbleConfig(ns.DEFAULT_BUBBLE_CONFIG))))
})

test('a silently refused write surfaces as a save error instead of a false success', async () => {
  // ctx.storage.set never throws: the host wraps localStorage and swallows a
  // quota error. Without a read-back probe the editor would close and report a
  // save that never reached disk.
  const w = await renderWidget({}, { dropWrites: true })
  const editor = editorTree(openEditor(w))
  findByClass(editor, 'dshwv-editor-module')
  editor.props.children[4].props.onClick()
  findByClass(editorTree(w.renderAgain()), 'dshwv-editor-save').props.onClick()
  const after = w.renderAgain()
  assert.equal(w.stored.has(ns.BUBBLE_CONFIG_KEY), false)
  const failedEditor = editorTree(after)
  assert.ok(failedEditor, 'editor must stay open so the user can retry')
  const error = findByClass(failedEditor, 'dshwv-editor-error')
  assert.ok(error, 'a refused save must be visible')
  assert.equal(error.props.role, 'alert')
  assert.match(error.props.children, /保存失败/)
})

test('a successful save still closes the editor and reports no error', async () => {
  const w = await renderWidget()
  let editor = editorTree(openEditor(w))
  editor.props.children[4].props.onClick()
  editor = editorTree(w.renderAgain())
  findByClass(editor, 'dshwv-editor-save').props.onClick()
  const after = w.renderAgain()
  assert.ok(!after.props.children[3], 'editor closes only when the write landed')
  assert.equal(findByClass(after, 'dshwv-editor-error'), undefined)
  assert.ok(w.stored.has(ns.BUBBLE_CONFIG_KEY))
})

test('weighted picks follow the configured weights instead of a fixed draw', async () => {
  // Regression: the live widget used a literal 0.5 draw, which made every
  // weight in the editor inert -- only the last module of a type could win.
  const modules = [
    { type: 'text', enabled: true, weight: 1, text: 'low', src: '' },
    { type: 'text', enabled: true, weight: 9, text: 'high', src: '' }
  ]
  const config = ns.normalizeBubbleConfig({ version: 1, profiles: { idle: modules } })
  const pick = random => ns.renderBubbleModules(config, 'idle', {}, random)[0].text
  assert.equal(pick(0), 'low')
  assert.equal(pick(0.5), 'high')
  assert.equal(pick(0.999), 'high')
  // A 0.5 draw alone would always land on 'high', so the low-weight module being
  // reachable at all proves the weight is consulted.
  assert.notEqual(pick(0.05), ns.renderBubbleModules(config, 'idle', {}, 0.5)[0].text)
})

test('row modules are capped so the bubble text cannot overflow', async () => {
  // Measured in Chrome: 3 extra rows fit the 448-unit text box exactly, the 4th
  // overflows by 6.4% and 6 by 28.1% -- and nothing clips, so it paints over the
  // whale. The cap is enforced in the renderer, not only in the editor.
  assert.equal(ns.BUBBLE_MAX_EXTRA_ROWS, 4)
  // Exercise the cap directly: today only three row types exist, so a real render
  // can never exceed four slots and would leave the cap untested.
  const row = (type, text) => ({ type, text })
  const sixRows = [
    row('text', 'a label'),
    row('used', 'u1'), row('cost', 'c1'), row('session', 's1'),
    row('used', 'u2'), row('cost', 'c2'), row('session', 's2')
  ]
  const capped = ns.capBubbleRows(sixRows)
  const keptRows = capped.filter(m => ns.BUBBLE_ROW_TYPES.includes(m.type))
  assert.equal(keptRows.length, ns.BUBBLE_MAX_EXTRA_ROWS, 'six rows must be capped to four')
  assert.deepEqual(keptRows.map(m => m.text), ['u1', 'c1', 's1', 'u2'], 'the cap keeps the first four in order')
  // Non-row modules survive untouched, wherever they sit.
  assert.equal(capped.filter(m => m.type === 'text').length, 1)
  assert.equal(capped[0].type, 'text', 'order is preserved for surviving modules')
  // Under the limit nothing is dropped.
  const threeRows = [row('text', 'l'), row('used', 'u'), row('cost', 'c'), row('session', 's')]
  assert.equal(ns.capBubbleRows(threeRows).length, 4)
  // A real render still honours it.
  const config = ns.normalizeBubbleConfig({ version: 1, profiles: { idle: [
    { type: 'text', enabled: true, weight: 1, text: 'a label', src: '' },
    { type: 'used', enabled: true, weight: 1, text: 'used row', src: '' },
    { type: 'cost', enabled: true, weight: 1, text: 'cost row', src: '' },
    { type: 'session', enabled: true, weight: 1, text: 'session row', src: '' }
  ] } })
  const rendered = ns.renderBubbleModules(config, 'idle', {}, 0.5)
  assert.ok(rendered.filter(m => ns.BUBBLE_ROW_TYPES.includes(m.type)).length <= ns.BUBBLE_MAX_EXTRA_ROWS)
  assert.ok(rendered.some(m => m.type === 'text'))
})

test('text shrinks to fit instead of spilling, and never below the floor', () => {
  // Analytic model, verified against Chrome measurements (see
  // notes/whale-bubble-overflow-measurement.md): 3 rows fit, 4 need a shrink.
  assert.equal(ns.bubbleTextScale(0), 1, 'the default three lines already fit')
  assert.equal(ns.bubbleTextScale(3), 1)
  const four = ns.bubbleTextScale(4)
  assert.ok(four < 1 && four > 0.9, `4 rows need a light shrink, got ${four}`)
  // The math must actually land the content inside 448 units.
  assert.ok(ns.bubbleTextContentHeight(4) * four <= ns.BUBBLE_TEXT_AVAIL + 0.5)
  // A pathological config cannot shrink the text into nothing.
  assert.equal(ns.bubbleTextScale(999), 0.55)
  // Negative / junk input must not produce a scale > 1.
  assert.equal(ns.bubbleTextScale(-2), 1)
  assert.equal(ns.bubbleTextScale(NaN), 1)
})

test('the shrink is folded into each child multiplier, never as a self-referencing var', async () => {
  // A custom property that references itself is invalid at computed-value time,
  // and every dependent font-size silently falls back to 16px. That is a CSS
  // trap a unit test can catch by inspecting the emitted style strings.
  const config = { version: 1, profiles: { idle: [
    { type: 'text', enabled: true, weight: 1, text: 'label', src: '' },
    { type: 'used', enabled: true, weight: 1, text: 'used {used}', src: '' },
    { type: 'cost', enabled: true, weight: 1, text: 'cost {cost}', src: '' },
    { type: 'session', enabled: true, weight: 1, text: 'sess {session}', src: '' }
  ] } }
  const w = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config })
  w.setQueryResult({ data: { balance: '12.3400', status: 'ok', updated_at: new Date().toISOString() }, isError: false, isFetching: false })
  // Three row types only reach fit === 1, so drive the cramped path with four.
  const text = widgetText(widgetSection(w.renderAgain()))
  const container = text.props.style
  assert.equal(container['--dshw-u'], undefined, 'the container must not override --dshw-u (self-reference trap)')
  // Three rows still fit, so this frame is not cramped yet.
  assert.equal(container.justifyContent, 'center')
  assert.equal(container.overflow, 'hidden', 'clipping is a backstop even when it fits')
  for (const kid of text.props.children) {
    assert.match(kid.props.style.fontSize, /var\(--dshw-u\) \* \d/, `unscaled child keeps the plain multiplier: ${kid.props.style.fontSize}`)
  }
  // Now the cramped path. Only distinct types make distinct slots (duplicates are
  // weighted alternatives of ONE slot), so four rows needs four different row
  // types -- which is exactly why the cap is future-proofing: today only three
  // row types exist, so the cap can only bite once more are added.
  assert.equal(ns.bubbleTextScale(4) < 1, true, 'four rows is where the shrink starts')
  // The emitted expression must carry the real fit VALUE. A child that folds in
  // "1" or drops the factor is indistinguishable from a regex that only checks
  // for parentheses, so assert the number itself.
  const fit = ns.bubbleTextScale(4)
  const crampedSize = ns.bubbleTextSize(44, fit)
  assert.ok(crampedSize.includes(String(fit)), `the fit value must appear in the style: ${crampedSize}`)
  assert.equal(crampedSize, `calc(var(--dshw-u) * (44 * ${fit}))`)
  // Unscaled content keeps the exact upstream expression, byte for byte.
  assert.equal(ns.bubbleTextSize(44, 1), 'calc(var(--dshw-u) * 44)')
  assert.equal(ns.bubbleTextSize(128), 'calc(var(--dshw-u) * 128)')
})

test('grant and top-up modules render from the DeepSeek split', async () => {
  // The backend already parsed granted/topped_up but only returned the total, so
  // these modules had no data source before. They are row types: they render as
  // their own lines inside the bubble.
  const config = { version: 1, profiles: { idle: [
    { type: 'text', enabled: true, weight: 1, text: 'DeepSeek 余额', src: '' },
    { type: 'bonus', enabled: true, weight: 1, text: '赠金 {bonus}', src: '' },
    { type: 'recharge', enabled: true, weight: 1, text: '充值 {recharge}', src: '' }
  ] } }
  const w = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config })
  w.setQueryResult({ data: {
    balance: '100.10', granted: '0.03', topped_up: '100.07',
    currency: 'CNY', status: 'ok', updated_at: new Date().toISOString()
  }, isError: false, isFetching: false })
  const text = widgetText(widgetSection(w.renderAgain()))
  const rows = text.props.children.slice(3).map(r => r.props.children)
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), ['赠金 ¥0.03', '充值 ¥100.07'])
  // Both are row types, so they count against the row cap.
  assert.ok(ns.BUBBLE_ROW_TYPES.includes('bonus'))
  assert.ok(ns.BUBBLE_ROW_TYPES.includes('recharge'))
})

test('grant and top-up stay blank when the provider reports no split', async () => {
  // CCTQ and Neko return a single number. Showing ¥0.00 there would invent a
  // balance the provider never reported, so the placeholder must survive.
  const config = { version: 1, profiles: { idle: [
    { type: 'text', enabled: true, weight: 1, text: 'CCTQ 余额', src: '' },
    { type: 'bonus', enabled: true, weight: 1, text: '赠金 {bonus}', src: '' }
  ] } }
  const w = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config, source: ns.SOURCE_CCTQ })
  w.setQueryResult({ data: { balance: '12.50', currency: 'USD', status: 'ok', updated_at: new Date().toISOString() }, isError: false, isFetching: false })
  const text = widgetText(widgetSection(w.renderAgain()))
  const rows = text.props.children.slice(3).map(r => r.props.children)
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), ['赠金 {bonus}'], 'an unsupported split must not look like zero')
})

test('link modules only accept plain http(s) urls', () => {
  // The href reaches ctx.os.openExternal, i.e. the OS shell. These rejections are
  // the security boundary, not politeness.
  assert.equal(ns.safeBubbleHref('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(ns.safeBubbleHref('http://example.com'), 'http://example.com')
  // Case-folded scheme, port preserved, path untouched.
  assert.equal(ns.safeBubbleHref('HTTPS://Example.com:8443/x'), 'https://Example.com:8443/x')
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    // The `scheme://host` shape is what a loose `[a-z]+://` regex would accept,
    // so these are the cases that actually test the scheme allowlist.
    'javascript://example.com/x',
    'vbscript://example.com/',
    'file://server/share',
    'file:///C:/Windows/System32/calc.exe',
    'data://example.com/x',
    'chrome://settings',
    'ms-msdt:/id',
    'https://user:pass@example.com/',
    'not a url',
    '',
    '   ',
    null,
    undefined,
    {},
    12345
  ]) {
    assert.equal(ns.safeBubbleHref(bad), '', `must reject ${String(bad)}`)
  }
  // Absurd length is refused before parsing.
  assert.equal(ns.safeBubbleHref('https://example.com/' + 'a'.repeat(4000)), '')
  // CRLF and whitespace smuggling: these are how a bare prefix check gets beaten.
  assert.equal(ns.safeBubbleHref('https://example.com\n\rX-Evil: 1'), '')
  assert.equal(ns.safeBubbleHref('https://exa mple.com'), '')
  assert.equal(ns.safeBubbleHref('https:\\\\example.com'), '')
  // A hostless authority is not a URL a browser would open.
  assert.equal(ns.safeBubbleHref('https://localhost'), '', 'a bare hostname is not a dotted host')
  assert.equal(ns.safeBubbleHref('https://127.0.0.1:8080'), 'https://127.0.0.1:8080')
})

test('a link module renders clickable and a bad href degrades to plain text', async () => {
  const config = { version: 1, profiles: { idle: [
    { type: 'text', enabled: true, weight: 1, text: 'DeepSeek 余额', src: '' },
    { type: 'link', enabled: true, weight: 1, text: '去充值', href: 'https://platform.deepseek.com/top_up' }
  ] } }
  const w = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config })
  w.setQueryResult({ data: { balance: '12.34', status: 'ok', updated_at: new Date().toISOString() }, isError: false, isFetching: false })
  const text = widgetText(widgetSection(w.renderAgain()))
  const anchor = findByClass(text, 'dshwv-module-link').props.children
  assert.equal(anchor.type, 'a')
  assert.equal(anchor.props.href, 'https://platform.deepseek.com/top_up')
  // Clickable inside an otherwise inert bubble.
  assert.equal(anchor.props.style.pointerEvents, 'auto')
  // A click must never navigate the renderer; the host opens it instead.
  let opened = null
  const w2 = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: config }, { onOpenExternal: url => { opened = url } })
  w2.setQueryResult({ data: { balance: '12.34', status: 'ok', updated_at: new Date().toISOString() }, isError: false, isFetching: false })
  const anchor2 = findByClass(widgetText(widgetSection(w2.renderAgain())), 'dshwv-module-link').props.children
  let prevented = false
  anchor2.props.onClick({ preventDefault: () => { prevented = true }, stopPropagation() {} })
  assert.ok(prevented, 'the renderer must not follow the link itself')
  assert.equal(opened, 'https://platform.deepseek.com/top_up')

  // A rejected href is not an anchor at all.
  const bad = { version: 1, profiles: { idle: [
    { type: 'link', enabled: true, weight: 1, text: '别点', href: 'javascript:alert(1)' }
  ] } }
  const w3 = await renderWidget({ [ns.BUBBLE_CONFIG_KEY]: bad })
  w3.setQueryResult({ data: { balance: '1', status: 'ok', updated_at: new Date().toISOString() }, isError: false, isFetching: false })
  const text3 = widgetText(widgetSection(w3.renderAgain()))
  assert.equal(findByClass(text3, 'dshwv-module-link'), undefined, 'no anchor for a rejected scheme')
  // It degrades into the ordinary text slot: the label stays readable instead of
  // disappearing with the dead link.
  assert.equal(text3.props.children[0].props.children, '别点')
})

test('two random sentences produce ONE line, not two', async () => {
  // This is the assertion the first version of this test missed: `random` and
  // `text` are different types, so they never competed anyway. The behaviour that
  // actually distinguishes a random module from a plain one is that two random
  // entries collapse into a single drawn line. Removing the `random` branch makes
  // them render as two separate lines, and this must fail.
  const config = { version: 1, profiles: { idle: [
    { type: 'text', enabled: true, weight: 1, text: 'DeepSeek 余额', src: '' },
    { type: 'random', enabled: true, weight: 1, text: '句子一', src: '' },
    { type: 'random', enabled: true, weight: 1, text: '句子二', src: '' }
  ] } }
  const norm = ns.normalizeBubbleConfig(config)
  const rendered = ns.renderBubbleModules(norm, 'idle', {}, 0.5)
  // Fixed text still there.
  assert.ok(rendered.some(m => m.type === 'text' && m.text === 'DeepSeek 余额'))
  // Exactly one random line, never both.
  const randoms = rendered.filter(m => m.type === 'random')
  assert.equal(randoms.length, 1, `expected one drawn sentence, got ${randoms.length}`)
  assert.ok(['句子一', '句子二'].includes(randoms[0].text))
  // Both pool members are reachable across draws.
  const seen = new Set()
  for (let i = 0; i < 60; i++) {
    const pick = ns.renderBubbleModules(norm, 'idle', {}, Math.random()).filter(m => m.type === 'random')
    assert.equal(pick.length, 1, 'still one per draw')
    seen.add(pick[0].text)
  }
  assert.deepEqual([...seen].sort(), ['句子一', '句子二'].sort())
})

test('random image draws one valid picture and never a broken one', async () => {
  const good = 'data:image/png;base64,AA=='
  const other = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
  const config = { version: 1, profiles: { idle: [
    { type: 'text', enabled: true, weight: 1, text: 'x', src: '' },
    { type: 'randomImage', enabled: true, weight: 1, src: good },
    { type: 'randomImage', enabled: true, weight: 1, src: other },
    // A candidate with an unusable src must never win the draw.
    { type: 'randomImage', enabled: true, weight: 50, src: 'https://invalid.test/a.png' }
  ] } }
  const norm = ns.normalizeBubbleConfig(config)
  const seen = new Set()
  for (let i = 0; i < 60; i++) {
    const images = ns.renderBubbleModules(norm, 'idle', {}, Math.random()).filter(m => m.type === 'randomImage')
    assert.equal(images.length, 1, 'one random picture per draw')
    assert.ok(images[0].src === good || images[0].src === other, `unexpected src ${images[0].src}`)
    seen.add(images[0].src)
  }
  assert.deepEqual([...seen].sort(), [good, other].sort())
})

test('random types are exposed to the user with readable labels', () => {
  // The user could not find these before: the type dropdown rendered raw ids.
  assert.ok(ns.BUBBLE_MODULE_TYPES.includes('random'))
  assert.ok(ns.BUBBLE_MODULE_TYPES.includes('randomImage'))
  assert.equal(ns.BUBBLE_MODULE_LABELS.random, '随机语句')
  assert.equal(ns.BUBBLE_MODULE_LABELS.randomImage, '随机图片')
  for (const type of ns.BUBBLE_MODULE_TYPES) {
    assert.ok(ns.BUBBLE_MODULE_LABELS[type], `${type} needs a readable label`)
  }
})

test('registered contribution renders the original art on a transparent square with the classic bubble', async () => {
  const w = await renderWidget()
  assert.equal(ns.default.defaultEnabled, false)
  assert.equal(w.contribution.area, 'statusBar.right')

  const section = widgetSection(w.tree)
  const root = section.props.style
  assert.equal(root.position, 'fixed')
  assert.equal(root.background, 'transparent')
  assert.equal(root.border, 0)
  assert.equal(root.outline, 0)
  assert.equal(root.boxShadow, 'none')
  assert.equal(root.backdropFilter, 'none')
  assert.equal(root.filter, 'none')
  assert.equal(root.zIndex, 9999)
  assert.equal(root.pointerEvents, 'none')
  assert.equal(root.width, 336)
  assert.equal(root.height, 336)
  assert.equal(root.left, 664)
  assert.equal(root.top, 464)

  const body = section.props.children[0]
  assert.equal(body.props.style.transformOrigin, '50% 100%')
  assert.equal(body.props.style.transition, 'transform .22s cubic-bezier(.34,1.56,.64,1)')

  const img = widgetImg(section)
  // With no bundled artwork the mascot element is a styled div instead of an img;
  // only the tag differs, every geometry and interaction prop stays identical.
  assert.equal(img.type, hasArtwork ? 'img' : 'div')
  if (hasArtwork) assert.equal(img.props.src, ns.ARTWORK_URI)
  else assert.equal(img.props.src, undefined)
  assert.equal(img.props.alt, hasArtwork ? 'DeepSeek 余额' : undefined)
  assert.equal(img.props.style.width, '59.45%')
  assert.equal(img.props.style.height, '59.45%')
  assert.equal(img.props.style.right, 0)
  assert.equal(img.props.style.bottom, 0)
  assert.equal(img.props.style.objectFit, 'contain')
  assert.equal(img.props.style.objectPosition, 'right bottom')

  const pop = body.props.children[1]
  assert.equal(pop.props.style.aspectRatio, '1026 / 700')
  const shapeComponent = pop.props.children[0]
  const svg = shapeComponent.type(shapeComponent.props).props.children[0]
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.viewBox, '0 0 1026 700')
  const path = svg.props.children[0]
  assert.equal(path.props.d, ns.BUBBLE_BIG_D)
  assert.equal(path.props.fill, '#FFFFFF')
  assert.equal(path.props.stroke, '#203170')
  assert.equal(path.props.strokeWidth, 18)

  const text = widgetText(section)
  assert.equal(text.props.style.color, '#536ba9')
  const [label, amount, hint] = text.props.children
  assert.equal(label.props.children, 'DeepSeek 余额')
  assert.equal(amount.props.children, '—')
  assert.equal(hint.props.style.color, '#9fb0d9')

  assert.deepEqual(JSON.parse(JSON.stringify(queryOptions.queryKey)), ['plugin:whale-balance-hermes', 'balance', 'deepseek', 'test-profile', 'open'])
  assert.equal(queryOptions.refetchInterval, 60000)
  assert.equal(queryOptions.retry, false)
  assert.equal(queryOptions.enabled, true)
  assert.equal((await queryOptions.queryFn()).path, '/balance')
})

test('press squishes the body via the upstream spring and release restores identity', async () => {
  const w = await renderWidget()
  const section = widgetSection(w.tree)
  const bodyEl = section.props.children[0].props.ref.current
  const img = widgetImg(section)
  const target = makeTarget()
  img.props.onPointerDown(pointer(0, 0, target))
  assert.equal(bodyEl.style.transform, ns.SQUISH)
  img.props.onPointerUp(pointer(0, 0, target))
  assert.equal(bodyEl.style.transform, 'scaleY(1) scaleX(1)')
  assert.equal(refreshed, 1) // no drag: a clean click refreshes
})

test('original upstream sound assets are embedded byte-for-byte with pinned hashes when supplied', async () => {
  const pressPrefix = 'data:audio/mpeg;base64,'
  const releasePrefix = 'data:audio/mpeg;base64,'
  if (!hasSounds) {
    // Public builds ship no audio; the constants must be empty so playback takes
    // the existing silent-degradation path rather than constructing a bad URL.
    assert.equal(ns.SOUND_ASSET_PRESS, '')
    assert.equal(ns.SOUND_ASSET_RELEASE, '')
    return
  }
  assert.equal(ns.SOUND_ASSET_PRESS.startsWith(pressPrefix), true)
  assert.equal(ns.SOUND_ASSET_RELEASE.startsWith(releasePrefix), true)
  assert.deepEqual(Buffer.from(ns.SOUND_ASSET_PRESS.slice(pressPrefix.length), 'base64'), pressAudioBytes)
  assert.deepEqual(Buffer.from(ns.SOUND_ASSET_RELEASE.slice(releasePrefix.length), 'base64'), releaseAudioBytes)
  assert.equal(createHash('sha256').update(pressAudioBytes).digest('hex'), '0ad8f934ae5fa3cbd42745e086a56aa6532766618c6a620b860a795bdc7689f9')
  assert.equal(createHash('sha256').update(releaseAudioBytes).digest('hex'), '1a8998077e5e306c3088bb442ce36617261dd58200754f457469a520801c565b')
})

test('sound stays disabled until opt-in and requests embedded audio synchronously on mascot gestures', { skip: SKIP_NO_AUDIO }, async () => {
  const audioCalls = []
  sandbox.Audio = class FakeAudio {
    constructor(url) { this.src = url; this.currentTime = 3; audioCalls.push(['construct', url]) }
    play() { audioCalls.push(['play', this.src]); return Promise.resolve() }
    pause() { audioCalls.push(['pause', this.src]) }
  }
  sandbox.assetResolver = async name => `data:audio/mpeg;base64,${name}`
  const w = await renderWidget()
  const sound = menuControl(widgetMenu(w.tree), 4)
  assert.equal(sound.props.checked, false)
  assert.equal(sound.props.disabled, false)
  const img = widgetImg(widgetSection(w.tree))
  const target = makeTarget()
  img.props.onPointerDown(pointer(0, 0, target))
  img.props.onPointerUp(pointer(0, 0, target))
  assert.deepEqual(audioCalls, [])
  sound.props.onChange({ target: { checked: true } })
  const enabledTree = w.renderAgain()
  const imgEnabled = widgetImg(widgetSection(enabledTree))
  const pressBefore = audioCalls.length
  imgEnabled.props.onPointerDown(pointer(0, 0, target, { isTrusted: true }))
  assert.deepEqual(audioCalls.slice(pressBefore), [['construct', ns.SOUND_ASSET_PRESS], ['play', ns.SOUND_ASSET_PRESS]])
  await Promise.resolve()
  assert.deepEqual(audioCalls.slice(pressBefore), [['construct', ns.SOUND_ASSET_PRESS], ['play', ns.SOUND_ASSET_PRESS]])
  const releaseBefore = audioCalls.length
  imgEnabled.props.onPointerUp(pointer(0, 0, target, { isTrusted: true }))
  assert.deepEqual(audioCalls.slice(releaseBefore), [['construct', ns.SOUND_ASSET_RELEASE], ['play', ns.SOUND_ASSET_RELEASE]])
  await Promise.resolve()
  assert.deepEqual(audioCalls.slice(releaseBefore), [['construct', ns.SOUND_ASSET_RELEASE], ['play', ns.SOUND_ASSET_RELEASE]])
  assert.equal(loadPluginAssetCalls.length, 0)
  assert.equal(stored.get('sound'), true)
})

test('sound toggle is disabled when Audio is unavailable', async () => {
  sandbox.Audio = undefined
  const w = await renderWidget()
  const sound = menuControl(widgetMenu(w.tree), 4)
  assert.equal(sound.props.disabled, true)
})

test('stored opt-in stays silent while the widget is hidden', async () => {
  const audioCalls = []
  sandbox.Audio = class FakeAudio { constructor(url) { audioCalls.push(['construct', url]) } play() { audioCalls.push(['play']) } }
  sandbox.assetResolver = async name => `data:audio/mpeg;base64,${name}`
  const w = await renderWidget({ sound: true, visible: false })
  assert.deepEqual(audioCalls, [])
})

test('dragging never refreshes; release snaps edges and mirrors on the left', async () => {
  const w = await renderWidget()
  const section = widgetSection(w.tree)
  const img = widgetImg(section)
  const target = makeTarget()
  img.props.onPointerDown(pointer(0, 0, target))
  img.props.onPointerMove(pointer(-5000, -5000, target))
  img.props.onPointerUp(pointer(-5000, -5000, target))
  assert.equal(refreshed, 0)
  const saved = stored.get('position')
  assert.equal(saved.x, 0)
  assert.equal(saved.y, 0)
  assert.equal(saved.flip, true)
  assert.equal(saved.hAnchor, 'left')
})

test('a cancelled gesture restores the origin and does not refresh or persist', async () => {
  const w = await renderWidget()
  const section = widgetSection(w.tree)
  const img = widgetImg(section)
  const target = makeTarget()
  img.props.onPointerDown(pointer(0, 0, target))
  img.props.onPointerMove(pointer(200, 0, target))
  img.props.onPointerCancel(pointer(200, 0, target))
  assert.equal(refreshed, 0)
  assert.equal(stored.has('position'), false)
  const bodyEl = section.props.children[0].props.ref.current
  assert.equal(bodyEl.style.transform, 'scaleY(1) scaleX(1)')
})

test('left snap mirrors the art and keeps the bubble text readable (counter-mirrored)', async () => {
  const w = await renderWidget()
  const section = widgetSection(w.tree)
  const img = widgetImg(section)
  const target = makeTarget()
  img.props.onPointerDown(pointer(0, 0, target))
  img.props.onPointerMove(pointer(-5000, 0, target))
  img.props.onPointerUp(pointer(-5000, 0, target))

  const tree2 = w.renderAgain()
  const section2 = widgetSection(tree2)
  assert.match(section2.props.className, /dshwv-left/)
  assert.equal(section2.props.style.transform, 'scaleX(-1)')
  const text2 = widgetText(section2)
  assert.match(text2.props.style.transform, /scaleX\(-1\)/)
  // the art itself must not be re-oriented: right/bottom contain is upstream layout
  assert.equal(widgetImg(section2).props.style.objectPosition, 'right bottom')
})

test('small menu exposes refresh, size, bubble toggle and widget hide with upstream palette', async () => {
  const w = await renderWidget()
  const section = widgetSection(w.tree)
  const menuBtn = section.props.children[1]
  assert.equal(menuBtn.props.style.background, 'rgba(32,49,112,.85)')
  assert.match(source, /dshwv-menu/)
  assert.match(source, /刷新余额/)
  assert.match(source, /min: String\(MIN_SCALE\)/)
  assert.match(source, /checked: bubbleShown/)
  assert.match(source, /隐藏鲸鱼挂件/)
  assert.equal(ns.TEXT_PRIMARY, '#536ba9')
})

test('widget hide persists, disables polling and the toggle re-shows', async () => {
  const w = await renderWidget()
  const toggle = w.tree.props.children[0]
  assert.equal(queryOptions.enabled, true)
  toggle.props.onClick()
  const tree2 = w.renderAgain()
  assert.equal(tree2.props.children[1], false)
  assert.equal(queryOptions.enabled, false)
  assert.equal(stored.get('visible'), false)
  tree2.props.children[0].props.onClick()
  const tree3 = w.renderAgain()
  assert.ok(tree3.props.children[1])
  assert.equal(queryOptions.enabled, true)
  assert.equal(stored.get('visible'), true)
})

test('unmount cleanup releases an in-flight pointer capture', async () => {
  const w = await renderWidget()
  const section = widgetSection(w.tree)
  const img = widgetImg(section)
  let captured = false
  const target = {
    setPointerCapture() { captured = true },
    hasPointerCapture() { return captured },
    releasePointerCapture() { captured = false }
  }
  img.props.onPointerDown(pointer(0, 0, target))
  assert.equal(captured, true)
  assert.equal(w.subscriptions('message.complete'), 1)
  const pending = cleanups.filter(Boolean)
  assert.ok(pending.length >= 2)
  for (const cleanup of pending) cleanup()
  assert.equal(captured, false)
  // Lifecycle-scoped: unmounting drops every gateway subscription.
  assert.equal(w.unsubscribed(), 3)
  assert.equal(w.subscriptions('message.start'), 0)
  assert.equal(w.subscriptions('message.complete'), 0)
  assert.equal(w.subscriptions('tool.start'), 0)
})

test('built-in audio expansion embeds the four original clips byte-for-byte with pinned hashes', async () => {
  const readOptionalAsset = async name => {
    try { return await readFile(new URL(`../assets/${name}`, import.meta.url)) } catch { return null }
  }
  const d1 = await readOptionalAsset('D1.mp3')
  const d2 = await readOptionalAsset('D2.mp3')
  const orb = await readOptionalAsset('minecraft-exp-orb.wav')
  const end = await readOptionalAsset('task-end-a.wav')
  const clips = [
    [ns.SOUND_ASSET_D1, 'data:audio/mpeg;base64,', d1, '626c0fb5dbfb2529331b98b80fa29961efbcbef6a454b36328481b61d8a0c7be'],
    [ns.SOUND_ASSET_D2, 'data:audio/mpeg;base64,', d2, '8327a07da3ec17f42ec6dddec8f6e2862055c7bfa5e15e3908442c517fd0f22d'],
    [ns.SOUND_ASSET_MINECRAFT, 'data:audio/wav;base64,', orb, 'aa96e35a3101b46de496271858e87214e7821a0a85316f6be1a001113ddec619'],
    [ns.SOUND_ASSET_TASK_END, 'data:audio/wav;base64,', end, '6228bbe410658a18f06e5cd42cc055570c54905dd371cb971c0a0df88c47c417']
  ]
  for (const [uri, prefix, bytes, sha] of clips) {
    if (uri === '') {
      // The constant was stripped. That is only legal when the matching file is
      // also absent -- an empty constant beside a present file means someone
      // deleted the payload but left the asset behind.
      assert.equal(bytes, null, 'clip is empty but its asset file still exists')
      continue
    }
    assert.notEqual(bytes, null, 'clip is embedded but its asset file is missing')
    assert.equal(uri.startsWith(prefix), true)
    assert.deepEqual(Buffer.from(uri.slice(prefix.length), 'base64'), bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha)
  }
  // The original artwork and press/release sounds are untouched by this phase.
  if (hasArtwork) assert.equal(ns.ARTWORK_SHA256, assetSha256)
  if (hasSounds) {
    assert.equal(createHash('sha256').update(pressAudioBytes).digest('hex'), '0ad8f934ae5fa3cbd42745e086a56aa6532766618c6a620b860a795bdc7689f9')
    assert.equal(createHash('sha256').update(releaseAudioBytes).digest('hex'), '1a8998077e5e306c3088bb442ce36617261dd58200754f457469a520801c565b')
  }
})

test('legacy sound boolean migrates onto the master switch and stays off by default', () => {
  assert.equal(ns.DEFAULT_AUDIO_CONFIG.enabled, false)
  assert.equal(ns.normalizeAudioConfig(undefined, undefined).enabled, false)
  assert.equal(ns.normalizeAudioConfig(undefined, false).enabled, false)
  assert.equal(ns.normalizeAudioConfig(undefined, true).enabled, true)
  const fresh = ns.normalizeAudioConfig(ns.DEFAULT_AUDIO_CONFIG)
  assert.equal(fresh.enabled, false)
  assert.equal(fresh.volume, 1)
  assert.equal(fresh.group, ns.AUDIO_GROUP_DUCK)

  // A versioned config wins over a stale legacy boolean.
  const custom = ns.normalizeAudioConfig({
    version: 1, enabled: false, volume: 0.3, group: ns.AUDIO_GROUP_FX1,
    events: { task_complete: { enabled: true, choice: ns.AUDIO_CHOICE_MINECRAFT, volume: 0 } }
  }, true)
  assert.equal(custom.enabled, false)
  assert.equal(custom.group, ns.AUDIO_GROUP_FX1)
  assert.equal(custom.events.task_complete.enabled, true)
  assert.equal(custom.events.task_complete.choice, ns.AUDIO_CHOICE_MINECRAFT)
  assert.equal(custom.events.task_complete.volume, 0)

  // Malformed values are bounded rather than trusted.
  const bounded = ns.normalizeAudioConfig({ version: 1, enabled: 'yes', volume: 9, group: 'nope', events: { needs_input: { enabled: 'x', choice: 'bad', volume: 2 } } })
  assert.equal(bounded.enabled, false)
  assert.equal(bounded.volume, 1)
  assert.equal(bounded.group, ns.AUDIO_GROUP_DUCK)
  assert.equal(bounded.events.needs_input.enabled, false)
  assert.equal(bounded.events.needs_input.choice, ns.AUDIO_CHOICE_A)
  assert.equal(bounded.events.needs_input.volume, null)
  assert.deepEqual(JSON.parse(JSON.stringify(ns.AUDIO_EVENT_IDS)), ['task_complete', 'needs_input', 'needs_approval'])
  assert.deepEqual(JSON.parse(JSON.stringify(ns.AUDIO_RUNTIME_EVENT_IDS)), ['task_complete', 'needs_input'])
})

test('group selection maps to the embedded URLs and event volume follows the master until set', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ns.audioGroupUrls(ns.DEFAULT_AUDIO_CONFIG, ns.AUDIO_GROUP_DUCK))), { press: ns.SOUND_ASSET_PRESS, release: ns.SOUND_ASSET_RELEASE })
  assert.deepEqual(JSON.parse(JSON.stringify(ns.audioGroupUrls(ns.DEFAULT_AUDIO_CONFIG, ns.AUDIO_GROUP_FX1))), { press: ns.SOUND_ASSET_D1, release: ns.SOUND_ASSET_D2 })
  assert.equal(ns.audioEventUrl(ns.DEFAULT_AUDIO_CONFIG, 'task_complete'), ns.SOUND_ASSET_TASK_END)
  const mc = ns.normalizeAudioConfig({ version: 1, events: { task_complete: { choice: ns.AUDIO_CHOICE_MINECRAFT } } })
  assert.equal(ns.audioEventUrl(mc, 'task_complete'), ns.SOUND_ASSET_MINECRAFT)
  const config = ns.normalizeAudioConfig({ version: 1, volume: 0.4, events: { task_complete: { volume: null }, needs_input: { volume: 0 } } })
  assert.equal(ns.audioEventVolume(config, 'task_complete'), 0.4)
  assert.equal(ns.audioEventVolume(config, 'needs_input'), 0)
  // needs_approval is configurable and previewable but never runtime-delivered.
  assert.equal(ns.audioEventUrl(config, 'needs_approval'), ns.SOUND_ASSET_TASK_END)
  assert.equal(ns.AUDIO_EVENT_UNAVAILABLE.needs_approval, true)
})

test('audio settings open from the menu, edit a draft, and persist only on save', async () => {
  installAudio()
  const w = await renderWidget()
  assert.equal(w.stored.has(ns.AUDIO_CONFIG_KEY), false)
  let panel = audioTree(openAudio(w))
  assert.equal(panel.props.role, 'dialog')
  assert.equal(panel.props['aria-label'], '音效设置')
  assert.match(panel.props.style.background, /var\(--ui/)
  assert.match(panel.props.style.color, /var\(--ui/)
  for (const label of AUDIO_LABELS) assert.ok(byLabel(panel, label), `missing accessible label ${label}`)
  assert.equal(byClassIncludes(panel, 'dshwv-audio-event-unavailable').length, 1)

  // Draft-only: master, group and event edits write nothing yet.
  byLabel(panel, '启用音效').props.onChange({ target: { checked: true } })
  panel = audioTree(w.renderAgain())
  byLabel(panel, '音效分组 音效1').props.onChange({ target: { checked: true } })
  panel = audioTree(w.renderAgain())
  byLabel(panel, '启用任务完成音效').props.onChange({ target: { checked: true } })
  panel = audioTree(w.renderAgain())
  byLabel(panel, '任务完成音效选择').props.onChange({ target: { value: ns.AUDIO_CHOICE_MINECRAFT } })
  panel = audioTree(w.renderAgain())
  assert.equal(w.stored.has(ns.AUDIO_CONFIG_KEY), false)
  assert.equal(w.stored.has('sound'), false)

  // Cancel discards the draft entirely.
  findByClass(panel, 'dshwv-audio-cancel').props.onClick()
  assert.equal(w.renderAgain().props.children[4], false)
  assert.equal(w.stored.has(ns.AUDIO_CONFIG_KEY), false)

  // Reopen, redo, save: storage and the quick toggle now agree.
  panel = audioTree(openAudio(w))
  assert.equal(byLabel(panel, '启用音效').props.checked, false)
  byLabel(panel, '启用音效').props.onChange({ target: { checked: true } })
  panel = audioTree(w.renderAgain())
  byLabel(panel, '音效分组 音效1').props.onChange({ target: { checked: true } })
  panel = audioTree(w.renderAgain())
  byLabel(panel, '启用任务完成音效').props.onChange({ target: { checked: true } })
  panel = audioTree(w.renderAgain())
  byLabel(panel, '任务完成音效选择').props.onChange({ target: { value: ns.AUDIO_CHOICE_MINECRAFT } })
  panel = audioTree(w.renderAgain())
  findByClass(panel, 'dshwv-audio-save').props.onClick()
  const saved = w.stored.get(ns.AUDIO_CONFIG_KEY)
  assert.equal(saved.enabled, true)
  assert.equal(saved.group, ns.AUDIO_GROUP_FX1)
  assert.equal(saved.events.task_complete.enabled, true)
  assert.equal(saved.events.task_complete.choice, ns.AUDIO_CHOICE_MINECRAFT)
  assert.equal(w.stored.get('sound'), true)
  assert.equal(menuControl(widgetMenu(w.renderAgain()), 4).props.checked, true)

  // Reopening shows the saved values.
  panel = audioTree(openAudio(w))
  assert.equal(byLabel(panel, '启用音效').props.checked, true)
  assert.equal(byLabel(panel, '音效分组 音效1').props.checked, true)
  assert.equal(byLabel(panel, '启用任务完成音效').props.checked, true)
  assert.equal(byLabel(panel, '任务完成音效选择').props.value, ns.AUDIO_CHOICE_MINECRAFT)

  // Reset returns the draft to defaults without touching storage.
  findByClass(panel, 'dshwv-audio-reset').props.onClick()
  panel = audioTree(w.renderAgain())
  assert.equal(byLabel(panel, '启用音效').props.checked, false)
  assert.equal(w.stored.get(ns.AUDIO_CONFIG_KEY).enabled, true)
  findByClass(panel, 'dshwv-audio-save').props.onClick()
  assert.equal(w.stored.get(ns.AUDIO_CONFIG_KEY).enabled, false)
})

test('audio previews play synchronously with the selected group URL and resolved volume', { skip: SKIP_NO_AUDIO }, async () => {
  const calls = installAudio()
  const w = await renderWidget({ [ns.AUDIO_CONFIG_KEY]: { version: 1, enabled: true, volume: 0.5, group: ns.AUDIO_GROUP_DUCK, events: {} } })
  let panel = audioTree(openAudio(w))
  byLabel(panel, '试听小黄鸭按下').props.onClick()
  assert.deepEqual(calls, [['construct', ns.SOUND_ASSET_PRESS], ['play', ns.SOUND_ASSET_PRESS, 0.5]])

  // Changing the selected group silences the previous preview.
  byLabel(panel, '音效分组 音效1').props.onChange({ target: { checked: true } })
  assert.equal(calls[calls.length - 1][0], 'pause')
  panel = audioTree(w.renderAgain())
  const beforeRelease = calls.length
  byLabel(panel, '试听音效1松开').props.onClick()
  assert.deepEqual(calls.slice(beforeRelease), [['construct', ns.SOUND_ASSET_D2], ['play', ns.SOUND_ASSET_D2, 0.5]])

  // A null event volume resolves to the master; unchecking inherit materializes it.
  byLabel(panel, '继承主音量·任务完成').props.onChange({ target: { checked: false } })
  panel = audioTree(w.renderAgain())
  assert.equal(byLabel(panel, '任务完成音量').props.value, '0.5')
  assert.equal(byLabel(panel, '任务完成音量').props.disabled, false)
  // An explicit zero is respected, not treated as "unset".
  byLabel(panel, '任务完成音量').props.onChange({ target: { value: '0' } })
  panel = audioTree(w.renderAgain())
  assert.equal(byLabel(panel, '任务完成音量').props.value, '0')
  byLabel(panel, '启用任务完成音效').props.onChange({ target: { checked: true } })
  panel = audioTree(w.renderAgain())
  const beforeZero = calls.length
  byLabel(panel, '试听任务完成').props.onClick()
  assert.deepEqual(calls.slice(beforeZero), [['construct', ns.SOUND_ASSET_TASK_END], ['play', ns.SOUND_ASSET_TASK_END, 0]])

  // Switching the event choice swaps the source URL.
  byLabel(panel, '任务完成音效选择').props.onChange({ target: { value: ns.AUDIO_CHOICE_MINECRAFT } })
  panel = audioTree(w.renderAgain())
  const beforeMinecraft = calls.length
  byLabel(panel, '试听任务完成').props.onClick()
  assert.deepEqual(calls.slice(beforeMinecraft), [['construct', ns.SOUND_ASSET_MINECRAFT], ['play', ns.SOUND_ASSET_MINECRAFT, 0]])
})

test('runtime completion and clarify audio gate on focus, replay, id and status', { skip: SKIP_NO_AUDIO }, async () => {
  const calls = installAudio()
  const config = { version: 1, enabled: true, volume: 0.25, group: ns.AUDIO_GROUP_DUCK, events: {
    task_complete: { enabled: true, choice: ns.AUDIO_CHOICE_A, volume: null },
    needs_input: { enabled: true, choice: ns.AUDIO_CHOICE_MINECRAFT, volume: null }
  } }
  const w = await renderWidget({ [ns.AUDIO_CONFIG_KEY]: config })
  const plays = () => calls.filter(call => call[0] === 'play')

  w.emit('message.complete', { status: 'complete' }, { session_id: 'other', message_id: 'm1' })
  w.emit('message.complete', { status: 'complete' }, { replayed: true, message_id: 'm2' })
  w.emit('message.complete', { status: 'error', message_id: 'm3' })
  w.emit('message.complete', { status: 'interrupted', message_id: 'm4' })
  assert.deepEqual(plays(), [])

  w.emit('message.complete', { status: 'complete' }, { message_id: 'm5' })
  assert.deepEqual(calls.slice(-2), [['construct', ns.SOUND_ASSET_TASK_END], ['play', ns.SOUND_ASSET_TASK_END, 0.25]])
  // The same id is deduplicated inside its own session.
  w.emit('message.complete', { status: 'complete' }, { message_id: 'm5' })
  assert.equal(plays().length, 1)
  // A different session reusing the id is a different completion and still plays.
  w.setFocusedSession('sess-b')
  w.renderAgain()
  w.emit('message.complete', { status: 'complete' }, { session_id: 'sess-b', message_id: 'm5' })
  assert.equal(plays().length, 2)

  // clarify plays the Minecraft orb, once per tool id, for the focused session.
  w.emit('tool.start', { name: 'clarify' }, { tool_id: 't1' })
  assert.deepEqual(calls.slice(-2), [['construct', ns.SOUND_ASSET_MINECRAFT], ['play', ns.SOUND_ASSET_MINECRAFT, 0.25]])
  w.emit('tool.start', { name: 'clarify' }, { tool_id: 't1' })
  assert.equal(plays().length, 3)
  w.emit('tool.start', { name: 'clarify' }, { tool_id: 't2' })
  assert.equal(plays().length, 4)

  // No approval event is invented: an unrelated tool stays silent.
  w.emit('tool.start', { name: 'approve' }, { tool_id: 't3' })
  assert.equal(plays().length, 4)
})

test('runtime audio dedup is session scoped, ignores poisoned frames, and evicts the oldest at the bound', { skip: SKIP_NO_AUDIO }, async () => {
  const calls = installAudio()
  const config = { version: 1, enabled: true, volume: 0.5, group: ns.AUDIO_GROUP_DUCK, events: {
    task_complete: { enabled: true, choice: ns.AUDIO_CHOICE_A, volume: null },
    needs_input: { enabled: true, choice: ns.AUDIO_CHOICE_MINECRAFT, volume: null }
  } }
  const w = await renderWidget({ [ns.AUDIO_CONFIG_KEY]: config })
  const plays = () => calls.filter(call => call[0] === 'play').length

  // Same message id in two sessions: the second session must not be silenced.
  w.emit('message.complete', { status: 'complete' }, { message_id: 'shared' })
  assert.equal(plays(), 1)
  w.emit('message.complete', { status: 'complete' }, { message_id: 'shared' })
  assert.equal(plays(), 1)
  w.setFocusedSession('sess-b')
  w.renderAgain()
  w.emit('message.complete', { status: 'complete' }, { session_id: 'sess-b', message_id: 'shared' })
  assert.equal(plays(), 2)

  // A frame that merely reuses an id must not claim it for the real cue.
  w.emit('message.complete', { status: 'error' }, { message_id: 'poison' })
  w.emit('message.complete', { status: 'interrupted' }, { message_id: 'poison' })
  w.emit('tool.start', { name: 'other-tool' }, { tool_id: 'poison' })
  assert.equal(plays(), 2)
  w.emit('message.complete', { status: 'complete' }, { message_id: 'poison' })
  assert.equal(plays(), 3)
  w.emit('tool.start', { name: 'clarify' }, { tool_id: 'poison' })
  assert.equal(plays(), 4)

  // Bound: the oldest ids are evicted one at a time, never the whole set. A recent
  // duplicate therefore stays deduplicated right at the boundary.
  const before = plays()
  w.emit('message.complete', { status: 'complete' }, { message_id: 'ev0' })
  for (let i = 1; i <= 512; i++) w.emit('message.complete', { status: 'complete' }, { message_id: `ev${i}` })
  assert.equal(plays(), before + 513)
  w.emit('message.complete', { status: 'complete' }, { message_id: 'ev0' })
  assert.equal(plays(), before + 514)
  w.emit('message.complete', { status: 'complete' }, { message_id: 'ev512' })
  assert.equal(plays(), before + 514)
})

test('master off, hidden and unmount all silence every audio slot', { skip: SKIP_NO_AUDIO }, async () => {
  const calls = installAudio()
  // Master off: neither previews nor runtime events may play.
  const off = await renderWidget({ [ns.AUDIO_CONFIG_KEY]: { version: 1, enabled: false, volume: 0.5, events: { task_complete: { enabled: true } } } })
  const offPanel = audioTree(openAudio(off))
  byLabel(offPanel, '试听小黄鸭按下').props.onClick()
  off.emit('message.complete', { status: 'complete' }, { message_id: 'z1' })
  assert.deepEqual(calls, [])

  // Hidden widget: a stored opt-in stays silent for runtime events too.
  const hidden = await renderWidget({ [ns.AUDIO_CONFIG_KEY]: { version: 1, enabled: true, events: { task_complete: { enabled: true } } }, visible: false })
  hidden.emit('message.complete', { status: 'complete' }, { message_id: 'z2' })
  assert.deepEqual(calls, [])

  // Unmounting stops the in-flight preview.
  const w = await renderWidget({ [ns.AUDIO_CONFIG_KEY]: { version: 1, enabled: true, volume: 0.5, events: {} } })
  const panel = audioTree(openAudio(w))
  byLabel(panel, '试听小黄鸭按下').props.onClick()
  assert.equal(calls[calls.length - 1][0], 'play')
  for (const cleanup of cleanups.filter(Boolean)) cleanup()
  assert.equal(calls[calls.length - 1][0], 'pause')
})

test('preview stops on save, cancel, reset and hide', { skip: SKIP_NO_AUDIO }, async () => {
  const calls = installAudio()
  const seed = { [ns.AUDIO_CONFIG_KEY]: { version: 1, enabled: true, volume: 0.5, group: ns.AUDIO_GROUP_DUCK, events: {} } }

  let w = await renderWidget(seed)
  let panel = audioTree(openAudio(w))
  byLabel(panel, '试听小黄鸭按下').props.onClick()
  findByClass(panel, 'dshwv-audio-cancel').props.onClick()
  assert.equal(calls[calls.length - 1][0], 'pause')
  assert.equal(w.renderAgain().props.children[4], false)

  w = await renderWidget(seed)
  panel = audioTree(openAudio(w))
  byLabel(panel, '试听小黄鸭松开').props.onClick()
  findByClass(panel, 'dshwv-audio-save').props.onClick()
  assert.equal(calls[calls.length - 1][0], 'pause')
  assert.equal(w.renderAgain().props.children[4], false)

  w = await renderWidget(seed)
  panel = audioTree(openAudio(w))
  byLabel(panel, '试听音效1按下').props.onClick()
  findByClass(panel, 'dshwv-audio-reset').props.onClick()
  assert.equal(calls[calls.length - 1][0], 'pause')

  w = await renderWidget(seed)
  panel = audioTree(openAudio(w))
  byLabel(panel, '试听小黄鸭按下').props.onClick()
  w.renderAgain().props.children[0].props.onClick()
  assert.equal(calls[calls.length - 1][0], 'pause')
})

test('the quick sound toggle drives the master switch and mirrors into the panel', async () => {
  installAudio()
  const w = await renderWidget()
  const sound = menuControl(widgetMenu(w.tree), 4)
  assert.equal(sound.props.checked, false)
  sound.props.onChange({ target: { checked: true } })
  const enabledTree = w.renderAgain()
  assert.equal(w.stored.get('sound'), true)
  assert.equal(w.stored.get(ns.AUDIO_CONFIG_KEY).enabled, true)
  assert.equal(menuControl(widgetMenu(enabledTree), 4).props.checked, true)

  const panel = audioTree(openAudio(w))
  assert.equal(byLabel(panel, '启用音效').props.checked, true)
  // Editing the master inside the panel is draft-only until Save.
  byLabel(panel, '启用音效').props.onChange({ target: { checked: false } })
  audioTree(w.renderAgain())
  assert.equal(w.stored.get(ns.AUDIO_CONFIG_KEY).enabled, true)
  assert.equal(w.stored.get('sound'), true)
})

// ---------------------------------------------------------------------------
// 小鲸鱼记账
// ---------------------------------------------------------------------------
const LEDGER_OK = {
  status: 'ok',
  peak_now: false,
  next_boundary: new Date(Date.now() + 3600_000).toISOString(),
  totals: { cost_cny: '1.23450000', peak_cost_cny: '0.30000000', off_peak_cost_cny: '0.93450000' },
  window: {
    totals: {
      cost_cny: '0.55550000', peak_cost_cny: '0.10000000', off_peak_cost_cny: '0.45550000',
      input_tokens: 1200, output_tokens: 300, cache_read_tokens: 4000, api_calls: 9
    },
    by_day: [{
      day: '2026-10-17', cost_cny: '0.55550000', peak_cost_cny: '0.10000000',
      input_tokens: 1200, output_tokens: 300, cache_read_tokens: 4000, api_calls: 9
    }]
  },
  by_model: [
    { model: 'deepseek-flash', cost_cny: '0.55550000', priced: true, price_source: 'deepseek-list' },
    { model: 'gpt-6-luna', cost_cny: '0.00000000', priced: false, price_source: 'user' },
    { model: 'gemini-3.8-flash-tiered', cost_cny: '0.10000000', priced: true, price_source: 'estimate' },
    { model: 'claude-sonnet-4-6', cost_cny: '0.20000000', priced: true, price_source: 'public-list' }
  ]
}

function ledgerTree(tree) {
  const element = tree.props.children[5]
  return element ? element.type(element.props) : undefined
}

function openLedger(widget) {
  widgetSection(widget.tree).props.children[1].props.onClick({ stopPropagation() {} })
  const menu = widget.renderAgain()
  menuControl(widgetMenu(menu), 8).props.onClick({ stopPropagation() {} })
  return widget.renderAgain()
}

test('ledger panel stays closed until the menu opens it and asks for the default range', async () => {
  const w = await renderWidget()
  assert.equal(w.tree.props.children[5], false)
  const ledgerQuery = queries.find(options => options.queryKey[1] === 'ledger')
  assert.deepEqual(JSON.parse(JSON.stringify(ledgerQuery.queryKey)), ['plugin:whale-balance-hermes', 'ledger', 7])
  // Closed panel must not poll the database.
  assert.equal(ledgerQuery.enabled, false)
})

test('ledger panel reports a degraded read instead of inventing amounts', async () => {
  const w = await renderWidget()
  w.setQueryResult({
    data: { status: 'degraded', code: 'ledger_read_failed', message: 'state.db locked' },
    isError: false, isFetching: false
  })
  const panel = ledgerTree(openLedger(w))
  assert.ok(findByClass(panel, 'dshwv-ledger-panel'))
  const text = JSON.stringify(panel)
  assert.ok(text.includes('读不到本机用量记录'))
  assert.ok(text.includes('ledger_read_failed'))
  // No money is rendered at all when the read failed.
  assert.equal(text.includes('¥'), false)
})

test('ledger panel reports transport errors without a response body', async () => {
  const w = await renderWidget()
  w.setQueryResult({ data: undefined, isError: true, error: new Error('HTTP 500'), isFetching: false })
  const panel = ledgerTree(openLedger(w))
  const text = JSON.stringify(panel)
  assert.ok(text.includes('读不到本机用量记录'))
  assert.equal(text.includes('¥'), false)
})

test('ledger panel renders totals, peak split, days and unpriced models', async () => {
  const w = await renderWidget()
  w.setQueryResult({ data: LEDGER_OK, isError: false, isFetching: false })
  const panel = ledgerTree(openLedger(w))
  const text = JSON.stringify(panel)
  assert.ok(text.includes('¥1.23'), 'grand total')
  assert.ok(text.includes('¥0.56'), 'window total')
  assert.ok(text.includes('2026-10-17'), 'day row')
  assert.ok(text.includes('deepseek-flash'), 'priced model')
  // An unpriced model must be named, not silently dropped from the sum.
  assert.ok(text.includes('gpt-6-luna'))
  assert.ok(text.includes('没有价目表'))
})

test('ledger marks converted public prices and routing-alias estimates', async () => {
  const w = await renderWidget()
  w.setQueryResult({ data: LEDGER_OK, isError: false, isFetching: false })
  const text = JSON.stringify(ledgerTree(openLedger(w)))
  assert.ok(text.includes('估算价'), 'routing alias is labelled an estimate')
  assert.ok(text.includes('参考价'), 'converted vendor list price is labelled')
  assert.equal(text.includes('deepseek-flash · '), false, 'own price sheet needs no label')
})

test('ledger range buttons re-query and the close button hides the panel', async () => {
  const w = await renderWidget()
  w.setQueryResult({ data: LEDGER_OK, isError: false, isFetching: false })
  let panel = ledgerTree(openLedger(w))
  queries = []
  byLabel(panel, '30 天').props.onClick()
  const rerendered = w.renderAgain()
  const ledgerQuery = queries.find(options => options.queryKey[1] === 'ledger')
  assert.deepEqual(JSON.parse(JSON.stringify(ledgerQuery.queryKey)), ['plugin:whale-balance-hermes', 'ledger', 30])

  panel = ledgerTree(rerendered)
  findByClass(panel, 'dshwv-ledger-close').props.onClick()
  assert.equal(w.renderAgain().props.children[5], false)
})

test('hiding the widget also closes the ledger panel', async () => {
  const w = await renderWidget()
  w.setQueryResult({ data: LEDGER_OK, isError: false, isFetching: false })
  openLedger(w)
  w.tree.props.children[0].props.onClick()
  assert.equal(w.renderAgain().props.children[5], false)
})

// --- built-in gallery -------------------------------------------------------

const GIF_1PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

test('a built-in picture is stored as a reference, never as inline base64', async () => {
  assert.equal(ns.BUBBLE_ASSET_PREFIX, 'asset:')
  // The whole point of the reference form: the stored config stays tiny even
  // when the picture is megabytes. A raw data URL here would reproduce the
  // localStorage blow-out this design exists to avoid.
  const stored = ns.normalizeBubbleSrc('asset:petpet')
  assert.equal(stored, 'asset:petpet')
  assert.equal(ns.normalizeBubbleSrc('asset:../../etc/passwd'), '', 'unknown ids are rejected')
  assert.equal(ns.normalizeBubbleSrc('asset:' + GIF_1PX), '', 'a data URL smuggled behind the prefix is rejected')
})

test('a reference resolves only once its picture is cached', async () => {
  // Before the fetch lands the ref must resolve to nothing, so the renderer
  // drops the module instead of drawing an empty box.
  assert.equal(ns.resolveBubbleImage('asset:money1'), '')
  const cached = await ns.loadBubbleImage({ rest: async () => ({ ok: true, data_url: GIF_1PX }) }, 'money1')
  assert.equal(cached, GIF_1PX)
  assert.equal(ns.resolveBubbleImage('asset:money1'), GIF_1PX, 'cached ref now resolves')
  // An inline data URL keeps working unchanged for user-picked files.
  assert.equal(ns.resolveBubbleImage(GIF_1PX), GIF_1PX)
  assert.equal(ns.resolveBubbleImage('https://example.com/a.gif'), '', 'remote urls are not a src')
})

test('unknown ids and failed fetches never reach the network or the cache', async () => {
  // The picture cache is session-wide, so each case starts from empty or a
  // leftover hit from an earlier test would mask the behaviour under test.
  ns.clearBubbleImageCache()
  const calls = []
  const ctx = { rest: async path => { calls.push(path); return { ok: false, code: 'asset_missing' } } }
  assert.equal(await ns.loadBubbleImage(ctx, '../secret'), '', 'unlisted id is refused before any request')
  assert.deepEqual(calls, [], 'no request was attempted')

  assert.equal(await ns.loadBubbleImage(ctx, 'petpet'), '', 'a failed response yields nothing')
  assert.deepEqual(calls, ['/bubble-image/petpet'])
  assert.equal(ns.resolveBubbleImage('asset:petpet'), '', 'a failure is not cached as an empty picture')

  // A failure must not be memoised: the backend may simply not be up yet, and a
  // cached empty would keep the picture broken for the whole session.
  const recovered = { rest: async () => ({ ok: true, data_url: GIF_1PX }) }
  assert.equal(await ns.loadBubbleImage(recovered, 'petpet'), GIF_1PX, 'a retry after failure succeeds')
  ns.clearBubbleImageCache()

  const throwing = { rest: async () => { throw new Error('offline') } }
  assert.equal(await ns.loadBubbleImage(throwing, 'money1'), '', 'a throwing transport yields nothing')
  ns.clearBubbleImageCache()
})

test('the editor writes a reference and the bubble then renders the picture', async () => {
  ns.clearBubbleImageCache()
  const w = await renderWidget({
    [ns.BUBBLE_CONFIG_KEY]: { version: 1, profiles: { idle: [{ type: 'randomImage', enabled: true, weight: 1, text: '', src: '' }] } }
  }, { bubbleImage: () => ({ ok: true, data_url: GIF_1PX }) })
  openEditor(w)
  const editor = editorTree(w.renderAgain())
  const pickers = findAll(editor, node => node.props.className === 'dshwv-gallery-pick')
  assert.equal(pickers.length, 2, 'both built-in pictures are offered')

  // The click handler returns its promise, so awaiting it covers the fetch.
  await pickers[1].props.onClick({ stopPropagation() {}, preventDefault() {} })
  for (let i = 0; i < 5; i++) await Promise.resolve()

  // The draft is not the config: a pick that was never saved stays out of storage.
  assert.equal(JSON.stringify(w.stored.get(ns.BUBBLE_CONFIG_KEY)).includes('asset:'), false)

  const previews = findAll(editorTree(w.renderAgain()), node => node.props.alt === '模块图片预览')
  assert.equal(previews.length, 1, 'the picked picture previews in the editor')
  assert.equal(previews[0].props.src, GIF_1PX)

  findByClass(editorTree(w.renderAgain()), 'dshwv-editor-save').props.onClick()

  const saved = ns.normalizeBubbleConfig(w.stored.get(ns.BUBBLE_CONFIG_KEY))
  const rows = saved.profiles.idle.filter(module => module.src)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].src, 'asset:money1', 'storage holds the reference, not the pixels')
  assert.equal(JSON.stringify(saved).length < 500, true, 'the stored blob stays small')
  ns.clearBubbleImageCache()
})

test('the editor writes a reference and the bubble then renders the picture', async () => {
  ns.clearBubbleImageCache()
  const w = await renderWidget({
    [ns.BUBBLE_CONFIG_KEY]: { version: 1, profiles: { idle: [{ type: 'randomImage', enabled: true, weight: 1, text: '', src: '' }] } }
  }, { bubbleImage: () => ({ ok: true, data_url: GIF_1PX }) })
  openEditor(w)
  const editor = editorTree(w.renderAgain())
  const pickers = findAll(editor, node => node.props.className === 'dshwv-gallery-pick')
  assert.equal(pickers.length, 2, 'both built-in pictures are offered')

  // The click handler returns its promise, so awaiting it covers the fetch.
  await pickers[1].props.onClick({ stopPropagation() {}, preventDefault() {} })
  for (let i = 0; i < 5; i++) await Promise.resolve()

  // The draft is not the config: a pick that was never saved stays out of storage.
  assert.equal(JSON.stringify(w.stored.get(ns.BUBBLE_CONFIG_KEY)).includes('asset:'), false)

  const previews = findAll(editorTree(w.renderAgain()), node => node.props.alt === '模块图片预览')
  assert.equal(previews.length, 1, 'the picked picture previews in the editor')
  assert.equal(previews[0].props.src, GIF_1PX)

  findByClass(editorTree(w.renderAgain()), 'dshwv-editor-save').props.onClick()

  const saved = ns.normalizeBubbleConfig(w.stored.get(ns.BUBBLE_CONFIG_KEY))
  const rows = saved.profiles.idle.filter(module => module.src)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].src, 'asset:money1', 'storage holds the reference, not the pixels')
  assert.equal(JSON.stringify(saved).length < 500, true, 'the stored blob stays small')
  ns.clearBubbleImageCache()
})

test('a picked picture renders in the bubble itself, not just the editor', async () => {
  ns.clearBubbleImageCache()
  const w = await renderWidget({
    [ns.BUBBLE_CONFIG_KEY]: { version: 1, profiles: { idle: [{ type: 'image', enabled: true, weight: 1, text: '', src: 'asset:petpet' }] } }
  }, { bubbleImage: () => ({ ok: true, data_url: GIF_1PX }) })
  // Before the picture loads the module cannot render; after, it can. This is the
  // difference between a silent drop and a picture that appears late.
  const before = ns.renderBubbleModules(w.stored.get(ns.BUBBLE_CONFIG_KEY), 'idle', {})
  assert.equal(before.length, 0, 'not renderable until the pixels arrive')

  await ns.loadBubbleImage({ rest: async () => ({ ok: true, data_url: GIF_1PX }) }, 'petpet')
  const after = ns.renderBubbleModules(w.stored.get(ns.BUBBLE_CONFIG_KEY), 'idle', {})
  assert.equal(after.length, 1)
  assert.equal(after[0].type, 'image')
  assert.equal(after[0].src, GIF_1PX, 'the bubble gets a real data URL to draw')
  ns.clearBubbleImageCache()
})
