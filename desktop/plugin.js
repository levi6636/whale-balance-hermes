/**
 * Hermes Desktop compatibility adapter for MeteorNOX/dsh-whale-widget.
 *
 * PRIVATE local adaptation — not for distribution. The upstream project's code
 * is MIT-licensed; the artwork (assets/DSniang1.png, embedded below byte-for-byte)
 * is NOT covered by the MIT license and is used as-is only to run the plugin.
 * See README.md § Licensing and UPSTREAM-README.md / PROVENANCE.md upstream.
 *
 * This file is a plain-ESM disk plugin. It may only import @hermes/plugin-sdk,
 * react and react/jsx-runtime; relative filesystem imports cannot resolve in
 * the Hermes disk loader, so the original cut-out is embedded as a data: URI
 * (the app's own image policy is `img-src data:`). The local PNG is retained
 * in assets/ as the source of truth and is verified in tests/desktop.test.mjs.
 *
 * Copied/derived upstream values are attributed to MeteorNOX, Copyright (c) 2026.
 * Upstream reference: MeteorNOX/dsh-whale-widget assets/whale-widget.js.
 */
import { host, useValue, useQuery, STATUSBAR_AREAS } from '@hermes/plugin-sdk'
import { Fragment, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// Original artwork (byte-for-byte). SHA-256 pinned; never redrawn/recolored.
// ---------------------------------------------------------------------------
export const PLUGIN_ID = 'whale-balance-hermes'
export const SOURCE_DEEPSEEK = 'deepseek'
export const SOURCE_CCTQ = 'cctq'
export const SOURCE_NEKO = 'neko'
export const SOURCE_OPTIONS = [
  { id: SOURCE_DEEPSEEK, label: 'DeepSeek' },
  { id: SOURCE_CCTQ, label: 'CCTQ' },
  { id: SOURCE_NEKO, label: 'Neko' }
]
export const CCTQ_UNAVAILABLE = Object.freeze({
  status: 'unavailable', code: 'missing_credentials', currency: 'USD', balance: null, updated_at: null
})
export const NEKO_UNAVAILABLE = Object.freeze({
  status: 'unavailable', code: 'missing_credentials', currency: 'USD', balance: null, updated_at: null
})
export const ARTWORK_SHA256 = 'dcc456613dbb1102a4b7ef636a8b622371e33b763489d6249c434fb54248ba5c'
export const ARTWORK_MIME = 'image/png'
// Artwork payload removed for public distribution: assets/DSniang1.png has no
// license granting redistribution. See README 'Licensing'. Provide your own
// image and set ARTWORK_URI to a data: URL to restore it locally.
export const ARTWORK_BASE64 = ''
export const ARTWORK_URI = ARTWORK_BASE64 ? `data:${ARTWORK_MIME};base64,${ARTWORK_BASE64}` : ''

// ---------------------------------------------------------------------------
// Upstream visual constants (MeteorNOX/dsh-whale-widget, Copyright (c) 2026).
// Classic bubble: aspect 1026/700; same paths, layout, colors as upstream.
// ---------------------------------------------------------------------------
export const BUBBLE_VIEWBOX = '0 0 1026 700'
export const BUBBLE_BIG_D =
  'M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z'
export const BUBBLE_SMALL = [
  { cx: 352, cy: 561, rx: 37.5, ry: 26 },
  { cx: 442, cy: 646, rx: 24.5, ry: 18 }
]
export const BUBBLE_FILL = '#FFFFFF'
export const BUBBLE_STROKE = '#203170'
export const BUBBLE_STROKE_WIDTH = 18
export const TEXT_PRIMARY = '#536ba9'
export const TEXT_HINT = '#9fb0d9'
// Links need to read as interactive against the white bubble without leaving the
// upstream palette.
export const TEXT_LINK = '#203170'

export const IMAGE_WIDTH_PCT = '59.45%'
export const BODY_TRANSFORM_ORIGIN = '50% 100%'
export const BODY_TRANSITION = 'transform .22s cubic-bezier(.34,1.56,.64,1)'
export const SQUISH = 'scaleY(0.88) scaleX(1.05)'
export const PRESS_VISUAL_TAP_MS = 32

export const MIN_SCALE = 0.6
export const MAX_SCALE = 2.5
export const SCALE_STEP = 0.1
export const CLICK_SQ = 9
export const REFRESH_MS = 60000
/** Upstream snap zones (percent of viewport): L/T/R/B edges + F mirror line. */
export const SNAP_ZONES = { L: 10, T: 0, R: 10, B: 15, F: 50 }

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
function performanceNow() {
  try {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  } catch {
    return Date.now()
  }
}

// ---------------------------------------------------------------------------
// Pure geometry — exported for tests and shared with preview.html.
// ---------------------------------------------------------------------------
export function baseSquare(viewport, scale) {
  const s = clamp(Number.isFinite(scale) ? scale : 1.5, MIN_SCALE, MAX_SCALE)
  const minDim = Math.min(
    Number.isFinite(viewport?.width) ? viewport.width : 0,
    Number.isFinite(viewport?.height) ? viewport.height : 0
  )
  // Upstream: clamp(122px, min(250px, min(100vw,100vh) * .28) * scale, 625px).
  return clamp(Math.min(250, Math.max(0, minDim) * 28 / 100) * s, 122, 625)
}

export function scaleToDisplay(s) {
  const n = Number(s)
  if (!Number.isFinite(n)) return 10
  return Math.round((n - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1
}

export function scaleFromDisplay(v) {
  const n = Math.round(Number(v)) || 1
  return MIN_SCALE + clamp(n - 1, 0, 19) * (MAX_SCALE - MIN_SCALE) / 19
}

export function geometry(saved, viewport, opts = {}) {
  const scale = clamp(Number.isFinite(saved?.scale) ? saved.scale : 1.5, MIN_SCALE, MAX_SCALE)
  const size = Math.min(baseSquare(viewport, scale), Math.max(0, viewport.width), Math.max(0, viewport.height))
  const width = size
  const height = size
  const maxX = Math.max(0, viewport.width - width)
  const maxY = Math.max(0, viewport.height - height)
  let x = clamp(Number.isFinite(saved?.x) ? saved.x : maxX, 0, maxX)
  let y = clamp(Number.isFinite(saved?.y) ? saved.y : maxY, 0, maxY)
  if (!opts.free) {
    const hDist = Number.isFinite(saved?.hDist) ? saved.hDist : 0
    const vDist = Number.isFinite(saved?.vDist) ? saved.vDist : 0
    if (saved?.hAnchor === 'right') x = clamp(maxX - hDist, 0, maxX)
    else if (saved?.hAnchor === 'left') x = clamp(hDist, 0, maxX)
    if (saved?.vAnchor === 'bottom') y = clamp(maxY - vDist, 0, maxY)
    else if (saved?.vAnchor === 'top') y = clamp(vDist, 0, maxY)
  }
  let flip = saved?.flip === true
  if (opts.snap) {
    // Same decision points as upstream: horizontal mirror/flip uses the image
    // center, bottom snap uses the image center y, top snap the box center y.
    const iw = Math.max(1, width * 0.5945)
    const cx = flip ? x + iw / 2 : x + width - iw / 2
    const cyImg = y + height - iw / 2
    const cyBox = y + height / 2
    const left = viewport.width * SNAP_ZONES.L / 100
    const right = viewport.width * (100 - SNAP_ZONES.R) / 100
    const top = viewport.height * SNAP_ZONES.T / 100
    const bottom = viewport.height * (100 - SNAP_ZONES.B) / 100
    flip = cx < viewport.width * SNAP_ZONES.F / 100
    if (cx < left) {
      x = 0
      flip = true
    } else if (cx > right) {
      x = maxX
      flip = false
    }
    if (cyBox < top) y = 0
    else if (cyImg > bottom) y = maxY
  }
  const hAnchor = x <= maxX / 2 ? 'left' : 'right'
  const vAnchor = y <= maxY / 2 ? 'top' : 'bottom'
  return {
    x, y, scale, size, width, height, flip, hAnchor, vAnchor,
    hDist: hAnchor === 'left' ? x : maxX - x,
    vDist: vAnchor === 'top' ? y : maxY - y
  }
}

export function resized(position, scale, viewport) {
  const size = baseSquare(viewport, scale)
  return geometry({
    ...position, scale,
    x: position.flip ? position.x : position.x + position.width - size,
    y: position.y + position.height - size
  }, viewport, { free: true })
}

export function presentation(data, failed, now = Date.now()) {
  if (!data) return { amount: '—', hint: failed ? '后端不可用' : '读取中…' }
  const currency = data.currency === 'USD' ? 'USD' : 'CNY'
  const outdated = data.stale || !data.updated_at || now - Date.parse(data.updated_at) >= REFRESH_MS
  const hints = {
    missing_key: '未设置运行环境密钥', missing_credentials: '未启用用量查询配置', provider_auth: '提供商认证失败',
    provider_http: '提供商请求失败', timeout: '请求超时',
    invalid_response: '余额格式异常', request_failed: '余额请求失败',
    provider_unavailable: '账户不可用', zero_unconfirmed: '零值未确认'
  }
  const amount = typeof data.balance === 'string' && /^\d+(\.\d+)?$/.test(data.balance)
    ? `${currency === 'USD' ? '$' : '¥'} ${data.balance}` : '—'
  const hint = failed ? '连接失败 · 旧数据' : hints[data.code] || (outdated ? '旧数据' : '点击鲸鱼刷新')
  return {
    amount,
    hint: outdated && amount !== '—' && !hint.includes('旧数据') ? `${hint} · 旧数据` : hint,
    idle: !failed && !hints[data.code] && !outdated
  }
}

// Original upstream 0.4.2 MP3 bytes, embedded as local data URLs because disk
// plugins are evaluated from blob: URLs and have no resolvable asset base.
// The source files stay byte-for-byte in assets/; tests pin their hashes.
export const SOUND_ASSET_PRESS = ''
export const SOUND_ASSET_RELEASE = ''
export const SOUND_ASSET_D1 = ''
export const SOUND_ASSET_D2 = ''
export const SOUND_ASSET_MINECRAFT = ''
export const SOUND_ASSET_TASK_END = ''

// ---------------------------------------------------------------------------
// Bounded built-in audio. The four original upstream clips embedded above are
// the only sources: no imports, no network, no loadPluginAsset. Two press/
// release groups share one master switch and volume; each event carries an
// independent switch plus a nullable volume that follows the master until it
// is explicitly changed. needs_approval is editable and previewable only — it
// has no runtime delivery, so no approval event is invented.
// ---------------------------------------------------------------------------
export const AUDIO_CONFIG_KEY = 'audioSettings'
export const AUDIO_CONFIG_VERSION = 1
export const AUDIO_VOLUME_MIN = 0
export const AUDIO_VOLUME_MAX = 1
export const AUDIO_GROUP_DUCK = 'duck'
export const AUDIO_GROUP_FX1 = 'fx1'
export const AUDIO_GROUP_IDS = Object.freeze([AUDIO_GROUP_DUCK, AUDIO_GROUP_FX1])
export const AUDIO_GROUPS = Object.freeze([
  { id: AUDIO_GROUP_DUCK, label: '小黄鸭', press: SOUND_ASSET_PRESS, release: SOUND_ASSET_RELEASE },
  { id: AUDIO_GROUP_FX1, label: '音效1', press: SOUND_ASSET_D1, release: SOUND_ASSET_D2 }
])
export const AUDIO_CHOICE_A = 'a'
export const AUDIO_CHOICE_MINECRAFT = 'minecraft'
export const AUDIO_CHOICES = Object.freeze([AUDIO_CHOICE_A, AUDIO_CHOICE_MINECRAFT])
export const AUDIO_CHOICE_LABELS = Object.freeze({ [AUDIO_CHOICE_A]: '音效 A', [AUDIO_CHOICE_MINECRAFT]: 'Minecraft 原版' })
export const AUDIO_CHOICE_URLS = Object.freeze({
  [AUDIO_CHOICE_A]: SOUND_ASSET_TASK_END,
  [AUDIO_CHOICE_MINECRAFT]: SOUND_ASSET_MINECRAFT
})
export const AUDIO_EVENT_IDS = Object.freeze(['task_complete', 'needs_input', 'needs_approval'])
export const AUDIO_RUNTIME_EVENT_IDS = Object.freeze(['task_complete', 'needs_input'])
export const AUDIO_EVENT_LABELS = Object.freeze({ task_complete: '任务完成', needs_input: '需要输入', needs_approval: '需要批准' })
export const AUDIO_EVENT_UNAVAILABLE = Object.freeze({ task_complete: false, needs_input: false, needs_approval: true })
export const DEFAULT_AUDIO_EVENT = Object.freeze({ enabled: false, choice: AUDIO_CHOICE_A, volume: null })
export const DEFAULT_AUDIO_CONFIG = Object.freeze({
  version: AUDIO_CONFIG_VERSION,
  enabled: false,
  volume: 1,
  group: AUDIO_GROUP_DUCK,
  events: Object.freeze({
    task_complete: DEFAULT_AUDIO_EVENT,
    needs_input: DEFAULT_AUDIO_EVENT,
    needs_approval: DEFAULT_AUDIO_EVENT
  })
})
const isVolume = value => value === null || (Number.isFinite(value) && value >= AUDIO_VOLUME_MIN && value <= AUDIO_VOLUME_MAX)
const clampVolume = value => Number.isFinite(value) ? clamp(value, AUDIO_VOLUME_MIN, AUDIO_VOLUME_MAX) : AUDIO_VOLUME_MAX

// The legacy on/off boolean was the only prior audio state, so it maps onto the
// master switch: an existing opt-in stays on, and an absent/false value stays off.
export function migrateAudioConfig(raw, legacySound) {
  if (raw && typeof raw === 'object' && raw.version === AUDIO_CONFIG_VERSION && raw.events && typeof raw.events === 'object') return raw
  return {
    ...DEFAULT_AUDIO_CONFIG,
    enabled: legacySound === true,
    events: { ...DEFAULT_AUDIO_CONFIG.events }
  }
}

export function normalizeAudioConfig(raw, legacySound) {
  const source = migrateAudioConfig(raw, legacySound)
  const events = {}
  for (const id of AUDIO_EVENT_IDS) {
    const item = source.events?.[id] && typeof source.events[id] === 'object' ? source.events[id] : {}
    events[id] = {
      enabled: item.enabled === true,
      choice: AUDIO_CHOICES.includes(item.choice) ? item.choice : AUDIO_CHOICE_A,
      volume: isVolume(item.volume) ? item.volume : null
    }
  }
  return {
    version: AUDIO_CONFIG_VERSION,
    enabled: source.enabled === true,
    volume: clampVolume(source.volume),
    group: AUDIO_GROUP_IDS.includes(source.group) ? source.group : AUDIO_GROUP_DUCK,
    events
  }
}

export function audioGroupUrls(config, groupId) {
  const id = AUDIO_GROUP_IDS.includes(groupId) ? groupId : AUDIO_GROUP_DUCK
  const group = AUDIO_GROUPS.find(item => item.id === id) || AUDIO_GROUPS[0]
  return { press: group.press, release: group.release }
}

export function audioEventUrl(config, eventId) {
  const event = normalizeAudioConfig(config).events[eventId]
  if (!event) return null
  return AUDIO_CHOICE_URLS[event.choice] || AUDIO_CHOICE_URLS[AUDIO_CHOICE_A]
}

// A null event volume is never materialized on save: it means "follow the master
// volume" until the user sets an explicit value (including an explicit zero).
export function audioEventVolume(config, eventId) {
  const normalized = normalizeAudioConfig(config)
  const event = normalized.events[eventId]
  return event && event.volume !== null ? event.volume : normalized.volume
}

function withAudioEvent(draft, id, patch) {
  return normalizeAudioConfig({
    ...draft,
    events: { ...draft.events, [id]: { ...draft.events[id], ...patch } }
  })
}

// ---------------------------------------------------------------------------
// Versioned event profiles keep editable modules separate from balance presentation.
// Backend amount and status hints remain authoritative in every rendered profile.
// label text, the amount's *prefix* (never its value) and the idle hint. Error,
// stale, zero-value and unavailable hints stay authoritative, so an override can
// never mask a real state or invent a balance. Empty values mean "upstream".
// ---------------------------------------------------------------------------
export const BUBBLE_CONFIG_KEY = 'bubbleText'
export const BUBBLE_CONFIG_VERSION = 1
export const BUBBLE_CONFIG_MAX_BYTES = 24576
export const BUBBLE_MODULE_MAX = 24
export const BUBBLE_TEXT_MAX = 512
export const BUBBLE_IMAGE_MAX = 12000
// The bubble's text box is 64% of the 700-unit viewBox, i.e. 448 units tall, and
// it does not clip (no ancestor sets overflow), so anything taller is drawn
// outside the white bubble and, because the box sits above the bubble's centre,
// mostly above the top of the viewport. Measured in Chrome: 3 extra rows fit
// exactly, the 4th overflows by 6.4% and 6 extra rows by 28.1%. Past 4 extra rows
// the shrink needed to fit becomes unreadable, so the cap and the auto-shrink
// below are both load-bearing -- see notes/whale-bubble-overflow-measurement.md.
export const BUBBLE_TEXT_AVAIL = 448
export const BUBBLE_MAX_EXTRA_ROWS = 4
// Row-type modules (everything the BubbleText renderer puts on its own line).
export const BUBBLE_ROW_TYPES = Object.freeze(['used', 'cost', 'session', 'bonus', 'recharge', 'random', 'randomImage'])

// Analytic content height in viewBox units: the three fixed slots (label, amount,
// hint) plus one line per extra row. Verified against real measurements to within
// 0.3 units, so the fit can be computed without a DOM measurement pass.
export function bubbleTextContentHeight(extraRows = 0) {
  const fixed = 66 * 1.15 + 128 * 1.05 + 56 * 1.15 + 9
  const row = 44 * 1.1
  const n = Math.max(0, Math.floor(Number(extraRows) || 0))
  return fixed + row * n
}

// Scale everything down just enough to keep the text inside the bubble. Capped at
// 1 so ordinary content is never enlarged, and floored so a runaway config cannot
// shrink the text into nothing.
export function bubbleTextScale(extraRows = 0) {
  const need = bubbleTextContentHeight(extraRows)
  if (!Number.isFinite(need) || need <= BUBBLE_TEXT_AVAIL) return 1
  return Math.max(0.55, BUBBLE_TEXT_AVAIL / need)
}

// One child's size expression. The fit is folded into the multiplier rather than
// written as an override of --dshw-u on the container: a custom property that
// references itself resolves to invalid at computed-value time and every
// dependent font-size silently falls back to 16px (verified in Chrome).
export function bubbleTextSize(units, fit = 1) {
  const factor = Number.isFinite(fit) && fit !== 1 ? `(${units} * ${fit})` : units
  return `calc(var(--dshw-u) * ${factor})`
}
export const EVENT_PROFILES = Object.freeze([
  { id: 'idle', label: '空闲' },
  { id: 'refresh_success', label: '刷新成功' },
  { id: 'balance_changed', label: '余额变化' },
  { id: 'task_complete', label: '任务完成' },
  { id: 'needs_input', label: '需要输入' },
  { id: 'needs_approval', label: '需要批准' }
])
export const BUBBLE_MODULE_TYPES = Object.freeze(['text', 'balance', 'hint', 'used', 'cost', 'session', 'image', 'bonus', 'recharge', 'link', 'random', 'randomImage'])
export const BUBBLE_MODULE_LABELS = Object.freeze({
  text: '文本',
  balance: '余额前缀',
  hint: '提示语',
  used: '今日已用',
  cost: '本轮花费',
  session: '对话名',
  image: '图片',
  bonus: '赠金',
  recharge: '充值余额',
  link: '超链接',
  random: '随机语句',
  randomImage: '随机图片'
})
export const DEFAULT_BUBBLE_CONFIG = Object.freeze({ version: BUBBLE_CONFIG_VERSION, profiles: {} })

// Built-in bubble pictures. The desktop half cannot read its own assets (the
// host's asset door is hard-wired to two mp3s), so these are fetched from the
// plugin's Python half as data URLs and cached in memory for the session. The
// ids are what the backend's allowlist keys on -- never a path.
export const BUBBLE_GALLERY = Object.freeze([
  { id: 'petpet', label: 'petpet' },
  { id: 'money1', label: 'money1' }
])
const PROFILE_IDS = EVENT_PROFILES.map(profile => profile.id)
const VARIABLE_NAMES = new Set(['balance', 'used', 'cost', 'session', 'source', 'bonus', 'recharge'])
const SEEN_EVENT_LIMIT = 512
const isImageDataUrl = value => typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)

// Session-scoped cache for built-in gallery pictures: the data URL lives in
// memory only, never in the stored config. A config entry holds `asset:<id>`
// (a dozen bytes) and the picture is re-fetched once per app run, so a 3.6 MB
// gif can never be what fills localStorage.
const galleryCache = new Map()

export const BUBBLE_ASSET_PREFIX = 'asset:'

// Dropping the cache is the only way to re-read a picture from disk after it
// changes: the fetch is memoised for the session, so a stale gif would otherwise
// survive until the app restarts.
export function clearBubbleImageCache() {
  galleryCache.clear()
}

// Turns a stored `src` into something an <img> can display. Inline data URLs
// (small user-picked files) pass the old validation; `asset:` refs resolve
// through the session cache; anything else is empty, which the renderer treats
// as "this module cannot render".
export function resolveBubbleImage(src) {
  if (typeof src !== 'string' || !src) return ''
  if (src.startsWith(BUBBLE_ASSET_PREFIX)) return galleryCache.get(src.slice(BUBBLE_ASSET_PREFIX.length)) || ''
  return isImageDataUrl(src) ? src : ''
}

export async function loadBubbleImage(ctx, assetId) {
  const known = BUBBLE_GALLERY.some(item => item.id === assetId)
  if (!known || !ctx?.rest) return ''
  if (galleryCache.has(assetId)) return galleryCache.get(assetId)
  try {
    const result = await ctx.rest(`/bubble-image/${assetId}`)
    // Only accept what the renderer can actually display; a missing backend, a
    // rejected id or a corrupt file must degrade to "no picture", not a broken
    // <img> with a data: URL that fails to decode.
    const dataUrl = result && result.ok && isImageDataUrl(result.data_url) ? result.data_url : ''
    if (dataUrl) galleryCache.set(assetId, dataUrl)
    return dataUrl
  } catch {
    return ''
  }
}
const boundedText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, BUBBLE_TEXT_MAX) : ''

// A link module's target must be a plain web URL. The value ends up in
// ctx.os.openExternal, which hands it to the OS shell, so anything but http(s)
// is rejected outright rather than sanitised: javascript:, file:, and custom
// schemes are all ways to turn a bubble label into code execution or a local
// file probe.
export function safeBubbleHref(value) {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (!raw || raw.length > 2048) return ''
  // No separate whitespace/control-character scan: the hostname pattern below is
  // anchored and does not admit any of them, so a second check would be dead code
  // that no test can distinguish. Verified in isolation before removing it.
  const match = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(raw)
  if (!match) return ''
  const scheme = match[1].toLowerCase()
  const authority = match[2]
  // The hostname pattern below already refuses any authority carrying `user:pass@`
  // (an `@` cannot appear in a valid dotted host), so it is not stripped here --
  // one check, one place.
  const hostPort = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::(\d{1,5}))?$/i
  if (!hostPort.test(authority)) return ''
  return `${scheme}://${authority}${match[3]}`
}

