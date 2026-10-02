for f in */; do
  magick identify -format "%wx%h\n" "$f"*.JPG 2>/dev/null | head -1
done | sort | uniq -c