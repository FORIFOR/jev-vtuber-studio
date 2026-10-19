# Vendored browser libraries (unmodified)

| File | Source | Version | License |
|---|---|---|---|
| jquery-3.7.1.min.js | https://registry.npmjs.org/jquery/-/jquery-3.7.1.tgz (dist/jquery.min.js), integrity sha512-m4avr8yL8kmFN8psrbFFFmB/If14iN5o9nw/NgnnM+kybDJpRsAynV2BsfpTYrTRysYUdADVD7CkUUizgkpLfg== | 3.7.1 | MIT (LICENSE-jquery.txt) |
| blockrain-0.2.1.jquery.js, blockrain-0.2.1.css | https://github.com/Aerolab/blockrain.js (gh-pages branch, dist/) | 0.2.1 (package.json; file header says 0.2.0) | MIT, (c) 2015 Aerolab (LICENSE-blockrain.txt) |

Blockrain declares jQuery ~1.11.3; it is used here with jQuery 3.7.1 (it only needs $.widget (bundled in its dist), $.isArray, .bind and fadeIn/fadeOut, all present in 3.7.1).
Our changes live in public/noa-blocks.mjs (seeded RNG, human-like bot moves, fixed 10x20 field, no auto-restart, read-only snapshot, events). These files stay byte-identical to upstream.
e85fc9240b733a6e494bbf864e9654f88d7b1daa05c1a664d64d0ba8ba2facdd  public/vendor/blockrain-0.2.1.jquery.js
fc9a93dd241f6b045cbff0481cf4e1901becd0e12fb45166a8f17f95823f0b1a  public/vendor/jquery-3.7.1.min.js
59eb9ed81abe043695477430f44c9a720bece8c12190135fa1c4aebe00b2630c  public/vendor/blockrain-0.2.1.css