export function migrateBubbleConfig(raw) {
  if (raw && typeof raw === 'object' && raw.version === BUBBLE_CONFIG_VERSION && raw.profiles && typeof raw.profiles === 'object') return raw
  const source = raw && typeof raw === 'object' ? raw : {}
  const modules = []
  if (typeof source.label === 'string' && source.label.trim()) modules.push({ type: 'text', enabled: true, weight: 1, text: source.label, src: '' })
  if (typeof source.amountPrefix === 'string' && source.amountPrefix.trim()) modules.push({ type: 'balance', enabled: true, weight: 1, text: source.amountPrefix, src: '' })
  if (typeof source.hint === 'string' && source.hint.trim()) modules.push({ type: 'hint', enabled: true, weight: 1, text: source.hint, src: '' })
  return { version: BUBBLE_CONFIG_VERSION, profiles: modules.length ? { idle: modules } : {} }
}

export function guardBubbleConfigSize(config, maxBytes = BUBBLE_CONFIG_MAX_BYTES) {
  let result = config && typeof config === 'object' ? JSON.parse(JSON.stringify(config)) : { version: BUBBLE_CONFIG_VERSION, profiles: {} }
  const byteLength = value => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length
  while (byteLength(JSON.stringify(result)) > maxBytes) {
    const profiles = result?.profiles
    if (!profiles || typeof profiles !== 'object') return { version: BUBBLE_CONFIG_VERSION, profiles: {} }
    let removed = false
    for (const id of [...PROFILE_IDS].reverse()) {
      if (Array.isArray(profiles[id]) && profiles[id].length) {
        profiles[id].pop()
        removed = true
        break
      }
    }
    if (!removed) return { version: BUBBLE_CONFIG_VERSION, profiles: {} }
  }
  return result
}

