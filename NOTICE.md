# Third-party notices

NIGHTSHIFT itself is MIT licensed — see [LICENSE](LICENSE). Bundled third-party work keeps
its own license.

## Silkscreen (typeface)

The floor is meant to render with the network unplugged, so the Silkscreen typeface is
embedded as base64 in [`web/src/fonts.css`](web/src/fonts.css) rather than fetched.

- Copyright 2001 The Silkscreen Project Authors — https://github.com/googlefonts/silkscreen
- SIL Open Font License 1.1, reproduced in full at
  [`licenses/Silkscreen-OFL.txt`](licenses/Silkscreen-OFL.txt)

The font is **not** covered by this project's MIT license. If you redistribute NIGHTSHIFT,
keep that license file with it.

## Everything else

Runtime and build dependencies are ordinary npm packages, installed rather than vendored;
their licenses live in `node_modules` after `npm install`. Nothing else is copied into this
repository.
