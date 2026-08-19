# Third-party licenses

Aetheris v0.0 (Beta) is MIT-licensed original work.
Runtime code shipped in `dist/` is Aetheris (MIT) plus **three.js** (MIT).
No models, textures, fonts, or audio are bundled.

## three.js — MIT

Copyright © 2010-2026 three.js authors

https://github.com/mrdoob/three.js/blob/dev/LICENSE

The MIT license text is included in `node_modules/three/LICENSE`.
A copy of that permission notice must accompany distributions of the
production bundle, which embeds three.js.

## Build-time only (not shipped in `dist/`)

| Package | License | Role |
|---|---|---|
| vite | MIT | Bundler |
| esbuild | MIT | Vite transform |
| rollup | MIT | Vite production bundle |
| typescript | Apache-2.0 | Typecheck (`tsc --noEmit`) |
| @types/three | MIT | Type declarations only |

Apache-2.0 TypeScript is a development tool. It is not linked into the
browser bundle. No Apache NOTICE obligation applies to `dist/`.

`@types/three` may list optional related type packages (e.g. physics
helpers). Those packages are **not imported** by Aetheris source and
**do not appear** in the production bundle.
