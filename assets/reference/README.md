# Field reference data — Bohrung G08, Marktbreit, 18.05.2026

`../bohrung_g8_marktbreit_mqtt.txt` is a raw capture of every MQTT message
published by the box on a live Injektionsbohren rig, 14:49:06 to 16:59:04
(2h10m, 275 935 messages). It is **not in the repo** — at 15 MB it is kept
beside it and gitignored, so ask for a copy if you need the full session; the
tests run off the two slices in `server/test-fixtures/` instead. One message
per line:

```
2026-05-18 15:42:40.190 Bohrgeraet/Tiefe 3.247500
<date>     <time>       <topic>          <payload>
```

The payload is a raw value, never JSON. `nan` appears occasionally and must be
treated as "no reading", not as zero.

## Why this file exists

It is the only recording of what a real rig actually publishes, and the two
screenshots beside it are the only record of what the operator saw while it was
being published. Together they are ground truth: a claim about how the kiosk
should interpret this data can be checked instead of argued about.

The screenshots are frames from a video of the old LabView UI
(`KI-B-MQTT V2026.5.7.109`) recorded during the same session.

## Topics

| Topic | Messages | Range | Notes |
|---|---:|---|---|
| `Bohrgeraet/Tiefe` | 26 699 | −6.81 … 7.52 | **Carriage position, not hole depth** — see below |
| `Bohrgeraet/Klemmdruck` | 26 700 | 1609 … 5558 | Clamp pressure, bimodal. Not bar |
| `Bohrgeraet/Drehzahl` | 26 699 | 0 … 81.2 | |
| `Bohrgeraet/Ziehgeschwindigkeit` | 26 699 | −121.7 … 144.0 | |
| `Bohrgeraet/Winkel` | 26 700 | 0 … 984 612 | Contains implausible spikes |
| `Maschine/Druck_Hammer` | 26 423 | 0.94 … 177.7 | |
| `Maschine/Druck_Medium` | 26 416 | −76.8 … 119.9 | |
| `Maschine/Druck_innen` | 26 416 | −103.1 … 217.5 | |
| `Maschine/Druck_aussen` | 26 419 | −129.1 … 277.2 | |
| `Maschine/Druck_Vorschub` | 26 417 | −264.1 … 225.6 | |
| `Spuelpumpe/Durchfluss` | 2 586 | 0 … 1046.5 | |
| `Spuelpumpe/Volumen` | 2 587 | 70 … 41 912.5 | Cumulative, monotonic |
| `Verpresspumpe/Durchfluss` | 2 586 | 0 … 167.4 | |
| `Verpresspumpe/Volumen` | 2 588 | 98 … 1176 | Cumulative, monotonic |

Note the naming: this rig publishes `Bohrgeraet/Klemmdruck`, not `Klemmbacke`,
and topic names are capitalised. Topic assignment has to be wired on site —
none of these match a sensor name from `injektionsbohren-sensors-herstellen.csv`
directly.

## Ground truth from the screenshots

### `g8-bohren-15-42-43.png` — drilling, video clock 15:42:43

| On screen | In the dump at 15:42:4x | |
|---|---|---|
| Drehzahl 71,1 | `Bohrgeraet/Drehzahl` 70.2 … 72.0 | matches |
| Tiefe 29,37 | `Bohrgeraet/Tiefe` 3.2475 | **does not match** |
| Gesamtvol. diese Bohrung 27 480 l | `Spuelpumpe/Volumen` 27 518 | matches minus a baseline of ~70 |
| Bohrung G08, Geologie Kalkstein, Referenz Höhe 0 m | — | operator input, not published |

### `g8-verpressen-16-09-16.png` — grouting, video clock 16:09:16

| On screen | In the dump at 16:09:1x | |
|---|---|---|
| Druck Medium 0,8 | `Maschine/Druck_Medium` 0.783 | matches |
| Tiefe 43,02 | `Bohrgeraet/Tiefe` 6.1825 | **does not match** |
| Gesamtvolumen seit Reset 482 l | `Verpresspumpe/Volumen` 588 | matches minus the reset baseline of ~106 |
| „Austausch 1" | — | operator input |

The two clocks agree to within a few seconds. The displayed volumes are
counters relative to a reset point, not the raw cumulative values: the
Verpresspumpe counter was reset at ~106 l, which is the value it held when
grouting began.

## What the data says about the depth signal

`Bohrgeraet/Tiefe` sweeps between −6.8 and +7.5 m about forty times in two
hours, travelling at up to 1.8 m/s. It is the position of the Drehantrieb on
the mast — it cannot be the depth of a hole that reaches 43 m. The old UI has
„Tiefe setzen" and „Referenz Tiefe setzen" buttons, so the absolute depth on
screen is derived there, not published.

**G08 is a retrofitted machine.** Both kinds exist in the fleet: some
manufacturers publish an absolute depth over CAN, and the ones Implenia
retrofits publish the Schlittenweg. The kiosk supports both — `depthMode`,
`absolut` or `inkrementell`, set per machine. This capture is the reference
case for `inkrementell`.