// A stored image `src` is either a small inline data URL (user-picked file) or a
// `asset:<id>` reference to a built-in picture. Anything else -- a foreign
// scheme, an oversized blob, a missing id -- normalises to '' so the renderer
// drops the module instead of showing a broken image.
export function normalizeBubbleSrc(value) {
  if (typeof value !== 'string') return ''
  if (value.startsWith(BUBBLE_ASSET_PREFIX)) {
    const id = value.slice(BUBBLE_ASSET_PREFIX.length)
    return BUBBLE_GALLERY.some(item => item.id === id) ? value : ''
  }
  return isImageDataUrl(value) && value.length <= BUBBLE_IMAGE_MAX ? value : ''
}

export function normalizeBubbleConfig(raw) {
  const source = migrateBubbleConfig(raw)
  const profiles = {}
  for (const id of PROFILE_IDS) {
    const modules = Array.isArray(source.profiles?.[id]) ? source.profiles[id].slice(0, BUBBLE_MODULE_MAX) : []
    profiles[id] = modules.map(module => {
      const item = module && typeof module === 'object' ? module : {}
      const type = BUBBLE_MODULE_TYPES.includes(item.type) ? item.type : 'text'
      const src = (type === 'image' || type === 'randomImage') ? normalizeBubbleSrc(item.src) : ''
      const href = type === 'link' ? safeBubbleHref(item.href) : ''
      return { type, enabled: item.enabled !== false, weight: Number.isFinite(item.weight) && item.weight > 0 ? Math.min(100, item.weight) : 1, text: boundedText(item.text), src, href }
    })
  }
  return guardBubbleConfigSize({ version: BUBBLE_CONFIG_VERSION, profiles })
}

export function resolveBubbleVariables(text, values = {}) {
  if (typeof text !== 'string') return ''
  return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (token, name) => {
    if (!VARIABLE_NAMES.has(name)) return token
    const value = values?.[name]
    return value === null || value === undefined ? token : String(value)
  })
}

export function chooseWeightedModule(modules, randomValue = Math.random()) {
  if (!Array.isArray(modules)) return null
  const choices = modules.filter(module => module?.enabled !== false && Number.isFinite(module?.weight) && module.weight > 0)
  const total = choices.reduce((sum, module) => sum + module.weight, 0)
  if (!total) return null
  let threshold = Math.max(0, Math.min(0.999999999999, Number.isFinite(randomValue) ? randomValue : 0)) * total
  for (const module of choices) {
    threshold -= module.weight
    if (threshold < 0) return module
  }
  return choices[choices.length - 1]
}

export function renderBubbleModules(config, eventName, values = {}, randomValue = Math.random()) {
  const normalized = normalizeBubbleConfig(config)
  if (!PROFILE_IDS.includes(eventName)) return []
  const modules = normalized.profiles[eventName].length ? normalized.profiles[eventName] : normalized.profiles.idle
  // An image module with an unusable src is not a candidate: it must neither win
  // a weighted slot nor blank out a valid sibling. `asset:` refs count as usable
  // once their picture is in the session cache -- before that they are not yet
  // renderable, so they simply lose the draw instead of drawing an empty box.
  const renderable = module => module.enabled && ((module.type !== 'image' && module.type !== 'randomImage') || Boolean(resolveBubbleImage(module.src)))
  const types = [...new Set(modules.filter(renderable).map(module => module.type))]
  const rendered = types.flatMap(type => {
    const candidates = modules.filter(item => item.type === type && renderable(item))
    // Per-type there is exactly one slot, drawn weighted from every candidate of
    // that type. That is already what a "random sentence" needs: list several
    // `random` modules and one is drawn per render. `random` is a *distinct type*
    // from `text` precisely so a fixed label and a random line can coexist -- if
    // they shared the `text` type they would compete for the same single slot,
    // which is the behaviour the previous version had and users could not use.
    const module = chooseWeightedModule(candidates, randomValue)
    if (!module) return []
    // A random image whose src failed validation must never be the one drawn, so
    // it is filtered as a candidate rather than rejected after the draw.
    if (type === 'image' || type === 'randomImage') return [{ type, src: resolveBubbleImage(module.src) }]
    if (type === 'link') {
      // An unusable href is not a link: falling back to plain text keeps the
      // label readable instead of rendering a dead anchor.
      const href = safeBubbleHref(module.href)
      if (href) return [{ type, text: resolveBubbleVariables(module.text || '', values), href }]
      return [renderText('text', module, values)]
    }
    return [renderText(type, module, values)]
  })
  // The cap is enforced here, not only in the editor: a stored config could
  // predate the cap or be hand-edited, and the bubble cannot grow to fit it.
  return capBubbleRows(rendered)
}

function renderText(type, module, values) {
  const fallback = type === 'balance' || type === 'hint' ? '' : `{${type}}`
  return { type, text: resolveBubbleVariables(module.text || fallback, values) }
}

// Kept separate from the renderer so the cap itself is testable without needing
// more row types than exist today (only three exist, so a four-slot renderer can
// never trip it in production yet).
export function capBubbleRows(modules) {
  const rows = modules.filter(module => BUBBLE_ROW_TYPES.includes(module.type))
  if (rows.length <= BUBBLE_MAX_EXTRA_ROWS) return modules
  const allowed = new Set(rows.slice(0, BUBBLE_MAX_EXTRA_ROWS))
  return modules.filter(module => !BUBBLE_ROW_TYPES.includes(module.type) || allowed.has(module))
}

export function renderBubbleEvent(config, eventName, values = {}, randomValue = Math.random()) {
  if (eventName === 'needs_approval') return null
  return renderBubbleModules(config, eventName, values, randomValue)[0] || null
}

// Balance prefixes and hints were always read from the idle profile, so a
// profile that does not define its own still inherits the idle one. Labels are
// event-scoped instead: an event profile without a text module keeps the plain
// "<source> 余额" fallback, exactly as before.
function firstRenderedModule(config, eventName, type, values, randomValue) {
  const find = profile => renderBubbleModules(config, profile, values, randomValue).find(module => module.type === type)
  return find(eventName) || (eventName === 'idle' ? null : find('idle')) || null
}

export function bubbleLabel(config, sourceLabel, eventName = 'idle', values = {}, randomValue = Math.random()) {
  const module = renderBubbleModules(config, eventName, values, randomValue).find(item => item.type === 'text')
  return module ? module.text : `${sourceLabel} 余额`
}

export function bubbleAmount(config, amount, eventName = 'idle', values = {}, randomValue = Math.random()) {
  const prefix = firstRenderedModule(config, eventName, 'balance', values, randomValue)?.text
  if (!prefix || typeof amount !== 'string') return amount
  const currencyPrefix = amount.startsWith('¥ ') ? '¥ ' : amount.startsWith('$ ') ? '$ ' : null
  if (!currencyPrefix) return amount
  const value = amount.slice(currencyPrefix.length)
  return /^\d+(\.\d+)?$/.test(value) ? `${prefix} ${value}` : amount
}

export function bubbleHint(config, display, fetching, eventName = 'idle', values = {}, randomValue = Math.random()) {
  if (fetching) return '读取中…'
  if (!display.idle) return display.hint
  const hint = firstRenderedModule(config, eventName, 'hint', values, randomValue)?.text
  return hint || display.hint
}

// ---------------------------------------------------------------------------
// Presentation components. All style values are the upstream originals (colors,
// layout, aspect, spring) written as inline styles because a disk plugin has no
// stylesheet channel; class names are kept for parity and test hooks.
// ---------------------------------------------------------------------------
function BubbleShape({ flip, shown }) {
  const shapeStyle = visible => ({
    opacity: visible ? 1 : 0,
    transform: visible ? 'none' : 'scale(.7)',
    transformBox: 'fill-box',
    transformOrigin: '50% 50%',
    transition: 'opacity .2s ease,transform .2s ease'
  })
  const ellipse = (id, small, delayOpen, delayClose) => jsx('ellipse', {
    className: id,
    cx: small.cx, cy: small.cy, rx: small.rx, ry: small.ry,
    fill: BUBBLE_FILL, stroke: BUBBLE_STROKE, strokeWidth: BUBBLE_STROKE_WIDTH,
    style: { ...shapeStyle(shown), transitionDelay: shown ? delayOpen : delayClose }
  })
  return jsxs('div', {
    className: 'dshwv-shapewrap',
    style: {
      position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
      pointerEvents: 'none'
    },
    children: [
      jsxs('svg', {
        viewBox: BUBBLE_VIEWBOX, preserveAspectRatio: 'xMidYMid meet',
        style: {
          display: 'block', width: '100%', height: '100%', pointerEvents: 'none',
          background: 'transparent', border: 0, borderRadius: 0
        },
        children: [
          jsx('path', {
            className: 'dshwv-bshape',
            fill: BUBBLE_FILL, stroke: BUBBLE_STROKE, strokeWidth: BUBBLE_STROKE_WIDTH,
            strokeLinejoin: 'round', strokeLinecap: 'round', d: BUBBLE_BIG_D,
            style: { ...shapeStyle(shown), transitionDelay: shown ? '.26s' : '.1s' }
          }),
          ellipse('dshwv-b1', BUBBLE_SMALL[0], '.13s', '.2s'),
          ellipse('dshwv-b2', BUBBLE_SMALL[1], '0s', '.3s')
        ]
      })
    ]
  })
}

function BubbleText({ label, amount, hint, rows = [], flip, shown, onOpenLink }) {
  // Rows multiply the height but the bubble cannot grow, so the whole block
  // shrinks to fit instead of spilling past the white shape (measurements in
  // notes/whale-bubble-overflow-measurement.md). Scaling is computed, not
  // measured, so it is stable across renders and testable.
  const extraRows = Array.isArray(rows) ? rows.length : 0
  const fit = bubbleTextScale(extraRows)
  const cramped = fit < 1
  // The fit must be folded into each child's multiplier, not written as an
  // override of --dshw-u on this element: a custom property that references
  // itself resolves to invalid at computed-value time, and every dependent
  // font-size then silently falls back to 16px. `sized(n)` keeps one place for
  // that arithmetic. overflow:hidden is a backstop so a wrong estimate clips
  // inside the bubble instead of painting over the whale.
  const sized = units => bubbleTextSize(units, fit)
  return jsxs('div', {
    className: 'dshwv-text',
    style: {
      position: 'absolute', left: 'var(--dshw-vx,44.25%)', top: 'var(--dshw-vy,36%)', width: '66%', height: '64%',
      transform: `translate(-50%,-50%)${flip ? ' scaleX(-1)' : ''}`,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      // Centring splits any surplus above AND below the box; the box sits above
      // the bubble's middle, so the upper half lands off-screen. Once the block
      // is too tall, anchor to the top and let the shrink do the work.
      justifyContent: cramped ? 'flex-start' : 'center',
      textAlign: 'center', color: TEXT_PRIMARY, lineHeight: 1.15,
      whiteSpace: 'nowrap', overflow: 'hidden',
      pointerEvents: 'none',
      opacity: shown ? 1 : 0,
      transition: `opacity .16s ease${shown ? ' .36s' : ''},transform .3s ease`
    },
    children: [
      jsx('div', {
        className: 'dshwv-label',
        style: { fontSize: sized(66), fontWeight: 600, letterSpacing: '.06em' },
        children: label
      }),
      jsx('div', {
        className: 'dshwv-amount',
        style: { fontSize: sized(128), fontWeight: 800, lineHeight: 1.05 },
        children: amount
      }),
      jsx('div', {
        className: 'dshwv-hint',
        style: {
          fontSize: sized(56), color: TEXT_HINT, letterSpacing: '.02em',
          marginTop: sized(9), minHeight: sized(64), lineHeight: 1.15
        },
        children: hint
      }),
      ...rows.map(row => row.type === 'link'
        ? jsx('div', {
          className: 'dshwv-module-link',
          style: { fontSize: sized(44), lineHeight: 1.1 },
          children: jsx('a', {
            href: row.href, title: row.href,
            // The bubble is pointerEvents:none so it never blocks the app; a
            // link has to opt back in to stay clickable.
            style: { color: TEXT_LINK, textDecoration: 'underline', pointerEvents: 'auto', cursor: 'pointer' },
            onClick: event => {
              // Never let the renderer navigate: the whole point of going through
              // the host is that the URL opens in the user's browser, outside the
              // app, so a bubble can't navigate the desktop client away.
              event.preventDefault()
              event.stopPropagation()
              if (typeof onOpenLink === 'function') onOpenLink(row.href)
            },
            children: row.text
          })
        })
        : jsx('div', {
          className: `dshwv-module-${row.type}`,
          style: { fontSize: sized(44), lineHeight: 1.1 },
          children: row.text
        }))
    ]
  })
}

