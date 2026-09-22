#!/bin/bash
# OCR one frame of the LabView capture.
# Emits: frame,screen,clock,tiefe,spanndruck,panel_rgb,volumen,label
#
# The screen layout is identified by which clock position parses, so the
# classification falls out of the time reading for free.
#
# The Spanndruck panel is white text on a red/yellow/green backdrop that
# encodes a value band, and it is not always shown. All three backdrops have
# near-zero blue, so isolating the blue channel lifts the white text off any of
# them; an absent panel is plain grey and simply reads empty. The mean colour
# is recorded separately, because which band the rig considered itself in is
# information the MQTT feed does not carry.
f="$1"
# An empty or missing argument must not surface as a plausible-looking
# "unknown" row: that is indistinguishable from a frame we genuinely could not
# read, and it silently inflates the sample count.
if [[ -z "$f" || ! -f "$f" ]]; then exit 0; fi
n=$(basename "$f" .png)

gray() { magick "$f" -crop "$1" +repage -colorspace Gray -resize 400% -threshold 60% \
  -bordercolor white -border 10 png:- 2>/dev/null \
  | tesseract stdin stdout -l deu --psm 7 -c tessedit_char_whitelist="$2" 2>/dev/null | tr -d '\n\r' | tr ',' '.'; }
blue() { magick "$f" -crop "$1" +repage -channel B -separate -resize 400% -threshold 50% \
  -bordercolor black -border 10 -negate png:- 2>/dev/null \
  | tesseract stdin stdout -l deu --psm 7 -c tessedit_char_whitelist="$2" 2>/dev/null | tr -d '\n\r' | tr ',' '.'; }
rgb()  { magick "$f" -crop "$1" +repage \
  -format "%[fx:int(mean.r*255)] %[fx:int(mean.g*255)] %[fx:int(mean.b*255)]" info: 2>/dev/null; }

D='0123456789'; DC='0123456789,'; T='0123456789:'

clock=$(gray 220x34+140+118 "$T")
if [[ "$clock" =~ ^[0-9]{2}:[0-9]{2}:[0-9]{2}$ ]]; then
  screen=bohren
  tiefe=$(gray 175x65+860+355 "$DC"); spann=$(blue 180x50+858+598 "$DC")
  panel=$(rgb 180x130+858+535)
  vol=$(gray 68x30+952+172 "$D");     label=""
else
  clock=$(gray 110x28+430+55 "$T")
  if [[ "$clock" =~ ^[0-9]{2}:[0-9]{2}:[0-9]{2}$ ]]; then
    screen=verpressen
    tiefe=$(gray 172x56+858+402 "$DC"); spann=$(blue 190x45+845+675 "$DC")
    panel=$(rgb 190x110+845+620)
    vol=$(gray 80x28+952+193 "$D");     label=$(gray 160x28+430+82 'Austausch0123456789 ')
  else
    screen=unknown; clock=""; tiefe=""; spann=""; panel=""; vol=""; label=""
  fi
fi
echo "$n,$screen,$clock,$tiefe,$spann,$panel,$vol,$label"