Replaying the recorded Rohrwechsel at 15:46:31 through the state machine both
ways shows what the setting is worth:

| depthMode | worst backwards step | end vs. start |
|---|---:|---|
| `absolut` | **−5,63 m** | ends shallower than it began |
| `inkrementell` | 0,00 m | +7,3 m, continuous |

Checked against the screenshots: between 15:42:43 (29,37 m) and the end of
drilling (43,02 m) the hole gained **13,65 m across 7 clamp closures — 1,95 m
per closure**, i.e. one 2 m Bohrrohr each.

Note that the carriage travels considerably further than 1,95 m between
closures, so the offset the state machine derives is continuous but its
absolute magnitude has not yet been checked against the depth the operator
actually saw. That is what the video correlation is for — see below.

## Correlating the video against the capture

A screen recording of the same session exists (2 h 1 m, 1058×792). It is not
in the repo — 3.2 GB — but the two things derived from it are:

- `g8-video-vs-mqtt.csv` — 1 152 samples, one every 5 s, pairing what the
  operator saw against what the rig published at the same instant.
- `ocr-frame.sh` — the reader that produced it, so the next capture costs one
  command instead of an afternoon.

```bash
ffmpeg -i <video>.mp4 -vf fps=1/5 frames/%05d.png       # ~1 450 frames for 2 h
ls frames/*.png | xargs -P 4 -n 1 ./ocr-frame.sh > ocr.csv
```

The method relies on the app drawing **its own clock on screen**, so every
sample aligns itself to the capture and no drift estimate is needed. Which of
the two clock positions parses also says which screen was showing, so the
Bohren/Verpressen classification comes free. Columns: `clock, screen, label,
displayed_tiefe, carriage, offset, displayed_spann, klemmdruck, panel,
displayed_vol`.

OCR quality, checked against `Bohrgeraet/Klemmdruck`, which is displayed as
„Spanndruck" and published: 256 of 431 paired samples agree to within 1 unit.
The rest are mostly the ±2 s join window against a fast-moving signal rather
than misreads. The depth field is the reliable one — it is large, slow, and was
verified exactly against both screenshots.

### What it settled: there is a scale factor

The displayed depth rises 0 → 43,02 m across the drilling phase, and gains
**≈1,95 m in every drilling stretch** — one 2 m Bohrrohr, confirmed twenty-odd
times over.

But the carriage moves **~2,6 m for every metre of hole**. Over 123 adjacent
drilling samples the ratio of displayed movement to carriage movement is
**0,379** (median of per-pair ratios 0,369), and it is stable across the whole
session. So the relationship is not `tiefe = schlittenweg + offset` but

```
tiefe = schlittenweg × skalierung + offset
```

The depth sensor on a retrofitted rig measures the feed mechanism, not the
hole. The factor is a property of that machine's mechanics and calibration, so
`depthScale` is a per-rig setting (default 1). Replaying the 15:46:31
Rohrwechsel proves it: at scale 0,3793 the model gains 2,75 m over the window,
against the ~2,7 m the operator watched; at scale 1 it claims 7,26 m.

**Do not treat 0,3793 as a constant.** It is this machine's, measured this way.
The kiosk's per-pipe check reports the scale it would take to make the numbers
add up, so a new rig is calibrated by drilling two pipes and reading the
warning.

## Session timeline

| From | To | Phase |
|---|---|---|
| 14:49 | 15:00 | idle — Drehzahl 0, clamp open, no flow |
| 15:00 | 16:02 | **Bohren** — Spuelpumpe 2 004 → 41 912 l, 22 clamp closures |
| ~16:02:5x | | **switch to Verpressen** — Spuelpumpe stops, Verpresspumpe counter reset at ~106 l |
| 16:02 | 16:10 | **Verpressen** — Verpresspumpe 106 → 770 l, Drehzahl 0 |
| 16:10 | 16:59 | withdrawing and further grouting — 21 more clamp closures, 770 → 1176 l |

43 clamp closures in total. Only about half are pipe extensions; the rest are
the string being pulled back out, which cycles the clamp identically.

## Clamp thresholds for this rig

`Bohrgeraet/Klemmdruck` is cleanly two-state, with an almost empty valley
between the modes:

```
1500-1749  ####################### 9275
1750-1999  ###                     1413
2000-3499                           ~190   <- valley, ~1% of samples
3500-3749                             88
3750-3999  ########                3581
4000-4249  ##########              4088
4250-4499  #########               3908
4500-4749  #######                 2898
4750-4999  #                        783
```

Open ≈ 1650, closed ≈ 4200. The kiosk defaults (closed ≥ 100, open < 50) assume
bar and are wrong here; **≥ 3500 / < 2500** separates the modes with a wide dead
band. Whatever unit this is, it is not bar — configure it per rig.