// Minimal bubble-content editor. Hook-free: the draft lives in the widget so
// cancel/save stay single-writer. The preview reuses the very same
// BubbleShape/BubbleText renderers and the live balance string, so the preview
// cannot drift from the widget.
function BubbleEditor({ draft, profile, onProfile, display, fetching, values, onPatch, onAdd, onDelete, onMove, onCancel, onSave, onReset, saveError, onPickGallery, galleryBusy, galleryError }) {
  const modules = draft.profiles[profile] || []
  const options = EVENT_PROFILES.map(item => jsx('option', { value: item.id, children: item.label }))
  const rows = modules.map((module, index) => jsxs('fieldset', { className: 'dshwv-editor-module', children: [
    jsx('input', { type: 'checkbox', checked: module.enabled, 'aria-label': '启用模块', onChange: e => onPatch(index, 'enabled', e.target.checked) }),
    jsx('select', { 'aria-label': '模块类型', value: module.type, onChange: e => onPatch(index, 'type', e.target.value), children: BUBBLE_MODULE_TYPES.map(type => jsx('option', { value: type, children: BUBBLE_MODULE_LABELS[type] || type })) }),
    jsx('input', { type: 'number', min: '0.01', max: '100', value: module.weight, 'aria-label': '模块权重', onChange: e => onPatch(index, 'weight', Number(e.target.value)) }),
    module.type === 'image' || module.type === 'randomImage' ? jsxs('div', { children: [
      // Built-in pictures come from the plugin's own backend (the desktop half
      // cannot read assets), so they are offered as one-click picks next to the
      // file picker rather than as files on disk.
      jsxs('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }, children: [
        ...BUBBLE_GALLERY.map(item => jsx('button', {
          type: 'button',
          className: 'dshwv-gallery-pick',
          'data-asset': item.id,
          title: `使用内置图 ${item.label}`,
          onClick: event => { event?.stopPropagation?.(); return onPickGallery(index, item.id) },
          children: item.label
        })),
        galleryBusy ? jsx('span', { style: { fontSize: 11, color: TEXT_HINT }, children: '读取中…' }) : null,
        galleryError ? jsx('span', { style: { fontSize: 11, color: '#c0392b' }, children: '图库读取失败' }) : null
      ] }),
      jsx('input', { type: 'file', accept: 'image/*', 'aria-label': '选择本地图片', onChange: e => {
        const file = e.target.files?.[0]; if (!file || file.size > BUBBLE_IMAGE_MAX) return
        const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string' && isImageDataUrl(reader.result) && reader.result.length <= BUBBLE_IMAGE_MAX) onPatch(index, 'src', reader.result) }; reader.readAsDataURL(file)
      } }), resolveBubbleImage(module.src) ? jsx('img', { src: resolveBubbleImage(module.src), alt: '模块图片预览', style: { maxWidth: 80, maxHeight: 50 } }) : null
    ] }) : module.type === 'link' ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }, children: [
      jsx('textarea', { value: module.text, maxLength: BUBBLE_TEXT_MAX, 'aria-label': '链接文字', onChange: e => onPatch(index, 'text', e.target.value) }),
      jsx('input', {
        type: 'url', value: module.href, placeholder: 'https://…', 'aria-label': '链接地址',
        style: module.href ? undefined : { borderColor: '#c0392b' },
        onChange: e => onPatch(index, 'href', e.target.value)
      }),
      // A rejected href renders as plain text, so say so here instead of leaving
      // the user wondering why the line is not clickable.
      module.href ? null : jsx('span', { style: { fontSize: 11, color: '#c0392b' }, children: '需要一个 http(s) 地址' })
    ] }) : jsx('textarea', { value: module.text, maxLength: BUBBLE_TEXT_MAX, 'aria-label': '模块文本', onChange: e => onPatch(index, 'text', e.target.value) }),
    jsx('button', { type: 'button', 'aria-label': '复制模块', onClick: () => onAdd(index), children: '复制' }),
    jsx('button', { type: 'button', 'aria-label': '上移模块', disabled: index === 0, onClick: () => onMove(index, -1), children: '↑' }),
    jsx('button', { type: 'button', 'aria-label': '下移模块', disabled: index === modules.length - 1, onClick: () => onMove(index, 1), children: '↓' }),
    jsx('button', { type: 'button', 'aria-label': '删除模块', onClick: () => onDelete(index), children: '删除' })
  ] }))
  const preview = renderBubbleEvent(draft, profile, values, 0)
  const variableText = preview?.type === 'text' ? preview.text : preview?.type && preview.type !== 'image' ? values[preview.type] ?? '—' : ''
  const active = EVENT_PROFILES.find(item => item.id === profile)
  const style = { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 360, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflow: 'auto', background: '#fff', border: '1px solid #203170', borderRadius: 10, padding: 12, zIndex: 10001, pointerEvents: 'auto', color: '#203170' }
  return jsxs('div', { className: 'dshwv-editor', role: 'dialog', 'aria-modal': true, 'aria-label': '编辑气泡事件模块', tabIndex: -1, style, onKeyDown: e => { if (e.key === 'Escape') onCancel() }, children: [
    jsx('div', { children: '编辑气泡事件' }),
    jsx('select', { className: 'dshwv-editor-profile', 'aria-label': '事件配置', value: profile, onChange: e => onProfile(e.target.value), children: options }),
    jsxs('div', { className: 'dshwv-editor-preview', style: { position: 'relative', width: '100%', aspectRatio: '1026 / 700', pointerEvents: 'none', '--dshw-u': '0.248px' }, children: [
      jsx(BubbleShape, { flip: false, shown: true }),
      jsx(BubbleText, { label: variableText || active?.label || '', amount: display.amount, hint: fetching ? '读取中…' : display.hint, flip: false, shown: true }),
      preview?.type === 'image' ? jsx('img', { src: preview.src, alt: '', style: { position: 'absolute', maxWidth: '25%', maxHeight: '25%', left: '38%', top: '35%' } }) : null
    ] }),
    jsx('div', { children: rows }),
    jsx('button', { type: 'button', 'aria-label': '添加模块', disabled: modules.length >= BUBBLE_MODULE_MAX, onClick: () => onAdd(), children: '添加模块' }),
    jsxs('div', { children: [
      jsx('button', { className: 'dshwv-editor-reset', type: 'button', onClick: onReset, children: '重置' }),
      jsx('button', { className: 'dshwv-editor-cancel', type: 'button', onClick: onCancel, children: '取消' }),
      jsx('button', { className: 'dshwv-editor-save', type: 'button', onClick: onSave, children: '保存' })
    ] }),
    // Appended last, and only on failure, so the dialog keeps its child order
    // (and every existing child index) when a save succeeds.
    saveError ? jsx('div', {
      className: 'dshwv-editor-error', role: 'alert',
      style: { marginTop: 8, padding: '6px 8px', border: '1px solid #c0392b', borderRadius: 6, background: '#fdecea', color: '#c0392b', fontSize: 12 },
      children: '保存失败：配置没有写入本机存储（通常是浏览器存储空间已满）。请删掉一些图片模块或换更小的图片后重试。'
    }) : null
  ] })
}
// Draft-based audio settings. Nothing reaches storage until Save; close, cancel
// and reset only touch the draft. Every preview is created synchronously inside
// its click handler and reuses a single preview slot, so a selection change can
// never leave an earlier clip running.
// ---------------------------------------------------------------------------
// 小鲸鱼记账（本机模型费用）
// Peak/off-peak windows, the pricing table and the day splitting all live in
// dashboard/ledger.py; this panel renders what /ledger returns and never
// recomputes money, so the number on screen is the number the backend priced.
// ---------------------------------------------------------------------------
export const LEDGER_DAYS_DEFAULT = 7
export const LEDGER_DAYS_OPTIONS = [1, 7, 30, 365]

const cny = value => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `¥${n.toFixed(2)}`
}

const cnyPrecise = value => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  // Sub-cent spend is common on cheap models; two decimals would show ¥0.00
  // for a real cost, so anything under a cent keeps four.
  return n !== 0 && Math.abs(n) < 0.01 ? `¥${n.toFixed(4)}` : `¥${n.toFixed(2)}`
}

