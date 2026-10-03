.pragma library

// Pure helpers for the gadget battery widget. Every source is normalized to
//   { key, name, kind, level (0-100), charging, detail, offline }
// so the panel only ever renders one shape. `charging` is true or false when
// the source knows, and null when it cannot tell (then applyTrends estimates).

var KIND_ICONS = {
  mouse: "\u{F037D}",     // nf-md-mouse
  keyboard: "\u{F030C}",  // nf-md-keyboard
  headset: "\u{F02CE}",   // nf-md-headset
  earbuds: "\u{F184F}",   // nf-md-earbuds
  gamepad: "\u{F0297}",   // nf-md-gamepad_variant
  speaker: "\u{F04C3}",   // nf-md-speaker
  phone: "\u{F011C}",     // nf-md-cellphone
  tablet: "\u{F04F6}",    // nf-md-tablet
  watch: "\u{F0589}",     // nf-md-watch
  other: "\u{F0FB0}"      // nf-md-devices
}

// External/collector kinds (theleif/omarchy-peripheral-batteries vocabulary)
// folded onto the icons above.
var EXTERNAL_KINDS = {
  mouse: "mouse", touchpad: "mouse", pen: "mouse",
  keyboard: "keyboard",
  headset: "headset", headphones: "headset", earbuds: "earbuds",
  gamepad: "gamepad", speaker: "speaker",
  phone: "phone", tablet: "tablet", watch: "watch"
}

// Kinds UPower reports for things that are not peripherals.
var IGNORED_UPOWER_TYPES = ["unknown", "linepower", "battery", "ups", "monitor", "computer"]

function kindIcon(kind) {
  return KIND_ICONS[kind] || KIND_ICONS.other
}

function batteryIcon(level, charging) {
  if (level < 0) return "\u{F0091}" // nf-md-battery_unknown
  if (charging) return "\u{F0084}"  // nf-md-battery_charging
  if (level <= 5) return "\u{F0083}" // nf-md-battery_alert
  if (level >= 95) return "\u{F0079}" // nf-md-battery
  // nf-md-battery_10 .. battery_90 are consecutive code points.
  var step = Math.max(1, Math.min(9, Math.round(level / 10)))
  return String.fromCodePoint(0xF007A + step - 1)
}

function kindFromUPowerType(typeName) {
  var t = String(typeName || "").toLowerCase()
  if (t === "mouse" || t === "touchpad" || t === "pen") return "mouse"
  if (t === "keyboard") return "keyboard"
  if (t === "headset" || t === "headphones") return "headset"
  if (t === "gaminginput") return "gamepad"
  return "other"
}

// UPower's "unknown" state (a Logitech mouse on its charging cable) is
// reported as null so applyTrends can estimate; every other state is known.
function fromUPower(device, typeName, chargingState, unknownState) {
  if (!device || !device.isPresent || device.powerSupply || device.isLaptopBattery) return null
  if (IGNORED_UPOWER_TYPES.indexOf(String(typeName || "").toLowerCase()) >= 0) return null
  var level = Math.round(Math.max(0, Math.min(1, device.percentage)) * 100)
  return {
    key: "upower:" + device.nativePath,
    name: device.model || typeName || "Device",
    kind: kindFromUPowerType(typeName),
    level: level,
    charging: device.state === unknownState ? null : device.state === chargingState,
    detail: ""
  }
}

// `headsetcontrol -o json` output. Headsets whose battery cannot be read
// right now (powered off, asleep) are skipped instead of shown as 0%.
function fromHeadsetControl(raw) {
  var parsed
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { return [] }
  var devices = parsed && Array.isArray(parsed.devices) ? parsed.devices : []
  var out = []
  for (var i = 0; i < devices.length; i++) {
    var d = devices[i] || {}
    var battery = d.battery || {}
    var status = String(battery.status || "")
    if (status !== "BATTERY_AVAILABLE" && status !== "BATTERY_CHARGING") continue
    var level = Number(battery.level)
    if (!isFinite(level) || level < 0) continue
    out.push({
      key: "headsetcontrol:" + (d.id_vendor || "") + ":" + (d.id_product || "") + ":" + i,
      name: d.device || d.product || "Headset",
      kind: "headset",
      level: Math.min(100, Math.round(level)),
      charging: status === "BATTERY_CHARGING",
      detail: ""
    })
  }
  return out
}

