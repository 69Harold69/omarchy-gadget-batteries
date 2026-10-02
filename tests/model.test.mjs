// Run with: node tests/model.test.mjs
// Loads Model.js (a QML .pragma library) as plain JavaScript.
import { readFileSync } from "node:fs"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8").replace(".pragma library", "")
const M = new Function(source + "; return { fromExternal, fromBudsStatus, fromHeadsetControl, mergeDevices, " +
  "lowBatteryAlerts, applyTrends, applyNames, languageFromLocale, tr, sameDeviceKey }")()

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

// Charging inferred from a rising level, cleared by a drop or after 20 min.
let trends = {}
const step = (level, now) => {
  const r = M.applyTrends([{ key: "m", level, charging: false }], trends, now)
  trends = r.trends
  return r.devices[0].chargingEstimated
}
assert.deepEqual([step(27, 0), step(28, 60), step(28, 600), step(28, 1400), step(29, 1500), step(27, 1560)],
  [false, true, true, false, true, false])

// Renames and translations.
assert.equal(M.applyNames([{ name: "M87 keyboard (2.4G)" }], { "M87 keyboard (2.4G)": "My keyboard" })[0].name, "My keyboard")
assert.equal(M.languageFromLocale("es_MX.UTF-8"), "es")
assert.equal(M.languageFromLocale("en_US.UTF-8"), "en")
assert.equal(M.tr("es", "lowBody", 12), "12% restante")
assert.equal(M.tr("fr", "charging"), "CHARGING")

console.log("model tests passed")
