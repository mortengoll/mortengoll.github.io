#!/bin/bash
# Generates preview.jpg (400px), mid.jpg (1600px) and full.jpg
# for every #N folder in this directory.

set -e

for d in \#*/; do
  n="${d%/}"
  src=$(find "$n" -maxdepth 1 -iname "*.jpg" -o -maxdepth 1 -iname "*.jpeg" | head -n 1)

  if [ -z "$src" ]; then
    echo "skip $n — no image found"
    continue
  fi

  echo "processing $n"

  magick "$src" -auto-orient -resize 400x400\> \
         -strip -quality 95 "$n/preview.jpg"

  magick "$src" -auto-orient -resize 1600x1600\> \
         -strip -quality 95 "$n/mid.jpg"

  magick "$src" -auto-orient -strip -quality 95 "$n/full.jpg"

done

echo "done"
