#!/usr/bin/env node
//
// generate-images.js  (v2)
//
// Walks every numbered folder ("1", "2", "3", ...) and writes nine
// derived files per folder from the master image:
//
//   preview.avif / preview.webp / preview.jpg    400px   hover thumbnail
//   mid.avif     / mid.webp     / mid.jpg        1600px  tablets, lightbox 1x
//   full.avif    / full.webp    / full.jpg       3200px  retina + zoom
//
// 3200px is chosen to cover a 1600 CSS-px display at 2x device pixels
// (retina), which is the largest the lightbox ever needs unzoomed. At
// zoom it renders ~4300 CSS px wide, so 3200 is a modest 1.35x
// enlargement rather than a blurry blow-up.
//
// One pass through sharp: decode once, emit every size in every format.
//
// Usage:
//   cd <your Morten folder>
//   npm install sharp
//   node generate-images.js --dry-run
//   node generate-images.js
//
// Options:
//   --dry-run      report only, write nothing
//   --force        redo folders that already have output
//   --only <n>     process just folder <n>
//   --clean        delete generated files and stop (no encoding)

const fs = require("fs");
const path = require("path");

let sharp;
try {
  sharp = require("sharp");
} catch (e) {
  console.error("sharp is not installed in this folder.\n");
  console.error("Run this first:\n    npm install sharp\n");
  process.exit(1);
}

// ------------------------------------------------------------------ config
const SIZES = [
  { name: "preview", width: 400,  quality: { avif: 62, webp: 80, jpg: 82 } },
  { name: "mid",     width: 1600, quality: { avif: 68, webp: 84, jpg: 86 } },
  { name: "full",    width: 3200, quality: { avif: 72, webp: 88, jpg: 90 } },
];

// Quality is per format on purpose. AVIF carries far more quality per
// byte, so its numbers sit lower — comparing them across formats is
// meaningless. If AVIF looks soft on flat colour at 100% zoom, raise
// its number by 5 and re-run with --force on one folder.

const EXTS = ["avif", "webp", "jpg"];
const GENERATED = new Set();
for (const s of SIZES) for (const e of EXTS) GENERATED.add(`${s.name}.${e}`);

const ORIG_ARCHIVE = /\.orig\.(jpe?g|png|tiff?|webp|avif)$/i;
const MASTER_EXT   = /\.(jpe?g|png|tiff?|webp|avif)$/i;

// -------------------------------------------------------------------- args
const args   = process.argv.slice(2);
const DRY    = args.includes("--dry-run");
const FORCE  = args.includes("--force");
const CLEAN  = args.includes("--clean");
const ONLY_IX = args.indexOf("--only");
const ONLY   = ONLY_IX !== -1 ? String(args[ONLY_IX + 1]) : null;

// ------------------------------------------------------------------ helpers
const mb = (b) => (b / 1048576).toFixed(2) + " MB";
const kb = (b) => (b / 1024).toFixed(0) + " KB";
const pad = (s, n) => String(s).padEnd(n);

function folders() {
  return fs.readdirSync(".", { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => d.name)
    .filter((n) => (ONLY ? n === ONLY : true))
    .sort((a, b) => Number(a) - Number(b));
}

/* The master is the largest image that is not one of our generated
   names and not an archived .orig.* — so the original keeps being the
   source even as the derived files sit beside it. */
function findMaster(dir) {
  const files = fs.readdirSync(dir).filter((f) => MASTER_EXT.test(f));
  const cands = files.filter(
    (f) => !GENERATED.has(f) && !ORIG_ARCHIVE.test(f) && !f.startsWith(".")
  );
  let best = null, bestSize = -1;
  for (const f of cands) {
    const s = fs.statSync(path.join(dir, f)).size;
    if (s > bestSize) { bestSize = s; best = f; }
  }
  return best;
}

function removeGenerated(dir) {
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (GENERATED.has(f)) { fs.unlinkSync(path.join(dir, f)); n++; }
  }
  return n;
}