// omarchy-buds status.json (written by GalaxyBudsClient's hook).
function fromBudsStatus(raw) {
  var parsed
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { return [] }
  if (!parsed || parsed.connected !== true) return []
  var battery = parsed.battery || {}
  var parts = []
  var levels = []
  var charging = false
  var sides = [["left", "L"], ["right", "R"], ["case", "Case"]]
  for (var i = 0; i < sides.length; i++) {
    var b = battery[sides[i][0]]
    if (!b || b.available !== true || b.level < 0) continue
    parts.push(sides[i][1] + " " + b.level + "%")
    // The case level is informative; the earbuds are what run out.
    if (sides[i][0] !== "case") {
      levels.push(b.level)
      charging = charging || b.charging === true
    }
  }
  if (levels.length === 0) return []
  return [{
    key: "buds:" + (parsed.address || ""),
    name: parsed.device_name || "Galaxy Buds",
    kind: "earbuds",
    level: Math.min.apply(null, levels),
    charging: charging,
    detail: parts.join(" · ")
  }]
}

function partsDetail(left, right, caseLevel) {
  var parts = []
  if (left >= 0) parts.push("L " + left + "%")
  if (right >= 0) parts.push("R " + right + "%")
  if (caseLevel >= 0) parts.push("Case " + caseLevel + "%")
  return parts.join(" · ")
}

function clampLevel(value) {
  var n = Number(value)
  return isFinite(n) && n >= 0 ? Math.min(100, Math.round(n)) : -1
}

// External JSON file and collectors.d output, one entry per device:
//   { id, name, kind, pct, charging, ts, ttl, left?, right?, case?, transport? }
// Entries past ts + ttl stay listed as offline instead of showing a stale level.
function fromExternal(raw, nowSec) {
  var list
  try { list = typeof raw === "string" ? JSON.parse(raw || "[]") : raw } catch (e) { return [] }
  if (!Array.isArray(list)) return []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    if (!e || typeof e !== "object" || !e.name) continue
    var level = clampLevel(e.pct)
    if (level < 0) continue
    var ts = Number(e.ts), ttl = Number(e.ttl)
    out.push({
      key: "external:" + (e.id || e.name),
      name: String(e.name),
      kind: EXTERNAL_KINDS[String(e.kind || "").toLowerCase()] || "other",
      level: level,
      // A missing or non-boolean field means the source does not know.
      charging: typeof e.charging === "boolean" ? e.charging : null,
      detail: partsDetail(clampLevel(e.left), clampLevel(e.right), clampLevel(e["case"])),
      offline: isFinite(ts) && isFinite(ttl) && ttl > 0 && nowSec > ts + ttl
    })
  }
  return out
}

// Sources name the same gadget slightly differently ("G502 X PLUS" vs
// "Logitech G502 X PLUS", "G522 LIGHTSPEED - Wireless Mode" / "- USB Mode").
function sameDeviceKey(name) {
  return String(name).toLowerCase()
    .replace(/\s*-\s*(wireless|usb) mode$/, "")
    .replace(/^logitech\s+/, "")
    .replace(/[^a-z0-9]/g, "")
}

// Merge sources, dropping later duplicates by name, lowest battery first.
// Pass the most detailed source first (Buds before UPower).
function mergeDevices(lists) {
  var seen = {}
  var out = []
  for (var i = 0; i < lists.length; i++) {
    var list = lists[i] || []
    for (var j = 0; j < list.length; j++) {
      var d = list[j]
      if (!d) continue
      var name = sameDeviceKey(d.name)
      if (seen[name]) continue
      seen[name] = true
      out.push(d)
    }
  }
  // Offline entries last, then lowest battery first.
  out.sort(function(a, b) {
    if (!!a.offline !== !!b.offline) return a.offline ? 1 : -1
    return a.level - b.level
  })
  return out
}