const tokenCount = value => {
  const n = Number(value) || 0
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function LedgerPanel({ data, error, days, onDays, onRefresh, onClose, fetching }) {
  const panelStyle = {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    width: 360, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflow: 'auto',
    boxSizing: 'border-box', background: 'var(--ui-bg-elevated, var(--ui-bg, #fff))',
    border: '1px solid var(--ui-stroke-secondary, rgba(32,49,112,.4))', borderRadius: 10, padding: 12,
    zIndex: 10002, pointerEvents: 'auto', color: 'var(--ui-text-primary, #203170)',
    colorScheme: 'light', boxShadow: '0 6px 18px rgba(0,0,0,.18)'
  }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 12, flexWrap: 'wrap' }
  const btnStyle = {
    border: '1px solid var(--ui-stroke-secondary, rgba(32,49,112,.4))', borderRadius: 6,
    background: 'var(--ui-bg-hover, rgba(32,49,112,.08))', color: 'var(--ui-text-primary, #203170)',
    fontSize: 12, padding: '3px 8px', cursor: 'pointer'
  }
  const headStyle = { ...rowStyle, justifyContent: 'space-between', marginBottom: 8 }
  const mutedStyle = { opacity: .62, fontSize: 11 }
  const cardStyle = {
    border: '1px solid var(--ui-stroke-secondary, rgba(32,49,112,.22))', borderRadius: 8,
    padding: '7px 9px', margin: '6px 0', fontSize: 12
  }
  const bigStyle = { fontSize: 20, fontWeight: 600, letterSpacing: '.2px' }
  const barTrack = { height: 5, borderRadius: 3, background: 'rgba(32,49,112,.14)', overflow: 'hidden', marginTop: 4 }
  const barFill = pct => ({
    height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: 'var(--ui-accent, #203170)'
  })

  const status = data?.status
  const totals = data?.totals || {}
  const windowTotals = data?.window?.totals || {}
  const byDay = (data?.window?.by_day || data?.by_day || [])
  const byModel = data?.by_model || []
  const priced = byModel.filter(m => m.priced)
  const unpriced = byModel.filter(m => !m.priced)
  const peakNow = data?.peak_now === true
  const spend = Number(totals.cost_cny) || 0
  const peakSpend = Number(totals.peak_cost_cny) || 0
  const peakShare = spend > 0 ? (peakSpend / spend) * 100 : 0
  const modelMax = priced.reduce((max, m) => Math.max(max, Number(m.cost_cny) || 0), 0)

  const countdown = () => {
    const next = data?.next_boundary
    if (!next) return ''
    const ms = new Date(next).getTime() - Date.now()
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const mins = Math.floor(ms / 60000)
    const h = Math.floor(mins / 60), m = mins % 60
    return `${peakNow ? '谷价还有' : '峰价还有'} ${h > 0 ? `${h} 小时 ` : ''}${m} 分`
  }

  const dayRow = day => jsxs('div', {
    className: 'dshwv-ledger-day', style: { ...cardStyle, margin: '4px 0' },
    children: [
      jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 }, children: [
        jsx('span', { children: day.day }),
        jsx('span', { style: { fontVariantNumeric: 'tabular-nums' }, children: cnyPrecise(day.cost_cny) })
      ] }),
      jsxs('div', { style: mutedStyle, children: [
        `入 ${tokenCount(day.input_tokens)} · 缓存 ${tokenCount(day.cache_read_tokens)}`,
        ` · 出 ${tokenCount(day.output_tokens)} · ${day.api_calls} 次`
      ] }),
      Number(day.peak_cost_cny) > 0 && jsx('div', {
        style: { ...mutedStyle, color: '#b4530a' },
        children: `其中峰价 ${cnyPrecise(day.peak_cost_cny)}`
      })
    ]
  })

  const modelRow = model => jsxs('div', {
    className: 'dshwv-ledger-model', style: { margin: '5px 0', fontSize: 12 },
    children: [
      jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 }, children: [
        jsxs('span', { children: [
          model.model,
          model.price_source === 'estimate' && jsx('span', { className: 'dshwv-ledger-estimate', style: mutedStyle, children: ' · 估算价' }),
          model.price_source === 'public-list' && jsx('span', { className: 'dshwv-ledger-reference', style: mutedStyle, children: ' · 参考价' })
        ] }),
        jsx('span', { style: { fontVariantNumeric: 'tabular-nums' }, children: cnyPrecise(model.cost_cny) })
      ] }),
      jsx('div', { style: barTrack, children: jsx('div', {
        style: barFill(modelMax > 0 ? (Number(model.cost_cny) / modelMax) * 100 : 0)
      }) })
    ]
  })

  return jsxs('div', {
    className: 'dshwv-ledger-panel', style: panelStyle,
    'aria-label': '小鲸鱼记账',
    children: [
      jsxs('div', { style: headStyle, children: [
        jsx('strong', { children: '小鲸鱼记账' }),
        jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
          jsx('button', {
            type: 'button', className: 'dshwv-ledger-refresh', style: btnStyle,
            title: '重新读取本机用量', disabled: fetching,
            onClick: () => onRefresh(), children: fetching ? '刷新中' : '刷新'
          }),
          jsx('button', {
            type: 'button', className: 'dshwv-ledger-close', style: btnStyle,
            onClick: () => onClose(), children: '关闭'
          })
        ] })
      ] }),

      (error || status === 'degraded') && jsxs('div', {
        style: { ...cardStyle, borderColor: '#c98', color: '#8a3b12' },
        children: [
          jsx('div', { children: '读不到本机用量记录' }),
          jsx('div', { style: mutedStyle, children: `原因：${error || data?.code || 'unknown'}` })
        ]
      }),

      status === 'ok' && jsxs(Fragment, { children: [
        jsx('div', { style: cardStyle, children: jsxs('div', { children: [
          jsx('div', { style: mutedStyle, children: '全部记录（本机模型费用）' }),
          jsx('div', { style: bigStyle, children: cny(spend) }),
          jsxs('div', { style: { ...mutedStyle, marginTop: 3 }, children: [
            `峰价占 ${peakShare.toFixed(0)}% · ${cnyPrecise(peakSpend)} 峰 / ${cnyPrecise(totals.off_peak_cost_cny)} 谷`
          ] })
        ] }) }),

        jsxs('div', { style: { ...cardStyle, display: 'flex', justifyContent: 'space-between', gap: 8 }, children: [
          jsxs('div', { children: [
            jsx('div', { style: mutedStyle, children: peakNow ? '现在是峰价（2×）' : '现在是谷价' }),
            jsx('div', { style: { marginTop: 2 }, children: countdown() || '—' })
          ] }),
          jsx('div', {
            style: {
              alignSelf: 'center', fontSize: 11, padding: '2px 7px', borderRadius: 10,
              border: '1px solid ' + (peakNow ? '#b4530a' : 'rgba(32,49,112,.3)'),
              color: peakNow ? '#b4530a' : 'inherit'
            },
            children: peakNow ? '峰' : '谷'
          })
        ] }),

        jsxs('div', { style: rowStyle, children: [
          jsx('span', { children: '范围' }),
          ...LEDGER_DAYS_OPTIONS.map(option => jsx('button', {
            type: 'button', className: `dshwv-ledger-range dshwv-ledger-range-${option}`,
            'aria-label': option === 365 ? '全部' : `${option} 天`,
            'aria-pressed': days === option,
            style: { ...btnStyle, ...(days === option ? { fontWeight: 600, borderColor: 'var(--ui-accent, #203170)' } : {}) },
            onClick: () => onDays(option), children: option === 365 ? '全部' : `${option} 天`
          }))
        ] }),

        jsxs('div', { style: cardStyle, children: [
          jsx('div', { style: mutedStyle, children: `近 ${days} 天` }),
          jsx('div', { style: { ...bigStyle, fontSize: 17 }, children: cny(windowTotals.cost_cny) }),
          jsxs('div', { style: mutedStyle, children: [
            `输入 ${tokenCount(windowTotals.input_tokens)} · 缓存 ${tokenCount(windowTotals.cache_read_tokens)}`,
            ` · 输出 ${tokenCount(windowTotals.output_tokens)}`
          ] })
        ] }),

        byDay.length > 0 && jsxs('div', { children: [
          jsx('div', { style: { ...mutedStyle, margin: '8px 0 2px' }, children: '按日' }),
          ...byDay.map(dayRow)
        ] }),

        priced.length > 0 && jsxs('div', { children: [
          jsx('div', { style: { ...mutedStyle, margin: '8px 0 2px' }, children: '按模型' }),
          ...priced.map(modelRow)
        ] }),

        unpriced.length > 0 && jsxs('div', { style: { ...cardStyle, marginTop: 8 }, children: [
          jsx('div', { style: mutedStyle, children: '没有价目表的模型（未计入金额）' }),
          jsx('div', { style: { marginTop: 3, lineHeight: 1.5 }, children: unpriced.map(m => m.model).join('、') })
        ] })
      ] }),

      jsx('div', { style: { ...mutedStyle, marginTop: 8, lineHeight: 1.5 }, children:
        '金额按人民币、8 位小数记账；峰价 = 谷价 2 倍，工作日 9:00–12:00、14:00–18:00（北京时间），周末全天谷价。' })
    ]
  })
}

function AudioSettings({ draft, onToggleMaster, onVolume, onGroup, onEventEnabled, onEventChoice, onEventVolume, onEventInherit, onPreviewGroup, onPreviewEvent, onCancel, onSave, onReset }) {
  const panelStyle = {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    width: 340, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflow: 'auto',
    boxSizing: 'border-box', background: 'var(--ui-bg-elevated, var(--ui-bg, #fff))',
    border: '1px solid var(--ui-stroke-secondary, rgba(32,49,112,.4))', borderRadius: 10, padding: 12,
    zIndex: 10002, pointerEvents: 'auto', color: 'var(--ui-text-primary, #203170)',
    colorScheme: 'light', boxShadow: '0 6px 18px rgba(0,0,0,.18)'
  }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 12, flexWrap: 'wrap' }
  const btnStyle = {
    border: '1px solid var(--ui-stroke-secondary, rgba(32,49,112,.4))', borderRadius: 6,
    background: 'var(--ui-bg-hover, rgba(32,49,112,.08))', color: 'var(--ui-text-primary, #203170)',
    fontSize: 12, padding: '3px 8px', cursor: 'pointer'
  }
  const sliderStyle = { flex: 1, minWidth: 90, accentColor: 'var(--ui-accent, #203170)' }
  const checkStyle = { width: 16, height: 16, accentColor: 'var(--ui-accent, #203170)', cursor: 'pointer', flex: '0 0 auto' }
  const checkbox = (label, checked, onChange, extra = {}) => jsxs('label', {
    className: 'dshwv-audio-check', style: rowStyle,
    children: [
      jsx('input', { type: 'checkbox', checked, 'aria-label': label, style: checkStyle, onChange: event => onChange(event.target.checked), ...extra }),
      jsx('span', { children: label })
    ]
  })
  const groups = AUDIO_GROUPS.map(group => jsxs('div', {
    className: 'dshwv-audio-group', style: { ...rowStyle, margin: '4px 0' },
    children: [
      jsx('input', {
        type: 'radio', name: 'dshwv-audio-group', checked: draft.group === group.id,
        'aria-label': `音效分组 ${group.label}`, style: checkStyle, onChange: () => onGroup(group.id)
      }),
      jsx('span', { style: { flex: 1 }, children: group.label }),
      jsx('button', {
        type: 'button', className: 'dshwv-audio-preview-press', 'aria-label': `试听${group.label}按下`,
        style: btnStyle, onClick: () => onPreviewGroup(group.id, 'press'), children: '按下'
      }),
      jsx('button', {
        type: 'button', className: 'dshwv-audio-preview-release', 'aria-label': `试听${group.label}松开`,
        style: btnStyle, onClick: () => onPreviewGroup(group.id, 'release'), children: '松开'
      })
    ]
  }, group.id))
  const events = AUDIO_EVENT_IDS.map(id => {
    const label = AUDIO_EVENT_LABELS[id]
    const event = draft.events[id]
    const inherits = event.volume === null
    return jsxs('fieldset', {
      className: `dshwv-audio-event${AUDIO_EVENT_UNAVAILABLE[id] ? ' dshwv-audio-event-unavailable' : ''}`,
      style: { border: '1px solid var(--ui-stroke-secondary, rgba(32,49,112,.25))', borderRadius: 8, margin: '8px 0', padding: 8 },
      children: [
        jsxs('legend', { children: [label, AUDIO_EVENT_UNAVAILABLE[id] ? '（运行时不可用）' : ''] }),
        checkbox(`启用${label}音效`, event.enabled, value => onEventEnabled(id, value)),
        jsxs('label', { style: rowStyle, children: [
          jsx('span', { children: '音效' }),
          jsx('select', {
            'aria-label': `${label}音效选择`, value: event.choice,
            style: { ...btnStyle, flex: 1, minWidth: 0 },
            onChange: change => onEventChoice(id, change.target.value),
            children: AUDIO_CHOICES.map(choice => jsx('option', { value: choice, children: AUDIO_CHOICE_LABELS[choice] }))
          })
        ] }),
        checkbox(`继承主音量·${label}`, inherits, value => onEventInherit(id, value)),
        jsx('input', {
          type: 'range', min: String(AUDIO_VOLUME_MIN), max: String(AUDIO_VOLUME_MAX), step: '0.01',
          value: String(inherits ? draft.volume : event.volume), disabled: inherits,
          'aria-label': `${label}音量`, style: sliderStyle,
          onChange: change => onEventVolume(id, Number(change.target.value))
        }),
        jsx('button', {
          type: 'button', className: 'dshwv-audio-preview-event', 'aria-label': `试听${label}`,
          style: btnStyle, onClick: () => onPreviewEvent(id), children: '试听'
        })
      ]
    }, id)
  })
  return jsxs('div', {
    className: 'dshwv-audio', role: 'dialog', 'aria-modal': true, 'aria-label': '音效设置', tabIndex: -1,
    style: panelStyle, onKeyDown: event => { if (event.key === 'Escape') onCancel() },
    children: [
      jsx('div', { children: '音效设置' }),
      checkbox('启用音效', draft.enabled, onToggleMaster, { className: 'dshwv-audio-master' }),
      jsxs('label', { style: rowStyle, children: [
        jsx('span', { children: '主音量' }),
        jsx('input', {
          type: 'range', min: String(AUDIO_VOLUME_MIN), max: String(AUDIO_VOLUME_MAX), step: '0.01',
          value: String(draft.volume), 'aria-label': '主音量', style: sliderStyle,
          onChange: event => onVolume(Number(event.target.value))
        })
      ] }),
      jsx('div', { children: '按压/松开分组' }),
      ...groups,
      jsx('div', { children: '事件音效' }),
      ...events,
      jsxs('div', { style: { display: 'flex', gap: 8, marginTop: 8 }, children: [
        jsx('button', { type: 'button', className: 'dshwv-audio-reset', style: btnStyle, onClick: onReset, children: '重置' }),
        jsx('button', { type: 'button', className: 'dshwv-audio-cancel', style: btnStyle, onClick: onCancel, children: '取消' }),
        jsx('button', { type: 'button', className: 'dshwv-audio-save', style: btnStyle, onClick: onSave, children: '保存' })
      ] })
    ]
  })
}

