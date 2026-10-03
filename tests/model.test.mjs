// Run with: node tests/model.test.mjs
// Loads Model.js (a QML .pragma library) as plain JavaScript.
import { readFileSync } from "node:fs"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8").replace(".pragma library", "")
const M = new Function(source + "; return { fromExternal, fromBudsStatus, fromHeadsetControl, mergeDevices, " +
  "lowBatteryAlerts, applyTrends, applyNames, languageFromLocale, tr, sameDeviceKey, fromUPower }")()

// External JSON: TTL turns entries offline, parts become the detail line.
const ext = M.fromExternal(JSON.stringify([
  { id: "a", name: "Speaker", kind: "speaker", pct: 64, ts: 900, ttl: 900 },
  { id: "b", name: "Watch", kind: "watch", pct: 5, ts: 0, ttl: 60 },
  { id: "c", name: "Pods", kind: "earbuds", pct: 40, left: 40, right: 70 },
  { name: "no level" },
]), 1000)
assert.deepEqual(ext.map(d => [d.name, d.kind, d.level, d.offline]),
  [["Speaker", "speaker", 64, false], ["Watch", "watch", 5, true], ["Pods", "earbuds", 40, false]])
assert.equal(ext[2].detail, "L 40% · R 70%")

// HeadsetControl skips headsets whose battery cannot be read.
const hs = M.fromHeadsetControl(JSON.stringify({ devices: [
  { device: "G522", battery: { status: "BATTERY_AVAILABLE", level: 59 } },
  { device: "Off", battery: { status: "BATTERY_UNAVAILABLE", level: -1 } },
] }))
assert.deepEqual(hs.map(d => [d.name, d.level]), [["G522", 59]])

// Galaxy Buds: lowest earbud, case only in the detail.
const buds = M.fromBudsStatus(JSON.stringify({ connected: true, device_name: "Buds", battery: {
  left: { available: true, level: 80 }, right: { available: true, level: 12 },
  case: { available: true, level: 55 } } }))
assert.equal(buds[0].level, 12)
assert.equal(buds[0].detail, "L 80% · R 12% · Case 55%")

// Same gadget from two sources: first (more detailed) wins, offline sorts last.
assert.equal(M.sameDeviceKey("Logitech G522 LIGHTSPEED - USB Mode"), M.sameDeviceKey("G522 LIGHTSPEED"))
const merged = M.mergeDevices([[{ key: "s", name: "Logitech G502 X PLUS", level: 50 }],
  [{ key: "u", name: "G502 X PLUS", level: 27 }, { key: "o", name: "Old", level: 1, offline: true }]])
assert.deepEqual(merged.map(d => d.key), ["s", "o"])

// Low battery fires once, never for offline or charging gadgets.
let alerts = M.lowBatteryAlerts([{ key: "k", level: 10 }, { key: "x", level: 3, offline: true }], 15, {})
assert.deepEqual(alerts.alerts.map(d => d.key), ["k"])
assert.equal(M.lowBatteryAlerts([{ key: "k", level: 10 }], 15, alerts.notified).alerts.length, 0)

// Charging is only estimated when the source cannot tell (charging null),
// and only for a rise of 2+ points over the window's lowest level.
const estimates = (levels, charging, step = 60) => {
  let trends = {}
  return levels.map((level, i) => {
    const r = M.applyTrends([{ key: "k", level, charging }], trends, i * step)
    trends = r.trends
    return r.devices[0].chargingEstimated
  })
}
// +-1 jitter, as a Xinmeng dongle reports it: never charging.
assert.deepEqual(estimates([65, 66, 65, 66, 67], null), [false, false, false, false, false])
// A real 2-point rise: charging.
assert.deepEqual(estimates([60, 62], null), [false, true])
// Explicit false (or true) is never contradicted.
assert.deepEqual(estimates([60, 62, 64, 66], false), [false, false, false, false])
let r = M.applyTrends([{ key: "k", level: 50, charging: true }], {}, 0)
assert.equal(r.devices[0].charging, true)
assert.equal(r.devices[0].chargingEstimated, false)
// Slow charging: 1 point every 5 minutes still adds up within 20 minutes.
assert.deepEqual(estimates([40, 41, 42], null, 300), [false, false, true])
// A drop restarts the window; the estimate expires 20 minutes after the last rise.
assert.deepEqual(estimates([60, 62, 61, 62], null), [false, true, false, false])
// A real charge after a drop is still caught, from the reading after the drop.
assert.deepEqual(estimates([70, 69, 69, 70, 71], null), [false, false, false, false, true])
let trends = {}
const at = (level, now) => {
  const res = M.applyTrends([{ key: "m", level, charging: null }], trends, now)
  trends = res.trends
  return res.devices[0].chargingEstimated
}
assert.deepEqual([at(27, 0), at(29, 60), at(29, 600), at(29, 1400)], [false, true, true, false])
// Unknown charging that is not estimated shows as not charging.
assert.equal(M.applyTrends([{ key: "k", level: 50, charging: null }], {}, 0).devices[0].charging, false)

// External entries keep "don't know" as null.
assert.deepEqual(M.fromExternal(JSON.stringify([
  { name: "a", pct: 1, charging: true }, { name: "b", pct: 1, charging: false }, { name: "c", pct: 1 },
]), 0).map(d => d.charging), [true, false, null])

// UPower: "unknown" state means null, other states are known.
const upower = state => M.fromUPower({ isPresent: true, percentage: 0.5, state, nativePath: "x" },
  "Mouse", "CHARGING", "UNKNOWN").charging
assert.deepEqual([upower("CHARGING"), upower("DISCHARGING"), upower("UNKNOWN")], [true, false, null])

// Renames and translations.
assert.equal(M.applyNames([{ name: "M87 keyboard (2.4G)" }], { "M87 keyboard (2.4G)": "My keyboard" })[0].name, "My keyboard")
assert.equal(M.languageFromLocale("es_MX.UTF-8"), "es")
assert.equal(M.languageFromLocale("en_US.UTF-8"), "en")
assert.equal(M.tr("es", "lowBody", 12), "12% restante")
assert.equal(M.tr("fr", "charging"), "CHARGING")

console.log("model tests passed")