// Returns the devices that just crossed below `threshold` while discharging
// and the updated set of already-notified keys. A device re-arms once it is
// charging or back above threshold + 5.
function lowBatteryAlerts(devices, threshold, notified) {
  var next = {}
  var alerts = []
  for (var i = 0; i < devices.length; i++) {
    var d = devices[i]
    if (d.offline) continue
    var low = !d.charging && d.level <= threshold
    var wasNotified = notified && notified[d.key] === true
    if (low && !wasNotified) alerts.push(d)
    if (low || (wasNotified && !d.charging && d.level <= threshold + 5)) next[d.key] = true
  }
  return { alerts: alerts, notified: next }
}

// Infer charging for gadgets that cannot tell (charging === null), such as a
// Logitech mouse on its cable (UPower "unknown") or a Xinmeng 2.4G keyboard.
// It is never inferred against an explicit true/false. Levels from such
// sources jitter by about 1 point, so charging is only estimated once the
// level is MIN_RISE points above the lowest level seen within RISE_WINDOW
// seconds. Any drop restarts the window and does not become its baseline
// (a jitter dip like 66 -> 65 must not turn the next 67 into a 2-point
// rise): the window starts again at the following reading. The estimate lasts RISE_WINDOW
// seconds after the last such rise. `trends` is key -> {level, samples,
// riseTs} (samples: [[ts, level], ...] inside the window) and is returned
// updated; devices come back with `chargingEstimated` set.
var RISE_WINDOW = 1200
var MIN_RISE = 2

function applyTrends(devices, trends, nowSec) {
  var next = {}
  var out = []
  for (var i = 0; i < devices.length; i++) {
    var d = Object.assign({}, devices[i])
    var prev = trends ? trends[d.key] : null
    var samples = prev && prev.samples ? prev.samples.slice() : []
    var riseTs = prev ? prev.riseTs || 0 : 0
    var level = d.offline && prev ? prev.level : d.level
    if (!d.offline) {
      if (prev && d.level < prev.level) {
        samples = []
        riseTs = 0
      } else {
        samples = samples.filter(function(s) { return nowSec - s[0] <= RISE_WINDOW })
        if (samples.length === 0 || samples[samples.length - 1][1] !== d.level) samples.push([nowSec, d.level])
        var lowest = Math.min.apply(null, samples.map(function(s) { return s[1] }))
        var rose = !prev || d.level > prev.level
        if (rose && d.level - lowest >= MIN_RISE) riseTs = nowSec
      }
    }
    if (riseTs && nowSec - riseTs > RISE_WINDOW) riseTs = 0
    d.chargingEstimated = d.charging === null && !d.offline && riseTs > 0
    if (d.charging === null) d.charging = d.chargingEstimated
    next[d.key] = { level: level, samples: samples, riseTs: riseTs }
    out.push(d)
  }
  return { devices: out, trends: next }
}

// UI strings. Spanish when the session locale is Spanish, English otherwise.
var STRINGS = {
  en: {
    title: "Gadgets",
    charging: "CHARGING",
    chargingEstimated: "CHARGING (ESTIMATED)",
    offline: "Offline",
    lowTitle: "Low battery: %1",
    lowBody: "%1% left",
    fullTitle: "Fully charged: %1",
    fullBody: "You can unplug it"
  },
  es: {
    title: "Gadgets",
    charging: "CARGANDO",
    chargingEstimated: "CARGANDO (ESTIMADO)",
    offline: "Sin conexión",
    lowTitle: "Batería baja: %1",
    lowBody: "%1% restante",
    fullTitle: "Carga completa: %1",
    fullBody: "Ya puedes desconectarlo"
  }
}

function languageFromLocale(locale) {
  return /^es([_.@-]|$)/i.test(String(locale || "")) ? "es" : "en"
}

function tr(lang, key, arg) {
  var table = STRINGS[lang] || STRINGS.en
  var text = table[key] !== undefined ? table[key] : STRINGS.en[key]
  return arg === undefined ? text : text.replace("%1", arg)
}

// The `names` setting renames gadgets: { "Reported name": "Your name" }.
function applyNames(devices, names) {
  if (!names || typeof names !== "object") return devices
  return devices.map(function(d) {
    var name = names[d.name]
    return typeof name === "string" && name !== "" ? Object.assign({}, d, { name: name }) : d
  })
}
