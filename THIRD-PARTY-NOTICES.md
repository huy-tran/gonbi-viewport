# Third-party notices

Everything shipped in this extension is either written here or listed below.

## Hugeicons (free set) - MIT

`src/data/icons.js` is generated from [`@hugeicons/core-free-icons`][pkg] by
`tools/build-hugeicons.mjs`, and `assets/icons/*.png` are rasterised from one of
those icons. The header of `src/data/icons.js` records which Hugeicons export
each entry came from.

The package is a development dependency, so its own `LICENSE` is not committed.
Its notice is reproduced here to satisfy the MIT attribution requirement.

[pkg]: https://www.npmjs.com/package/@hugeicons/core-free-icons

```
MIT License

Copyright (c) Hugeicons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Device frames

`assets/frames/*.svg` are drawn by `tools/build-frames.mjs` from the viewport
dimensions in `src/data/devices.js`. They are original work under this
repository's licence.

An earlier revision used third-party device photography whose licence did not
permit redistribution. Those images and the pipeline that processed them have
been removed; nothing here derives from them.

## Device names

Device and browser names are trademarks of their respective owners and are used
only to identify which hardware a viewport corresponds to.

## Development dependencies

`tools/` uses `pngjs`, `jpeg-js`, `puppeteer-core` and `prettier`. None are
bundled into the extension; install them with `npm install` in `tools/`.
