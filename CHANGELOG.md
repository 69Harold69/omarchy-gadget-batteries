# Changelog

## 1.2.1

- **No more false "charging (estimated)":** sources that cannot tell whether a
  gadget charges now report `charging: null` (the Xinmeng dongle, external
  entries without the field, UPower's "unknown" state). Charging is estimated
  only for those, never against an explicit true/false, and only for a rise
  of 2+ points over the lowest level in the 20-minute window, so the
  dongle's ±1 jitter is ignored.
- `tests/collectors_test.py` no longer passes without running anything when
  python-dbus is missing.

## 1.2.0

- **AirPods:** only adverts whose model matches the connected pair (Modalias
  product id vs. advert bytes 3-4) are used, so someone else's AirPods nearby
  are never shown as yours. Without a readable Modalias, only adverts from
  -55 dBm or closer count. Each pair is scanned for on its own Bluetooth
  adapter.
- **AirPods:** the radio is scanned at most every 5 minutes (right away while
  the panel is open) to avoid audio dropouts on combined Wi-Fi/Bluetooth
  chips; entries stay online in between (TTL 360 s).
- The fully-charged notification uses normal urgency, so it closes on its own;
  low battery stays critical. `notify-once` takes an optional urgency.
- `lowThreshold` 0 turns low-battery notifications off.
- Rows only open Solaar or GalaxyBudsClient when the app is installed.
- README: why the widget can look missing (no gadget reports a battery) and
  how to check with `upower -d`.
- Manifest category is Hardware, matching the marketplace listing.

## 1.1.0

First public release.