// -------------------------------------------------------------------- work
async function main() {
  const list = folders();
  if (!list.length) {
    console.error("No numbered folders found here.");
    console.error("Current directory: " + process.cwd());
    process.exit(1);
  }

  if (CLEAN) {
    let total = 0;
    for (const f of list) total += removeGenerated(f);
    console.log("Removed " + total + " generated files from " + list.length + " folders.");
    console.log("Masters and any .orig.* backups were left alone.");
    return;
  }

  console.log("sharp   : " + sharp.versions.sharp + "  (libvips " + sharp.versions.vips + ")");
  console.log("folders : " + list.length + (ONLY ? "  (--only " + ONLY + ")" : ""));
  console.log("sizes   : " + SIZES.map((s) => s.name + " " + s.width + "px").join(", "));
  if (DRY) console.log("mode    : DRY RUN — nothing will be written");
  console.log("");

  let done = 0, skipped = 0, failed = 0;
  let masterBytes = 0, outBytes = 0;
  const failures = [];
  const undersized = [];

  for (const folder of list) {
    const master = findMaster(folder);
    if (!master) {
      console.log("  " + pad(folder, 4) + " — no master image, skipped");
      skipped++; continue;
    }
    const masterPath = path.join(folder, master);

    if (!FORCE && GENERATED.size && EXTS.every((e) => fs.existsSync(path.join(folder, "full." + e)))) {
      console.log("  " + pad(folder, 4) + " — already generated (use --force to redo)");
      skipped++; continue;
    }

    try {
      const meta = await sharp(masterPath, { failOn: "none" }).metadata();
      const mw = meta.width || 0, mh = meta.height || 0;

      if (DRY) {
        const note = mw < 3200 ? "  <-- master smaller than 3200, full will cap at " + mw : "";
        console.log("  " + pad(folder, 4) + pad(master, 24) + mw + "x" + mh +
                    "  -> " + SIZES.map((s) => s.width).join("/") + "px" + note);
        done++; continue;
      }

      if (mw < 3200) undersized.push(folder + " (" + mw + "px)");

      masterBytes += fs.statSync(masterPath).size;
      const out = [];

      for (const size of SIZES) {
        // never upscale — cap at the master's own width
        const w = Math.min(size.width, mw || size.width);
        const make = () => sharp(masterPath, { failOn: "none" })
          .rotate()                                  // honour EXIF orientation
          .resize({ width: w, withoutEnlargement: true })
          .withMetadata(false);                      // strip metadata

        await make().avif({ quality: size.quality.avif, effort: 4 })
          .toFile(path.join(folder, size.name + ".avif"));
        await make().webp({ quality: size.quality.webp, effort: 5 })
          .toFile(path.join(folder, size.name + ".webp"));
        await make().jpeg({ quality: size.quality.jpg, progressive: true, mozjpeg: true })
          .toFile(path.join(folder, size.name + ".jpg"));

        for (const e of EXTS) {
          const p = path.join(folder, size.name + "." + e);
          const b = fs.statSync(p).size;
          if (b < 512) throw new Error("suspiciously small output: " + p);
          outBytes += b;
        }
        out.push(size.name + " " + kb(fs.statSync(path.join(folder, size.name + ".avif")).size) + "a");
      }

      console.log("  " + pad(folder, 4) + " ok  " + out.join("  "));
      done++;
    } catch (err) {
      console.log("  " + pad(folder, 4) + " FAILED: " + err.message);
      failures.push(folder + ": " + err.message);
      failed++;
    }
  }

  console.log("");
  console.log("---------------------------------------------");
  console.log("generated : " + done);
  console.log("skipped   : " + skipped);
  console.log("failed    : " + failed);

  if (!DRY && masterBytes > 0) {
    console.log("masters   : " + mb(masterBytes));
    console.log("output    : " + mb(outBytes) + "   (9 files per folder)");
  }

  if (undersized.length) {
    console.log("");
    console.log("Masters below 3200px (full.jpg capped to their own width):");
    for (const u of undersized) console.log("  " + u);
  }

  if (failures.length) {
    console.log("");
    console.log("Failures:");
    failures.slice(0, 20).forEach((f) => console.log("  " + f));
    if (failures.length > 20) console.log("  ... and " + (failures.length - 20) + " more");
  }
}

main().catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