function Mascot({ ctx, viewport }) {
  const profile = useValue(host.state.profile)
  const gateway = useValue(host.state.gateway)
  const focusedSessionId = useValue(host.state.focusedSessionId)
  const focusedUsage = useValue(host.state.focusedUsage)
  const [pendingRuntimeEvent, setPendingRuntimeEvent] = useState(null)
  const [visible, setVisible] = useState(() => ctx.storage.get('visible', true) !== false)
  const [position, setPosition] = useState(() => geometry(ctx.storage.get('position', {}), viewport))
  const [menuOpen, setMenuOpen] = useState(false)
  const [bubbleShown, setBubbleShown] = useState(() => ctx.storage.get('bubble', true) !== false)
  const [source, setSource] = useState(() => {
    const saved = ctx.storage.get('source', SOURCE_DEEPSEEK)
    return SOURCE_OPTIONS.some(option => option.id === saved) ? saved : SOURCE_DEEPSEEK
  })
  const [dragging, setDragging] = useState(false)
  const [audioConfig, setAudioConfig] = useState(() => normalizeAudioConfig(ctx.storage.get(AUDIO_CONFIG_KEY), ctx.storage.get('sound', false) === true))
  const [audioDraft, setAudioDraft] = useState(audioConfig)
  const [audioOpen, setAudioOpen] = useState(false)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [ledgerDays, setLedgerDays] = useState(LEDGER_DAYS_DEFAULT)
  const [bubbleConfig, setBubbleConfig] = useState(() => normalizeBubbleConfig(ctx.storage.get(BUBBLE_CONFIG_KEY, DEFAULT_BUBBLE_CONFIG)))
  const [editorOpen, setEditorOpen] = useState(false)
  const [bubbleDraft, setBubbleDraft] = useState(bubbleConfig)
  const [editorProfile, setEditorProfile] = useState('idle')
  const [bubbleSaveError, setBubbleSaveError] = useState(false)
  // Built-in gallery fetch state. `busy` is the asset id being read, not a bool,
  // so the spinner cannot land on the wrong editor row.
  const [galleryBusy, setGalleryBusy] = useState(null)
  const [galleryError, setGalleryError] = useState(false)

  const soundOn = audioConfig.enabled

  const sourceLabel = source === SOURCE_CCTQ ? 'CCTQ' : source === SOURCE_NEKO ? 'Neko' : 'DeepSeek'
  const live = useRef(position)
  live.current = position
  const drag = useRef(null)
  const press = useRef({ startedAt: 0 })
  const pressTimer = useRef(null)
  const bodyRef = useRef(null)
  const sounds = useRef({ press: null, release: null, preview: null, event: null, generation: 0, request: 0 })
  const balanceSample = useRef(null)
  // Event closures must read the latest saved config and visibility, not the
  // values captured when the subscription was created.
  const audioRef = useRef(audioConfig)
  audioRef.current = audioConfig
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const seenEvents = useRef(new Set())
  // Holds the weighted draw for the current event identity; see randomKey below.
  const moduleRandomRef = useRef({ key: null, value: Math.random() })
  // Monotonic per-event counter: two identical event names back to back must
  // still be two draws, so the name alone cannot be the identity.
  const runtimeEventSeq = useRef(0)

  const stopSlot = slot => {
    const audio = sounds.current[slot]
    sounds.current[slot] = null
    if (!audio) return
    try { audio.pause() } catch {}
    try { audio.currentTime = 0 } catch {}
  }
  const stopSounds = () => {
    sounds.current.generation++
    for (const slot of ['press', 'release', 'preview', 'event']) stopSlot(slot)
  }
  const stopPreview = () => stopSlot('preview')
  const getSound = which => {
    const config = audioRef.current
    if (!config?.enabled || !visibleRef.current || typeof Audio !== 'function') return null
    if (sounds.current[which]) return sounds.current[which]
    const url = audioGroupUrls(config, config.group)[which]
    // No bundled audio (public builds strip it): stay silent instead of handing
    // `new Audio('')` an empty source, which resolves to the page URL.
    if (!url) return null
    try {
      const audio = new Audio(url)
      audio.volume = clampVolume(config.volume)
      sounds.current[which] = audio
      return audio
    } catch {
      return null
    }
  }
  const playSound = which => {
    const audio = getSound(which)
    if (!audio) return
    try {
      audio.currentTime = 0
      void audio.play()?.catch?.(() => {})
    } catch {}
  }
  // Synchronous gesture preview: the Audio is created and started inside the
  // trusted handler itself. The previous preview is silenced first so a changed
  // selection never leaves an older clip playing.
  const previewAudio = (url, volume, enabled) => {
    stopPreview()
    if (enabled === false || !visibleRef.current || typeof Audio !== 'function' || !url) return
    try {
      const audio = new Audio(url)
      audio.volume = clampVolume(volume)
      sounds.current.preview = audio
      audio.currentTime = 0
      void audio.play()?.catch?.(() => {})
    } catch {}
  }
  const setSound = enabled => {
    const next = enabled === true
    stopSounds()
    const updated = normalizeAudioConfig({ ...audioConfig, enabled: next }, false)
    // The legacy boolean is kept in sync so existing opt-out state survives.
    ctx.storage.set(AUDIO_CONFIG_KEY, updated)
    ctx.storage.set('sound', next)
    setAudioConfig(updated)
  }

  const query = useQuery({
    queryKey: [ctx.source, 'balance', source, profile, gateway],
    queryFn: () => source === SOURCE_DEEPSEEK
      ? ctx.rest('/balance', { timeoutMs: 45000 })
      : source === SOURCE_CCTQ
        ? ctx.rest('/balance/cctq', { timeoutMs: 15000 })
        : ctx.rest('/balance/neko', { timeoutMs: 15000 }),
    enabled: visible,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: REFRESH_MS,
    retry: false,
    refetchOnWindowFocus: true
  })

  const ledgerQuery = useQuery({
    queryKey: [ctx.source, 'ledger', ledgerDays],
    queryFn: () => ctx.rest(`/ledger?days=${ledgerDays}`, { timeoutMs: 15000 }),
    enabled: visible && ledgerOpen,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: ledgerOpen ? 30000 : false,
    retry: false,
    refetchOnWindowFocus: true
  })

  const save = next => {
    live.current = next
    setPosition(next)
    const { x, y, scale, flip, hAnchor, vAnchor, hDist, vDist } = next
    ctx.storage.set('position', { x, y, scale, flip, hAnchor, vAnchor, hDist, vDist })
  }
  const toggle = () => {
    cancelGesture()
    stopPreview()
    setMenuOpen(false)
    setEditorOpen(false)
    setAudioOpen(false)
    setLedgerOpen(false)
    ctx.storage.set('visible', !visible)
    setVisible(!visible)
  }
  const widgetHide = () => {
    setMenuOpen(false)
    toggle()
  }
  const setScale = v => {
    const scale = clamp(Math.round(Number(v) * 10) / 10 || 1.5, MIN_SCALE, MAX_SCALE)
    cancelGesture()
    save(resized(live.current, scale, viewport))
  }
  const setScaleDisplay = v => setScale(scaleFromDisplay(v))
  const setBubbleOn = v => {
    ctx.storage.set('bubble', v === true)
    setBubbleShown(v === true)
  }
  // Opening a link is delegated to the host: a plugin must never navigate the
  // renderer, and openExternal degrades to a no-op (not a throw) when the
  // capability is missing, so a bubble link can never break the widget.
  const openBubbleLink = href => {
    const safe = safeBubbleHref(href)
    if (!safe) return
    try { void ctx.os?.openExternal?.(safe) } catch { /* capability absent */ }
  }
  const openBubbleEditor = () => {
    setBubbleDraft(normalizeBubbleConfig(bubbleConfig))
    setEditorProfile('idle')
    setBubbleSaveError(false)
    setEditorOpen(true)
    setMenuOpen(false)
  }
  const updateBubbleDraft = (index, key, value) => setBubbleDraft(current => {
    const modules = current.profiles[editorProfile].map((module, i) => i === index ? { ...module, [key]: value } : module)
    return { ...current, profiles: { ...current.profiles, [editorProfile]: modules } }
  })
  const pickGalleryImage = async (index, assetId) => {
    setGalleryError(false)
    setGalleryBusy(assetId)
    try {
      const dataUrl = await loadBubbleImage(ctx, assetId)
      // A failed fetch must not silently write "" over a picture the user
      // already had; report it and leave the row alone.
      if (!dataUrl) {
        setGalleryError(true)
        return
      }
      // Store the reference, not the pixels: the picture stays in the session
      // cache and localStorage only ever sees `asset:<id>`.
      updateBubbleDraft(index, 'src', BUBBLE_ASSET_PREFIX + assetId)
    } finally {
      setGalleryBusy(null)
    }
  }
  const addBubbleModule = index => setBubbleDraft(current => {
    const modules = [...current.profiles[editorProfile]]
    const copy = index === undefined ? { type: 'text', enabled: true, weight: 1, text: '', src: '' } : { ...modules[index] }
    modules.splice(index === undefined ? modules.length : index + 1, 0, copy)
    return { ...current, profiles: { ...current.profiles, [editorProfile]: modules.slice(0, BUBBLE_MODULE_MAX) } }
  })
  const deleteBubbleModule = index => setBubbleDraft(current => ({ ...current, profiles: { ...current.profiles, [editorProfile]: current.profiles[editorProfile].filter((_, i) => i !== index) } }))
  const moveBubbleModule = (index, direction) => setBubbleDraft(current => {
    const modules = [...current.profiles[editorProfile]]
    const target = index + direction
    if (target < 0 || target >= modules.length) return current
    ;[modules[index], modules[target]] = [modules[target], modules[index]]
    return { ...current, profiles: { ...current.profiles, [editorProfile]: modules } }
  })
  const cancelBubbleEditor = () => { setBubbleSaveError(false); setEditorOpen(false) }
  const saveBubbleEditor = () => {
    const next = normalizeBubbleConfig(bubbleDraft)
    // ctx.storage.set is best-effort: the host wraps localStorage and swallows a
    // quota/permission error, so a failed write is indistinguishable from a
    // successful one at the call site. Probing back turns that silent loss into
    // a visible one instead of letting the editor report a save that never
    // landed. The 24KB config cap makes a byte mismatch a reliable signal.
    const sent = JSON.stringify(next)
    ctx.storage.set(BUBBLE_CONFIG_KEY, next)
    const stored = ctx.storage.get(BUBBLE_CONFIG_KEY, null)
    const landed = stored !== null && JSON.stringify(stored) === sent
    if (!landed) {
      setBubbleSaveError(true)
      return
    }
    setBubbleSaveError(false)
    setBubbleConfig(next)
    setEditorOpen(false)
  }
  const resetBubbleDraft = () => setBubbleDraft(normalizeBubbleConfig(DEFAULT_BUBBLE_CONFIG))
  const openLedger = () => {
    stopPreview()
    setLedgerOpen(true)
    setAudioOpen(false)
    setEditorOpen(false)
    setMenuOpen(false)
  }
  const openAudioSettings = () => {
    stopPreview()
    setAudioDraft(normalizeAudioConfig(audioConfig))
    setAudioOpen(true)
    setEditorOpen(false)
    setMenuOpen(false)
  }
  const cancelAudioSettings = () => { stopPreview(); setAudioOpen(false) }
  const saveAudioSettings = () => {
    stopPreview()
    const next = normalizeAudioConfig(audioDraft)
    ctx.storage.set(AUDIO_CONFIG_KEY, next)
    ctx.storage.set('sound', next.enabled)
    setAudioConfig(next)
    setAudioOpen(false)
  }
  const resetAudioDraft = () => { stopPreview(); setAudioDraft(normalizeAudioConfig(DEFAULT_AUDIO_CONFIG)) }
  const setAudioMaster = enabled => { stopPreview(); setAudioDraft(draft => normalizeAudioConfig({ ...draft, enabled: enabled === true })) }
  const setAudioVolume = value => setAudioDraft(draft => normalizeAudioConfig({ ...draft, volume: value }))
  const setAudioGroup = group => { stopPreview(); setAudioDraft(draft => normalizeAudioConfig({ ...draft, group })) }
  const setEventEnabled = (id, enabled) => setAudioDraft(draft => withAudioEvent(draft, id, { enabled: enabled === true }))
  const setEventChoice = (id, choice) => { stopPreview(); setAudioDraft(draft => withAudioEvent(draft, id, { choice })) }
  const setEventVolume = (id, value) => setAudioDraft(draft => withAudioEvent(draft, id, { volume: value }))
  const setEventInherit = (id, inherit) => {
    stopPreview()
    setAudioDraft(draft => withAudioEvent(draft, id, { volume: inherit ? null : audioEventVolume(draft, id) }))
  }
  const previewGroup = (groupId, which) => {
    const urls = audioGroupUrls(audioDraft, groupId)
    previewAudio(which === 'release' ? urls.release : urls.press, audioDraft.volume, audioDraft.enabled)
  }
  const previewEvent = eventId => {
    const event = audioDraft.events[eventId]
    if (!event) return
    previewAudio(AUDIO_CHOICE_URLS[event.choice] || AUDIO_CHOICE_URLS[AUDIO_CHOICE_A], audioEventVolume(audioDraft, eventId), audioDraft.enabled)
  }
  const selectSource = value => {
    const next = SOURCE_OPTIONS.some(option => option.id === value) ? value : SOURCE_DEEPSEEK
    if (next === source) return
    cancelGesture()
    ctx.storage.set('source', next)
    setSource(next)
  }
  const clearPress = () => {
    if (pressTimer.current) {
      try { clearTimeout(pressTimer.current) } catch {}
      pressTimer.current = null
    }
  }
  const cancelGesture = () => {
    const current = drag.current
    if (current) {
      drag.current = null
      if (current.target?.hasPointerCapture?.(current.id)) current.target.releasePointerCapture(current.id)
      live.current = current.origin
      setPosition(current.origin)
    }
    setDragging(false)
    pressUp()
  }
  const pressDown = () => {
    clearPress()
    const body = bodyRef.current
    if (!body || !body.style) return
    press.current.startedAt = performanceNow()
    body.style.transform = SQUISH
  }
  const pressUp = () => {
    clearPress()
    const body = bodyRef.current
    if (!body || !body.style) return
    // Fast taps may land in the same frame: commit the squish, then spring back.
    if (performanceNow() - press.current.startedAt < PRESS_VISUAL_TAP_MS) {
      const previous = body.style.transition
      body.style.transition = 'none'
      body.style.transform = SQUISH
      void body.offsetWidth
      body.style.transition = previous
    }
    body.style.transform = 'scaleY(1) scaleX(1)'
  }

  // Preload every built-in picture the saved config actually references. Without
  // this the `asset:` refs would resolve to '' on first paint and their bubbles
  // would silently drop, so the fetch has to finish before the bubble means
  // anything. The setState at the end is what re-renders the bubble once the
  // pixels are in cache; it is deliberately not read by the render body.
  const [, bumpGallery] = useState(0)
  useEffect(() => {
    const referenced = new Set()
    for (const id of PROFILE_IDS) {
      for (const module of bubbleConfig.profiles[id] || []) {
        if (typeof module.src === 'string' && module.src.startsWith(BUBBLE_ASSET_PREFIX)) {
          referenced.add(module.src.slice(BUBBLE_ASSET_PREFIX.length))
        }
      }
    }
    const missing = [...referenced].filter(id => !galleryCache.has(id))
    if (!missing.length || typeof ctx?.rest !== 'function') return
    let cancelled = false
    void Promise.all(missing.map(id => loadBubbleImage(ctx, id))).then(() => {
      if (!cancelled) bumpGallery(count => count + 1)
    })
    return () => { cancelled = true }
  }, [bubbleConfig])

  useEffect(() => {
    setPendingRuntimeEvent(null)
    if (!focusedSessionId || typeof ctx.onEvent !== 'function') return
    const identity = source => source?.message_id ?? source?.messageId ?? source?.tool_id ?? source?.toolId ?? source?.id ?? null
    const playEventAudio = name => {
      const config = audioRef.current
      if (!config?.enabled || !visibleRef.current || typeof Audio !== 'function') return
      const item = config.events?.[name]
      if (!item?.enabled) return
      stopSlot('event')
      const eventUrl = AUDIO_CHOICE_URLS[item.choice] || AUDIO_CHOICE_URLS[AUDIO_CHOICE_A]
      // Public builds carry no audio; skip the cue rather than creating an Audio
      // with an empty source.
      if (!eventUrl) return
      try {
        const audio = new Audio(eventUrl)
        audio.volume = clampVolume(item.volume === null ? config.volume : item.volume)
        sounds.current.event = audio
        audio.currentTime = 0
        void audio.play()?.catch?.(() => {})
      } catch {}
    }
    const handle = (type, event) => {
      if (!event || event.replayed || event.session_id !== focusedSessionId) return
      const payload = event.payload || event
      const name = type === 'message.complete' && payload.status === 'complete' ? 'task_complete'
        : type === 'tool.start' && payload.name === 'clarify' ? 'needs_input'
          : null
      if (!name) {
        // Only the two audio cues are deduplicated. A frame that merely carries the
        // same id (an error status, an unrelated tool) must not claim that id and
        // silence the real completion that arrives with it afterwards.
        if (type === 'message.start') setPendingRuntimeEvent(null)
        return
      }
      const id = identity(payload) ?? identity(event)
      if (id !== null && id !== undefined) {
        // Session-scoped key: the same message id in another session is a
        // different event and must still play when that session is focused.
        const token = `${focusedSessionId}:${type}:${id}`
        if (seenEvents.current.has(token)) return
        seenEvents.current.add(token)
        // Bounded memory, oldest first. Never clear the whole set: that would let
        // the most recent duplicate replay until it aged out again.
        while (seenEvents.current.size > SEEN_EVENT_LIMIT) {
          const oldest = seenEvents.current.values().next().value
          if (oldest === undefined) break
          seenEvents.current.delete(oldest)
        }
      }
      setPendingRuntimeEvent({ sessionId: focusedSessionId, name, seq: runtimeEventSeq.current++ })
      playEventAudio(name)
    }
    const listeners = ['message.start', 'message.complete', 'tool.start'].map(type => ctx.onEvent(type, event => handle(type, event)))
    return () => {
      for (const unsubscribe of listeners) if (typeof unsubscribe === 'function') unsubscribe()
      stopSlot('event')
    }
  }, [ctx, focusedSessionId])
  useEffect(() => {
    if (drag.current) {
      const current = drag.current
      drag.current = null
      if (current.target?.hasPointerCapture?.(current.id)) current.target.releasePointerCapture(current.id)
      live.current = current.origin
      setDragging(false)
      pressUp()
    }
    const next = geometry(live.current, viewport)
    live.current = next
    setPosition(next)
    const shape = bodyRef.current?.querySelector?.('.dshwv-bshape')
    const box = shape?.getBBox?.()
    if (box?.width > 0 && box?.height > 0) {
      bodyRef.current.style.setProperty('--dshw-vx', `${(box.x + box.width / 2) / 1026 * 100}%`)
      bodyRef.current.style.setProperty('--dshw-vy', `${(box.y + box.height / 2) / 700 * 100}%`)
    }
  }, [viewport.width, viewport.height, visible])
  useEffect(() => {
    if (!visible || !soundOn) stopSounds()
  }, [visible, soundOn])
  useEffect(() => () => {
    const current = drag.current
    drag.current = null
    if (current?.target?.hasPointerCapture?.(current.id)) current.target.releasePointerCapture(current.id)
    clearPress()
    stopSounds()
  }, [])

  const start = event => {
    if (event.button !== 0 || drag.current) return
    playSound('press')
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = {
      id: event.pointerId, target: event.currentTarget, x: event.clientX, y: event.clientY,
      origin: live.current, moved: false
    }
    setDragging(true)
    pressDown()
  }
  const move = event => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (dx * dx + dy * dy >= CLICK_SQ) current.moved = true
    if (current.moved) {
      const next = geometry({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy }, viewport, { free: true })
      live.current = next
      setPosition(next)
    }
  }
  const finish = (event, cancelled = false) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    drag.current = null
    if (current.target?.hasPointerCapture?.(current.id)) current.target.releasePointerCapture(current.id)
    if (!cancelled) playSound('release')
    setDragging(false)
    pressUp()
    const noCoord = typeof event.clientX !== 'number' || typeof event.clientY !== 'number' ||
      !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)
    const zeroBoth = current.moved && event.clientX === 0 && event.clientY === 0
    if (cancelled || noCoord || zeroBoth) {
      live.current = current.origin
      setPosition(current.origin)
      return
    }
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (dx * dx + dy * dy >= CLICK_SQ) current.moved = true
    if (!current.moved) {
      if (!query.isFetching) void query.refetch()
      return
    }
    const next = geometry({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy }, viewport, { free: true })
    save(geometry(next, viewport, { snap: true }))
  }

  const fetching = query.isFetching
  const display = presentation(query.data || (source === SOURCE_CCTQ ? CCTQ_UNAVAILABLE : source === SOURCE_NEKO ? NEKO_UNAVAILABLE : null), query.isError)
  const freshAmount = !query.isError && !query.isPlaceholderData && display.idle && typeof query.data?.balance === 'string' && /^\d+(\.\d+)?$/.test(query.data.balance) && Number(query.data.balance) > 0 && display.amount !== '—' && !display.hint.includes('旧数据') ? display.amount : null
  const sampleKey = JSON.stringify([source, profile, gateway])
  const baseline = balanceSample.current?.key === sampleKey ? balanceSample.current : null
  const balanceEvent = freshAmount === null ? null
    : !baseline ? 'refresh_success'
      : baseline.balance !== freshAmount ? 'balance_changed' : 'idle'
  useEffect(() => {
    if (freshAmount === null) return
    const current = balanceSample.current
    if (current?.key !== sampleKey || current.balance !== freshAmount) balanceSample.current = { key: sampleKey, balance: freshAmount }
  }, [sampleKey, freshAmount])
  const eventName = pendingRuntimeEvent && pendingRuntimeEvent.sessionId === focusedSessionId ? pendingRuntimeEvent.name : balanceEvent
  // A weighted module must be a deliberate pick, not a per-render coin flip: this
  // widget re-renders on every poll tick, so re-drawing each time would make the
  // text jitter. The draw is therefore pinned to the identity of the current
  // event and held until that identity changes. A literal constant here (the old
  // 0.5) would make every weight in the editor inert instead.
  const eventToken = pendingRuntimeEvent && pendingRuntimeEvent.sessionId === focusedSessionId ? pendingRuntimeEvent.seq : null
  const randomKey = eventName === null ? '' : `${eventName}\u0000${eventToken ?? ''}\u0000${sampleKey}\u0000${freshAmount ?? ''}`
  if (moduleRandomRef.current.key !== randomKey) {
    moduleRandomRef.current = { key: randomKey, value: Math.random() }
  }
  const moduleRandom = moduleRandomRef.current.value
  const usage = focusedUsage && typeof focusedUsage === 'object' ? focusedUsage : {}
  const eventValues = {
    balance: display.amount,
    used: usage.total ?? query.data?.used,
    cost: usage.cost_usd ?? query.data?.cost,
    session: focusedSessionId ?? query.data?.session,
    source: sourceLabel,
    // Only DeepSeek exposes the grant/top-up split. CCTQ and Neko report a single
    // number, so these stay undefined there and the modules fall back to "—"
    // rather than claiming a 0 balance that was never reported.
    bonus: typeof query.data?.granted === 'string' ? cny(query.data.granted) : undefined,
    recharge: typeof query.data?.topped_up === 'string' ? cny(query.data.topped_up) : undefined
  }
  const liveModules = eventName ? renderBubbleModules(bubbleConfig, eventName, eventValues, moduleRandom) : []
  // Links render inline as their own line, so they join the row set for layout
  // purposes even though they are not counted as text rows for the cap.
  const liveRows = liveModules.filter(module => (BUBBLE_ROW_TYPES.includes(module.type) && module.type !== 'randomImage') || module.type === 'link')
  const liveImages = liveModules.filter(module => (module.type === 'image' || module.type === 'randomImage') && isImageDataUrl(module.src))
  const liveBubbleProps = {
    label: bubbleLabel(bubbleConfig, sourceLabel, eventName, eventValues, moduleRandom),
    amount: bubbleAmount(bubbleConfig, display.amount, eventName, eventValues, moduleRandom),
    hint: bubbleHint(bubbleConfig, display, fetching, eventName, eventValues, moduleRandom),
    rows: liveRows,
    flip: position.flip,
    shown: bubbleShown,
    onOpenLink: openBubbleLink
  }

  const statusbarStyle = {
    border: '1px solid var(--ui-stroke-secondary)', borderRadius: 8, padding: '2px 8px',
    color: 'var(--ui-text-primary)', background: 'var(--ui-bg-elevated, var(--ui-bg))', cursor: 'pointer'
  }
  const rootStyle = {
    position: 'fixed', left: position.x, top: position.y, width: position.width, height: position.height,
    zIndex: 9999, pointerEvents: 'none', userSelect: 'none', WebkitUserSelect: 'none',
    background: 'transparent', border: 0, outline: 0, boxShadow: 'none',
    backdropFilter: 'none', WebkitBackdropFilter: 'none', filter: 'none',
    transform: position.flip ? 'scaleX(-1)' : 'none',
    transition: dragging ? 'none' : 'left .16s ease,top .16s ease,transform .3s ease',
    '--dshw-scale': String(position.scale),
    '--dshw-base': `${position.width}px`
  }
  const bodyStyle = {
    position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
    transformOrigin: BODY_TRANSFORM_ORIGIN, transition: BODY_TRANSITION
  }
  const imgStyle = {
    position: 'absolute', right: 0, bottom: 0, width: IMAGE_WIDTH_PCT, height: IMAGE_WIDTH_PCT,
    display: 'block', pointerEvents: 'auto', userSelect: 'none', WebkitUserDrag: 'none',
    objectFit: 'contain', objectPosition: 'right bottom', cursor: dragging ? 'grabbing' : 'grab',
    touchAction: 'none'
  }
  // Shown only when the house-style artwork is absent. A soft blue oval stands in
  // for the mascot so the widget keeps its hit area and stays obviously clickable
  // without borrowing anyone's picture.
  const placeholderStyle = {
    ...imgStyle,
    boxSizing: 'border-box',
    border: '2px solid rgba(32,49,112,.55)',
    borderRadius: '50% 50% 46% 46%',
    background: 'radial-gradient(circle at 34% 32%, rgba(255,255,255,.65), rgba(122,163,214,.55) 42%, rgba(32,49,112,.75) 100%)',
    opacity: .92
  }
  const popStyle = {
    position: 'absolute', left: 0, top: 0, width: '100%', aspectRatio: '1026 / 700',
    pointerEvents: 'none', zIndex: 1, '--dshw-u': 'calc(var(--dshw-base) / 1026)'
  }
  const menuBar = { display: 'block', width: 14, height: 2, background: '#fff', borderRadius: 1 }
  const menuBtnStyle = {
    position: 'absolute', top: 'calc(40.55% + 4px)', right: 4, width: 26, height: 26,
    border: 'none', borderRadius: 6, background: 'rgba(32,49,112,.85)', cursor: 'pointer',
    pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: 4, padding: 0, zIndex: 2
  }
  const menuRow = (label, control) => jsxs('div', {
    className: 'dshwv-menu-row',
    style: { display: 'flex', alignItems: 'center', gap: 8, margin: '5px 0', color: '#203170', fontSize: 12, whiteSpace: 'nowrap' },
    children: [jsx('span', { children: label }), control]
  })
  const smallBtnStyle = {
    border: '1px solid rgba(32,49,112,.4)', borderRadius: 6, background: 'rgba(32,49,112,.08)',
    color: '#203170', fontSize: 12, padding: '3px 8px', cursor: 'pointer'
  }
  const menuStyle = {
    position: 'fixed',
    left: clamp(position.flip ? position.x + 4 : position.x + position.width - 224, 8, Math.max(8, viewport.width - 232)),
    top: clamp(position.y + position.height * 0.4055 + 34, 8, Math.max(8, viewport.height - 190)),
    width: 220, minWidth: 0, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflow: 'auto',
    boxSizing: 'border-box', background: 'rgba(255,255,255,.92)', border: '1px solid rgba(32,49,112,.35)',
    borderRadius: 10, padding: '10px 12px 0', zIndex: 10000, boxShadow: '0 6px 18px rgba(0,0,0,.18)',
    color: '#203170', colorScheme: 'light', transformOrigin: 'top right',
    opacity: menuOpen ? 1 : 0, transform: menuOpen ? 'none' : 'scale(.96) translateY(10px)',
    transition: 'opacity .22s ease,transform .22s cubic-bezier(.34,1.3,.6,1)',
    pointerEvents: menuOpen ? 'auto' : 'none'
  }
  const stop = event => { try { event?.stopPropagation?.() } catch {} }
  const menuRows = [
    menuRow('来源', jsx('select', {
      value: source, title: '余额来源',
      style: { ...smallBtnStyle, flex: 1, minWidth: 0 },
      onChange: event => selectSource(event.target.value),
      children: SOURCE_OPTIONS.map(option => jsx('option', {
        value: option.id, children: option.label
      }))
    })),
    menuRow('刷新', jsx('button', {
      type: 'button', title: '刷新余额（后端缓存 60 秒）',
      style: smallBtnStyle,
      onClick: () => { if (!query.isFetching) void query.refetch() },
      children: '刷新余额'
    })),
    menuRow('大小', jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }, children: [
      jsx('input', {
        type: 'range', min: String(MIN_SCALE), max: String(MAX_SCALE), step: String(SCALE_STEP),
        value: String(position.scale), title: '缩放',
        style: { flex: 1, minWidth: 0, accentColor: '#203170' },
        onChange: event => setScale(event.target.value)
      }),
      jsx('input', {
        type: 'number', min: '1', max: '20', step: '1', value: String(scaleToDisplay(position.scale)),
        title: '缩放档位（1–20）',
        style: { width: 44, border: '1px solid rgba(32,49,112,.4)', borderRadius: 6, padding: '2px 4px', fontSize: 12, color: '#203170', background: '#fff', boxSizing: 'border-box' },
        onChange: event => setScaleDisplay(event.target.value)
      })
    ] })),
    menuRow('气泡', jsx('input', {
      type: 'checkbox', checked: bubbleShown, title: '开启/关闭思考气泡',
      style: { width: 16, height: 16, accentColor: '#203170', cursor: 'pointer', flex: '0 0 auto' },
      onChange: event => setBubbleOn(event.target.checked)
    })),
    menuRow('音效', jsx('input', {
      type: 'checkbox', checked: soundOn, disabled: typeof Audio !== 'function',
      title: '使用鲸鱼娘原版按压与松开音效',
      onChange: event => setSound(event.target.checked),
      style: { width: 16, height: 16, accentColor: '#203170', cursor: 'pointer', flex: '0 0 auto' }
    })),
    menuRow('隐藏', jsx('button', {
      type: 'button', title: '隐藏鲸鱼挂件', style: smallBtnStyle,
      onClick: widgetHide, children: '隐藏鲸鱼'
    })),
    menuRow('文字', jsx('button', {
      type: 'button', className: 'dshwv-edit-btn', title: '编辑气泡事件模块',
      style: smallBtnStyle,
      onClick: event => { stop(event); openBubbleEditor() },
      children: '编辑气泡'
    })),
    menuRow('音频', jsx('button', {
      type: 'button', className: 'dshwv-audio-btn', title: '音效设置',
      style: smallBtnStyle,
      onClick: event => { stop(event); openAudioSettings() },
      children: '音效设置'
    })),
    menuRow('记账', jsx('button', {
      type: 'button', className: 'dshwv-ledger-btn', title: '小鲸鱼记账（本机模型费用与峰谷）',
      style: smallBtnStyle,
      onClick: event => { stop(event); openLedger() },
      children: '用量与峰谷'
    }))
  ]

  return jsxs(Fragment, { children: [
    jsx('button', {
      type: 'button', onClick: toggle, 'aria-pressed': visible, title: `显示或隐藏${sourceLabel}鲸鱼余额`,
      style: statusbarStyle, children: visible ? '鲸鱼 · 隐藏' : '鲸鱼 · 显示'
    }),
    visible && jsxs('section', {
      className: `dshwv-root${position.flip ? ' dshwv-left' : ''}${dragging ? ' dshwv-dragging' : ''}`,
      'aria-label': `${sourceLabel} 鲸鱼余额挂件（MeteorNOX 原画）`,
      style: rootStyle,
      children: [
        jsxs('div', { ref: bodyRef, className: 'dshwv-body', style: bodyStyle, children: [
          ARTWORK_URI ? jsx('img', {
            className: 'dshwv-img', src: ARTWORK_URI, alt: `${sourceLabel} 余额`, draggable: false,
            onPointerDown: start, onPointerMove: move,
            onPointerUp: event => finish(event),
            onPointerCancel: event => finish(event, true),
            onLostPointerCapture: event => finish(event, true),
            onClick: event => { event.stopPropagation?.() },
            role: 'button', tabIndex: 0,
            onKeyDown: event => {
              if ((event.key === 'Enter' || event.key === ' ') && !event.repeat && !query.isFetching) {
                event.preventDefault?.()
                void query.refetch()
              }
            },
            title: '拖动移动；单击刷新（后端缓存 60 秒）', 'aria-label': `拖动鲸鱼或点击刷新${sourceLabel}余额`, style: imgStyle
          }) : jsx('div', {
            // No bundled artwork: public builds ship without the upstream picture,
            // so the mascot is a neutral silhouette that keeps every interaction
            // (drag, click-to-refresh, keyboard) the image would otherwise carry.
            className: 'dshwv-img dshwv-img-placeholder', draggable: false,
            onPointerDown: start, onPointerMove: move,
            onPointerUp: event => finish(event),
            onPointerCancel: event => finish(event, true),
            onLostPointerCapture: event => finish(event, true),
            onClick: event => { event.stopPropagation?.() },
            role: 'button', tabIndex: 0,
            onKeyDown: event => {
              if ((event.key === 'Enter' || event.key === ' ') && !event.repeat && !query.isFetching) {
                event.preventDefault?.()
                void query.refetch()
              }
            },
            title: '拖动移动；单击刷新（后端缓存 60 秒）', 'aria-label': `拖动鲸鱼或点击刷新${sourceLabel}余额`, style: placeholderStyle
          }),
          jsxs('div', { className: 'dshwv-pop', style: popStyle, children: [
            jsx(BubbleShape, { flip: position.flip, shown: bubbleShown }),
            jsx(BubbleText, liveBubbleProps),
            ...liveImages.map((module, index) => jsx('img', {
              src: module.src, alt: '', className: 'dshwv-module-image',
              style: { position: 'absolute', left: '32%', top: '16%', width: '36%', height: '36%', objectFit: 'contain', pointerEvents: 'none', zIndex: 2 + index }
            }))
          ] })
        ] }),
        jsx('button', {
          type: 'button', onClick: event => { stop(event); setMenuOpen(open => !open) }, title: '菜单',
          className: 'dshwv-menu-btn', style: menuBtnStyle,
          children: [jsx('span', { style: menuBar }), jsx('span', { style: menuBar }), jsx('span', { style: menuBar })]
        })
      ]
    }),
    visible && jsx('div', {
      className: `dshwv-menu${menuOpen ? ' dshwv-menu-open' : ''}`,
      hidden: !menuOpen, style: menuStyle, children: menuRows,
      onKeyDown: event => { if (event.key === 'Escape') setMenuOpen(false) }
    }),
    editorOpen && jsx(BubbleEditor, {
      draft: bubbleDraft,
      profile: editorProfile,
      onProfile: setEditorProfile,
      sourceLabel,
      display,
      fetching,
      values: eventValues,
      onPatch: updateBubbleDraft,
      onAdd: addBubbleModule,
      onDelete: deleteBubbleModule,
      onMove: moveBubbleModule,
      onReset: resetBubbleDraft,
      onCancel: cancelBubbleEditor,
      onSave: saveBubbleEditor,
      saveError: bubbleSaveError,
      onPickGallery: pickGalleryImage,
      galleryBusy,
      galleryError
    }),
    audioOpen && jsx(AudioSettings, {
      draft: audioDraft,
      onToggleMaster: setAudioMaster,
      onVolume: setAudioVolume,
      onGroup: setAudioGroup,
      onEventEnabled: setEventEnabled,
      onEventChoice: setEventChoice,
      onEventVolume: setEventVolume,
      onEventInherit: setEventInherit,
      onPreviewGroup: previewGroup,
      onPreviewEvent: previewEvent,
      onCancel: cancelAudioSettings,
      onSave: saveAudioSettings,
      onReset: resetAudioDraft
    }),
    ledgerOpen && jsx(LedgerPanel, {
      data: ledgerQuery.data,
      error: ledgerQuery.error ? String(ledgerQuery.error.message || ledgerQuery.error) : null,
      days: ledgerDays,
      onDays: setLedgerDays,
      onRefresh: () => { if (!ledgerQuery.isFetching) void ledgerQuery.refetch() },
      onClose: () => setLedgerOpen(false),
      fetching: ledgerQuery.isFetching
    })
  ] })
}

function Entry({ ctx }) {
  const viewport = useValue(host.state.viewport)
  return jsx(Mascot, { ctx, viewport })
}

export default {
  id: PLUGIN_ID,
  name: 'Whale Balance · MeteorNOX 原画',
  description: 'DeepSeek / CCTQ / Neko 余额 + 原版鲸鱼娘挂件（私人本地兼容适配）',
  defaultEnabled: false,
  register(ctx) {
    ctx.register({
      id: 'mascot',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(Entry, { ctx })
    })
  }
}
