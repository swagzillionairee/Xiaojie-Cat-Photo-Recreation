# Xiaojie Palette Steal

Recreate a fixed photo of my cat Xiaojie using only the colours that exist in a photo you upload. Upload a sunset and you get a sunset toned cat. Upload a forest and you get a forest toned cat. It borrows colours, not pixel positions, so a source colour can be reused as many times as it needs to be.

## What it does

For every pixel in the cat image it finds the nearest colour in the palette of your uploaded photo and paints that colour in the cat's place. The cat's original transparency is preserved so its edges stay clean. Colour distance is measured in CIELAB by default, which tracks how the human eye judges "nearest", so the output looks far better than matching in raw RGB.

## Before and after

Drop your own `assets/xiaojie.jpg` in place, open the tool, and upload any photo. The three panels show the target cat on the left, your uploaded source in the middle, and the recreated cat on the right. A quick example flow:

```
target: a photo of Xiaojie   +   source: a sunset over water   =   Xiaojie rendered in sunset oranges and purples
```

(There is no committed sample image. See the note below about `assets/xiaojie.jpg`.)

## How the algorithm works

The cat image is read into an RGBA pixel array once. When you upload a source photo, the tool collects the source colours and, if there are more unique colours than the palette cap, reduces them with median cut so the palette still reflects the source's real colour spread. Every unique cat colour is then matched to its nearest palette colour in CIELAB (or RGB if you flip the toggle), and that result is cached so the whole cat is recoloured in a single fast pass. All of this runs inside a Web Worker, so the page never freezes and a progress bar tracks the work.

## Running locally

Because the tool uses a Web Worker, it has to be served over http. Opening `index.html` straight from the file system with a `file://` URL will not work, since browsers block worker loads from that origin.

From the project root, run one of:

```
npx serve
```

or

```
python -m http.server 8000
```

Then open the address it prints (for example `http://localhost:8000`) in your browser.

## The `assets/xiaojie.jpg` file

The target cat image lives at `assets/xiaojie.jpg` and is not committed to the repo. Drop your own image at that path before running. If the file is missing, the tool tells you clearly both on screen and in the browser console, so you will know exactly what to add.

## Controls

* Palette size slider, from 256 to 8192 colours. Bigger palettes capture more of the source's colour range at the cost of a little more compute.
* Colour distance toggle, LAB (perceptual, the default) or RGB (raw). LAB almost always looks better.
* Download PNG, saves the recreated cat.

The tool recreates the cat automatically when you upload and again whenever you change a control.

## Roadmap

These are stubbed for a future version:

* Distribution match mode, which preserves the cat's tonal range while pulling colours from the source, instead of pure nearest colour.
* Floyd and Steinberg dithering to reduce banding on small palettes.
* Optional foreground masking so only the cat is recoloured, not the background.
* A deploy config and a live demo link.

## Tech

Vanilla HTML, CSS, and JavaScript. No framework and no build step. The heavy pixel work lives in `js/worker.js`; the UI wiring lives in `js/main.js`.
