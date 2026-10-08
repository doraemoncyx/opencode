# GBK/GB18030 for the `read`, `edit`, `write`, and `patch` tools (v2)

Research note. Read-only investigation; no source files were changed. Companion to
[`shell-pwsh-utf8-encoding.md`](./shell-pwsh-utf8-encoding.md), which covers the
shell-output half of the same `@opencode/util/encoding` module.

> **Implementation status.** The recommendation below (a conservative
> `detectFileEncoding`, an `encoding` dimension threaded through `FileMutation`,
> GBK decode in `read-filesystem.ts`, and lossy-encode rejection) has since been
> implemented in `packages/util/src/encoding.ts`,
> `packages/core/src/file-mutation.ts`, `packages/core/src/tool/read-filesystem.ts`,
> and the `edit` / `write` / `patch` tool plugins.
>
> The encoding axis was narrowed to **`utf-8 | gb18030`** rather than
> `utf-8 | gbk`: GB18030 is a strict superset of GBK, so the same decoder reads
> GBK bytes and the four-byte scalars in §3 (emoji, `U+20000`) now encode
> losslessly instead of collapsing to `?` — the "GB18030 four-byte gap" in §9 is
> closed. `isEncodable` still guards the handful of scalars iconv's GB18030
> encoder cannot round-trip (e.g. `U+E5E5`).


**Question.** opencode's model-facing `read`, `edit`, `write`, and `patch` tools
currently assume UTF-8. `@opencode/util/encoding` already exports a
`detectEncoding` / `decodeText` / `encodeText` pair used only by the `shell`
tool. What exactly does that module cover, what are the exact gaps for file
content, what is the minimal design to wire it in, and what are the tradeoffs?

## Short answer

**The detector is narrower and more dangerous than "GBK support" suggests, and
its one existing consumer (per-line shell output) tolerates mistakes that a
file-write path cannot.** `detectEncoding` is a binary UTF-8-vs-GBK classifier.
On *read* it will misclassify some valid-UTF-8 files as `gbk` (probes: an
emoji-only file, `hi 😀`, and the pure-hiragana string `ひらがなだけ` all return
`gbk`; a Han-bearing emoji string like `嗨😀` and the Korean string `한국어 테스트`
do **not**, because a CJK short-circuit or a failed GBK round-trip saves them);
on *write* that false positive destroys the file (the content is re-encoded
through `iconv-lite`'s lossy GBK encoder, where every non-GBK scalar becomes
`?`). Separately, the module decodes through `TextDecoder("gbk")`, which per the
WHATWG Encoding Standard is the **GB18030 decoder**, but encodes through
`iconv-lite`'s two-byte **GBK** encoder — so a GB18030 four-byte character can be
read correctly and silently turned into `?` on the next write. And
`read-filesystem.ts` pages by byte offsets and decodes whole chunks with
`new TextDecoder()` (UTF-8 only), so even the encode/decode APIs cannot be
dropped in without addressing chunk boundaries.

**Recommended minimal change:** add a *conservative* `detectFileEncoding(bytes)`
to `packages/util/src/encoding.ts` that returns `gbk` only when a **fatal** UTF-8
decode fails (keeping the existing aggressive `detectEncoding` for shell output);
thread an optional `FileEncoding` through the `FileMutation` seam
(`readText` → `{ text, bom, encoding }`, `write`/`writeTextPreservingBom`/
`syncTextBom` → accept it); decode `read-filesystem.ts` with the detected
encoding on complete-character boundaries; and make every re-encode fail loudly
rather than emit `?`. See §8–§11.

---

## 1. Current behavior map

### The shared seam: `FileMutation`

`packages/core/src/file-mutation.ts` is the read/write choke point for
`edit`/`write`/`patch`:

- `readText(files, target)` returns `Bom.decodeBytes(bytes)` — i.e. a UTF-8
  decode plus BOM stripping (`file-mutation.ts:45-47`).
- `write({ target, content })` encodes strings with `new TextEncoder()`
  (`file-mutation.ts:87-101`, encoder at `:96`).
- `writeTextPreservingBom({ target, content })` also uses `new TextEncoder()`
  (`file-mutation.ts:103-118`, encoder at `:113`).
- `syncTextBom(files, target, bom)` re-reads the file with `Bom.syncBytes` and,
  if it differs, rewrites it with `new TextEncoder()` (`file-mutation.ts:49-57`).

`Bom` itself is UTF-8 only: `decode()` is
`new TextDecoder("utf-8", { ignoreBOM: true })` (`packages/util/src/bom.ts:44-45`);
`syncBytes` re-encodes with `new TextEncoder()` (`bom.ts:27-32`); `has` tests the
three UTF-8 BOM bytes (`bom.ts:19-21`). There is no encoding dimension anywhere.

### `read`

`packages/core/src/tool/read-filesystem.ts` reads the first `FIRST_CHUNK`
(256 KiB, `:17`) bytes, then:

- Non-media, non-paged files (`size <= MAX_READ_BYTES` = 50 KiB and no explicit
  page, `:15`, `:151`) are decoded with
  `new TextDecoder().decode(first.bytes)` and returned as `encoding: "utf8"`
  (`read-filesystem.ts:154-161`, decode at `:158`).
- Larger or explicitly paged files go through `textPage`, which decodes with
  `new TextDecoder().decode(bytes)` again (`read-filesystem.ts:294`) and pages
  by *line* counts while tracking byte offsets (`nthNewline`, `consumed`,
  `MAX_READ_BYTES`, `MAX_LINE_LENGTH`; `:291-324`, `:382-389`).
- The multi-chunk loop reads further 256 KiB leaves and concatenates them
  (`read-filesystem.ts:176-223`).
- Binary content is rejected by `first.bytes.includes(0)` (`:153`, and the
  paged equivalent at `:171`, `:205-209`). Media is base64-encoded instead
  (`:136-148`), so the detector is irrelevant for images/PDFs.

`FileContent` is `FileSystem.Content` (`read-filesystem.ts:75-79`), whose
`encoding` is `Schema.Literals(["utf8", "base64"])`
(`packages/core/src/filesystem.ts:53-60`, literal at `:57`). `read.ts` wraps this
and renders `<line>: <content>` (`packages/core/src/tool/plugin/read.ts:175-211`);
its only branch on encoding is the non-media-base64 → `BinaryFileError` guard
(`read.ts:108-113`).

### `edit`

`packages/core/src/tool/plugin/edit.ts` reads with `FileMutation.readText`
(`edit.ts:149`), normalizes CRLF/LF (`:160-162`), finds `oldString`, and writes
with `fileMutation.write({ target, content: Bom.join(replaced, bom) })`
(`edit.ts:200-203`). It then runs the formatter and either
`FileMutation.syncTextBom` or a fresh `FileMutation.readText` (`edit.ts:205-207`).

### `write`

`packages/core/src/tool/plugin/write.ts` reads the current file for the diff and
the BOM (`write.ts:73-77`), then writes through
`fileMutation.writeTextPreservingBom` (`write.ts:87`), re-reads to obtain the
BOM, and optionally formats + `syncTextBom` (`write.ts:88-91`).

### `patch`

`packages/core/src/tool/plugin/patch.ts` reads via `FileMutation.readText` for
delete/update (`patch.ts:142`, `:153-166`), builds content with
`Patch.joinBom`/`Bom.split` (`:176`, `packages/util/src/patch.ts:139-141`,
`:128-137`), and writes with `new TextEncoder().encode(change.content)`
directly at `patch.ts:228` (move) and `:245` (update/add). It then re-reads and
`syncTextBom`s (`patch.ts:260-270`).

### Confirm the module is otherwise unused

`@opencode/util/encoding` is imported by exactly two files: `shell.ts:11` (used
at `shell.ts:244`) and its test `tool-shell.test.ts:38`. No
`read`/`edit`/`write`/`patch` file imports it. `detectEncoding`/`decodeText`/
`encodeText` appear only in `encoding.ts` and `encoding.test.ts`. `FileMutation`
has no encoding argument. The companion note's claim that
`config/plugin/command.ts:230` hardcodes `.toString("utf8")` is confirmed.

---

## 2. What `detectEncoding` actually guarantees

`encoding.ts:5-32`:

1. If a fatal UTF-8 decode throws, return `gbk` immediately (`:7-12`).
2. If the bytes start with `EF BB BF`, return `utf-8` (`:13-14`).
3. If empty or all-ASCII, return `utf-8` (`:15`).
4. Otherwise, round-trip the bytes through the GB18030 decoder + `iconv-lite`
   GBK encoder (`:22-23`); if that is not byte-identical, return `utf-8`.
5. Then compare CJK counts and text coherence: `utf-8` if the UTF-8 text has
   CJK, if the GBK text has no CJK, or if the UTF-8 text is "coherent"
   (whitespace, ASCII, and code points in a fixed set of Latin/Greek/Cyrillic/
   punctuation ranges, `isCoherentText` at `:34-47`); else `gbk` (`:25-31`).

So it is **not a chardet-style guesser**. `FileEncoding` has two members
(`encoding.ts:3`), and there are only two possible answers. Its target is the
shell use case where each output *line* is classified independently
(`decodeShellOutput`, `encoding.ts:62-94`), not a whole source file.

Verified behavior (local probe `C:\cache\tmp\gbk_probe.ts`, run under Bun 1.4.2
against the real module; Node 26 agrees on the `TextDecoder` facts in
`gbk_probe3.cjs`):

| Input | Bytes (hex) | `detectEncoding` | Decoded as |
| --- | --- | --- | --- |
| UTF-8 CJK `这是中文注释` | `e8bf99…` | `utf-8` | correct |
| GBK CJK `这是中文注释` | `d5e2cac7…` | `gbk` | correct |
| pure ASCII / empty | — | `utf-8` | correct |
| UTF-8 BOM `EF BB BF` | `efbbbf` | `utf-8` | correct |
| Latin-1 `é` (0xE9) / CP1252 `café` | `e9`, `636166e9` | `gbk` | **mojibake** (`caf�`) |
| CP1252 smart quotes `“ ” ’` | `939492` | `gbk` | **mojibake** |
| Big5 `中文測試` | `a4a4a4e5…` | `gbk` | **mojibake** (decoded as Japanese-looking GBK) |
| Shift_JIS `日本語テスト` | `93fa967b…` | `gbk` | **mojibake** |
| UTF-8 emoji only `😀` | `f09f9880` | **`gbk`** | **mojibake** (`U+9983 U+69BE`) |
| UTF-8 `hi 😀` | `686920f09f9880` | **`gbk`** | **mojibake** |
| UTF-8 `ひらがなだけ` (kana only) | — | **`gbk`** | **mojibake** |
| UTF-8 `嗨😀` (emoji + Han) | — | `utf-8` | correct (Han short-circuits) |
| UTF-8 `한국어 테스트` (Korean) | — | `utf-8` | correct (GBK round-trip fails) |
| UTF-8 `中文😀` | — | `utf-8` | correct (CJK short-circuits) |
| GB18030 4-byte `U+20000` | `95328236` | `gbk` | decoded to `U+20000` by `TextDecoder("gbk")` |
| UTF-8 line + GBK line in one buffer | — | `gbk` | whole buffer mojibake for the UTF-8 line |

Key consequences:

- **False positives are real and easy to hit.** Any valid-UTF-8 file with no CJK
  ideograph that (a) round-trips through the GB18030 decoder and (b) decodes to
  text outside `isCoherentText` will be classified `gbk`. Emoji and *some*
  kana-only strings qualify; a Han/kana mix and strings whose GBK round-trip
  fails (the Korean probes) do not. `isCoherentText` excludes all of
  `U+1F300+` (emoji) and Hangul (`U+AC00+`), and `countCjk` counts Han and CJK
  punctuation but not kana/Hangul (`encoding.ts:132-147`).
- **Latin-1/CP1252 is not detected**, it is aliased to GBK — same class the
  companion note flags for shell output.
- **Mixed encodings collapse** to one verdict for the whole buffer. The shell
  path avoids this by classifying per line; a file read does not.
- **`0x00` is not special to the detector.** It is valid UTF-8; the binary
  rejection is a separate `includes(0)` check in `read-filesystem.ts`.
- `encoding.test.ts` locks in the aggressive behavior (the `0xC2 0x80` → `gbk`
  lookalike test at `:30-35`, and "non-CJK UTF-8 stays utf-8" at `:42-47`). Any
  new file detector should not change `detectEncoding`; it should be additive.

**Is it safe on arbitrary source files?** No, not for a write path. It is
tolerable for *reading* (worst case is mojibake) but not for *writing* (worst
case is data loss). A read-only wiring that uses it directly would also break the
existing contract tested at `tool-read-filesystem.test.ts:144-158`, which
asserts malformed UTF-8 `68 69 80` reads as `"hi\uFFFD"` with `encoding: "utf8"`
— `detectEncoding` returns `gbk` for those bytes and `TextDecoder("gbk")` yields
`"hi€"`.

---

## 3. `gbk` in `TextDecoder` is the GB18030 decoder; the encoder is not

The premise "the `gbk` label maps to the GB18030 decoder" is **correct for
decoding and false for encoding**, and the asymmetry matters:

- WHATWG Encoding Standard §10.1.1: **"GBK's decoder is gb18030's decoder."**
  <https://encoding.spec.whatwg.org/#gbk-decoder>
- §10.1.2: **"GBK's encoder is gb18030's encoder with its `is GBK` set to
  true."** <https://encoding.spec.whatwg.org/#gbk-encoder> The spec calls this
  "a conservative move to decrease the chances of breaking legacy servers".
- The label table maps `gbk`, `gb2312`, `chinese`, `csgb2312`, `x-gbk`, … to the
  **GBK** encoding, and `gb18030` to the separate **gb18030** encoding
  (<https://encoding.spec.whatwg.org/#names-and-labels>, section 4.2).

Local confirmation (Bun 1.4.2 and Node 26.7.0): `new TextDecoder("gbk")` decodes
the four-byte GB18030 sequence `95 32 82 36` to `U+20000`, and
`88 30 d3 30` to `U+0452` — i.e. the GB18030 decoder, matching the spec. But
`iconv-lite`'s `iconv.decode(..., "gbk")` (and its encoder) is two-byte only:
`iconv.decode(95328236, "gbk")` → `U+FFFD U+0032 U+FFFD U+0036`.

In the repo this produces a **decode/encode width mismatch**:

- `decodeText(bytes, "gbk")` uses `gbkTextDecoder()` =
  `new TextDecoder("gbk")` (`encoding.ts:49-52`, `:55`) — full GB18030 decode.
- `encodeText(text, "gbk")` uses `iconv.encode(text, "gbk")`
  (`encoding.ts:57-60`, `:59`) — two-byte GBK encode, replacing anything else.

So a file with a GB18030-only character can be read correctly and then silently
mangled to `?` on the next edit/write. Probe: `iconv.encode("😀", "gbk")` →
`3f` (`?`); `iconv.encode("\u{20000}", "gbk")` → `3f`.

**BOM claim in `encoding.ts:13` is inaccurate.** The comment says the GB18030
decoder can also decode `EF BB BF` into two Han characters "and round-trip".
Probe (Bun and Node, and `iconv.decode(..., "gb18030")`): `EF BB BF` → `U+9518`
plus `U+FFFD`, and re-encoding is not byte-identical. The explicit BOM check at
`:14` is what makes it correct; the parenthetical justification is wrong but
harmless because that check runs first. This is worth fixing if the module is
promoted to a file API.

---

## 4. `iconv-lite` is an encode/decode library, not a detector

`packages/util/package.json:58` pins `iconv-lite` `0.7.3` (catalog entry
`bun.lock:1024`, resolved `bun.lock:4312`). Its README documents only
`decode`/`encode`/`encodingExists` plus streaming variants — there is no
detection API (<https://github.com/ashtuchkin/iconv-lite#usage>). The README
also states untranslatable characters are set to `�` or `?`, which is exactly
the lossy-encode risk above. So the repo already owns the encoder it needs; the
missing piece is the file-level detection/decision policy, not a new codec.

---

## 5. Ecosystem prior art and the declarative alternative

- **VS Code** auto-detection is opt-in: the setting `files.autoGuessEncoding`
  (docs "File encoding support", <https://code.visualstudio.com/docs/editor/codebasics#_file-encoding-support>),
  and the implementation parameter is `autoGuessEncoding`/`guessEncoding`
  (`src/vs/workbench/services/textfile/common/encoding.ts`,
  <https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/textfile/common/encoding.ts>).
  VS Code guesses with **`jschardet`** (<https://github.com/aadsm/jschardet>)
  and decodes/encodes with **`@vscode/iconv-lite-umd`** — two libraries, not
  one. It also:
  - buffers `AUTO_ENCODING_GUESS_MIN_BYTES = 512*8` (4 KiB) before guessing and
    caps the guess at `AUTO_ENCODING_GUESS_MAX_BYTES = 512*128` (64 KiB);
  - detects binary/UTF-16 by scanning for `0x00` bytes;
  - refuses to guess `ascii`, `utf-16`, and `utf-32`;
  - supports `candidateGuessEncodings` and, in the candidate path, requires the
    candidate encoding to round-trip losslessly
    (`iconv.encode(iconv.decode(buffer, enc), enc).equals(buffer)`).
  Notably it ships a **separate list of supported encodings** with explicit
  `GBK` and `GB18030` entries, i.e. it does not conflate them.
  This is the closest working model: separate detector and codec, an explicit
  encoding setting, and a round-trip check before trusting a guessed encoding.
- **Git** avoids guessing entirely in favour of a declaration:
  `working-tree-encoding` in `.gitattributes`
  (<https://git-scm.com/docs/gitattributes#_working_tree_encoding>). Git
  re-encodes to UTF-8 in the index and back on checkout, and explicitly warns
  that "reencoding content to non-UTF encodings … might not be UTF-8 round trip
  safe" and points at `core.checkRoundtripEncoding`. That is the same
  lossy-transcode hazard, elevated to a documented config knob.
- **EditorConfig** (`charset`) is declarative too, but its allowed values are
  only `latin1`, `utf-8`, `utf-8-bom`, `utf-16be`, `utf-16le`
  (<https://spec.editorconfig.org/>). There is no `gbk` value, so it is not a
  usable source of a GBK preference on its own.
- **`bun.lock`** contains `iconv-lite` only. Grep for `chardet`, `jschardet`,
  `encoding-japanese`, and `whatwg-encoding` finds no matches. Adding a real
  detector would be a new dependency.

---

## 6. BOM vs GBK

`bom.ts` models only a UTF-8 BOM (`EF BB BF`, `bom.ts:19-21`) and re-encodes
with `new TextEncoder()` (`bom.ts:27-32`). GBK has no BOM concept, so:

- A GBK file must round-trip with `bom === false`; the existing `Bom` helpers
  should not be applied to GBK bytes (their `syncBytes` would decode/re-encode
  through UTF-8 and corrupt).
- `decodeText(bytes, "utf-8")` deliberately keeps the BOM character
  (`ignoreBOM: true`, `encoding.ts:50`; test at `encoding.test.ts:51-54`),
  whereas `Bom.decodeBytes` strips it (`bom.ts:9-25`). Any `readText` that adds
  an encoding dimension must preserve this split: keep `Bom.decodeBytes` for
  UTF-8, and for GBK return `bom: false` with `decodeText(bytes, "gbk")`.
- If `readText` returns `{ text, bom, encoding }`, callers that currently join
  with `Bom.join(replaced, bom)` (`edit.ts:202`) stay correct for UTF-8 and are
  inert for GBK (`bom` is false).

---

## 7. Byte-offset paging and the multi-chunk read path

`read-filesystem.ts` pages by line but tracks byte positions; this is mostly safe
for GBK by construction, with two integration hazards:

- **Newlines are safe.** `0x0a` is a single byte in both encodings and, per the
  WHATWG GBK/GB18030 trail-byte ranges, cannot appear inside a multi-byte
  character; `nthNewline`/`textLeaf` newline counting on raw bytes stays correct
  (`read-filesystem.ts:340-343`, `:382-389`). `textOffset` seeks to a line start,
  so the concatenated `selected` slice starts on a character boundary
  (`:363-380`, `:186-196`).
- **Detection must ignore an incomplete trailing character.** `FIRST_CHUNK` is
  256 KiB (`:17`). For a file larger than `FIRST_CHUNK`, `first.bytes` can end
  mid-character. Running a fatal UTF-8 check on that buffer fails and would flip
  a large Chinese UTF-8 file to `gbk`. Detection must run on a buffer trimmed to
  a complete UTF-8 character (`completeBytes(_, "utf-8")`, `encoding.ts:110-118`,
  currently private) or on the whole file once its size is known.
- **`textPage` must not use a fatal UTF-8 decoder on a non-EOF chunk.**
  `textPage` decodes the whole chunk *including* the partial final line, which it
  then drops when `!eof` (`read-filesystem.ts:291-324`). `decodeText(bytes,
  "utf-8")` is fatal (`encoding.ts:50`) and would throw on that partial tail.
  Either keep a lenient decoder for the paging path, or trim with `completeBytes`
  first (which also makes the GBK branch safe when a chunk ends on a GBK lead
  byte).
- **`MAX_READ_BYTES` accounting is fine.** It bounds the *decoded* size using
  `Buffer.byteLength(text, "utf-8")` (`:309`), which is encoding-independent.
- The paged path re-reads the file in 256 KiB leaves and concatenates them
  (`:176-223`); the detected encoding should be computed once per file, not per
  leaf, so a leaf boundary cannot produce a contradictory verdict.

---

## 8. Minimal design to wire `@opencode/util/encoding` through the file seam

**Step 1 — add a conservative file detector (keep the aggressive one).**

```ts
// packages/util/src/encoding.ts
// Files are much more likely to be valid UTF-8 than arbitrary shell output is.
// Only a hard UTF-8 failure means "not UTF-8"; do not use the lookalike
// heuristic here, because a write in this encoding is destructive.
export function detectFileEncoding(bytes: Uint8Array): FileEncoding {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return "utf-8"
  } catch {
    return "gbk"
  }
}
```

This alone avoids the emoji/Korean/Japanese false positives while still catching
real GBK files (whose CJK bytes are invalid UTF-8). It will not catch a GBK file
whose entire body happens to be valid UTF-8 (the `0xC2 0x80` lookalike class);
that is an acceptable trade for not corrupting valid UTF-8, and it is the same
"favor UTF-8" choice VS Code makes when it ignores `ascii` guesses. If the
lookalike case matters, mirror VS Code's candidate path and require a *lossless
GBK round-trip* — but note that a 4-byte GB18030 lookalike such as an emoji also
round-trips (probe: `f09f9880` → `馃榾` → `f09f9880`), so a round-trip guard
alone is insufficient; the fatal-UTF-8 gate is the load-bearing part.

**Step 2 — thread `encoding` through `FileMutation`.**

- `readText` → `{ text, bom, encoding }`:
  `const encoding = detectFileEncoding(bytes)`; for `utf-8` keep
  `Bom.decodeBytes` (BOM stripping), for `gbk` return `{ text: decodeText(bytes,
  "gbk"), bom: false, encoding }`.
- `WriteInput` / `TextWriteInput` gain `readonly encoding?: FileEncoding`;
  `write` and `writeTextPreservingBom` encode strings with
  `encodeText(content, input.encoding ?? "utf-8")` instead of `new TextEncoder()`
  (`file-mutation.ts:96`, `:113`). `writeTextPreservingBom` keeps its BOM logic
  for UTF-8 and skips it for GBK.
- `syncTextBom` should *re-detect* from the bytes it reads rather than trust a
  caller-supplied encoding, because the formatter may have changed the file, using
  `detectFileEncoding` + `decodeText`/`encodeText` and applying BOM handling only
  for UTF-8 (`file-mutation.ts:49-57`).

**Step 3 — fix `read-filesystem.ts`.**

- Detect once after the first read, on a UTF-8-complete prefix when the chunk is
  truncated (export or reuse `completeBytes`); pass that `FileEncoding` into
  `textPage`.
- Replace `new TextDecoder().decode(...)` at `:158` and `:294` with
  `decodeText(_, encoding)` after trimming to `completeBytes`.
- Widen `FileSystem.Content.encoding` to `["utf8", "gbk", "base64"]`
  (`filesystem.ts:57`) and return the detected value instead of the hardcoded
  `"utf8"` (`read-filesystem.ts:159`). This is informational for the model; the
  existing `base64` guard in `read.ts:108-113` is unaffected.

**Step 4 — tool call sites.**

| Site | Change |
| --- | --- |
| `edit.ts:149` | consume `original.encoding`; pass it to `write` (`:200`) and to the post-write read/sync (`:205-207`) |
| `write.ts:73-91` | new file → `"utf-8"`; existing file → preserve `current.encoding` through `writeTextPreservingBom` and the formatter sync |
| `patch.ts:142`, `:157` | carry the source file's encoding into the writes at `:228`/`:245`; `add` hunks default to `"utf-8"` |
| `patch.ts:260-270`, `edit.ts:205-207` | rely on `syncTextBom` re-detecting rather than a passed encoding |

**Step 5 — one policy for lossy encodes.** Before writing, check
`decodeText(encodeText(content, encoding), encoding) === content`. If not, the
content contains a scalar the target encoding cannot represent. Do **not**
silently emit `?`. Fail with a `ToolFailure` that names the encoding and the
problem (the model can then rewrite the file as UTF-8 through `write`, or avoid
the character). This mirrors Git's round-trip warning and VS Code's round-trip
gate.

---

## 9. Risks, policy decisions, and alternatives

- **False-positive write corruption (highest risk).** `detectEncoding` on a
  valid-UTF-8 emoji/Korean file returns `gbk`; if a write preserved that verdict
  the file would be re-encoded through the lossy GBK encoder. The conservative
  `detectFileEncoding` in §8 removes this; if the aggressive detector is used
  instead, a write in `gbk` must be gated on a lossless round-trip *and* the
  fatal-UTF-8 signal.
- **Lossy transcode on edit.** Editing a GBK file to add a character outside GBK
  (e.g. an emoji) cannot be represented. Options: error (recommended), write it
  as `?` (silent data loss), or switch the whole file to UTF-8 (silent encoding
  change). The current code path silently produces `?` because `iconv-lite`
  replaces unrepresentable characters.
- **GB18030 four-byte characters.** They decode but do not encode through
  `iconv-lite`'s `gbk`. A read-perfect file can lose them on write. Either treat
  the encode dimension as `gb18030` (a third `FileEncoding`, or use
  `iconv.encode(text, "gb18030")`) or accept the `?` and fail loudly.
- **Detect-only-on-unambiguous-bytes alternative.** A stricter writable
  detector (GK only when UTF-8 fails *and* the GBK decode round-trips *and*
  `isCoherentText`-style checks pass) reduces false positives further but still
  misses Latin-1 and can reject legitimate GBK. This is the same tradeoff
  VS Code exposes via `files.autoGuessEncoding` off by default.
- **Explicit-encoding alternative.** VS Code, Git, and EditorConfig all prefer a
  declared encoding over guessing. A per-project setting (or an optional
  `encoding` input on `read`/`write`) avoids the detector entirely and is more
  deterministic, but it adds model-facing schema and config surface. A middle
  ground is to auto-detect for *reads* and require the round-trip gate for
  writes, with no new schema.
- **Formatter interaction.** `Formatter.Service` runs an external command that
  rewrites the file in its own encoding (`packages/core/src/formatter.ts:56-94`),
  after which `FileMutation.syncTextBom` re-reads with UTF-8-only code
  (`file-mutation.ts:49-57`). A formatter that preserves GBK would be corrupted
  by that UTF-8 re-read; making `syncTextBom` re-detect (§8) fixes this, but a
  formatter that actively converts to UTF-8 is indistinguishable from an
  intentional conversion and is out of scope.
- **Runtime label support.** `TextDecoder("gbk")` depends on the runtime's ICU
  labels. Bun 1.4.2 and Node 26.7.0 support it (probe). Cloudflare `workerd`
  (a core target, see `packages/core/package.json:34-37`) is unverified. On a
  runtime without the label, `gbkTextDecoder()` throws a `RangeError`; the code
  would need a fallback to `iconv-lite` for decoding too.
- **Scope.** `config/plugin/command.ts:230`'s hardcoded `.toString("utf8")` for
  `!` shell interpolation is the same class of bug and is fixed by the shell
  preamble in the companion note, not by this file seam.

---

## 10. Tests to add

Mirror the existing fixtures. `packages/util/src/encoding.test.ts` already builds
GBK bytes with `Buffer.from(iconv.encode(text, "gbk"))` (`:5`) — keep that for
`util`. Core tests must **not** add `iconv-lite` (it is not a core dependency,
`packages/core/package.json:97-137`); use raw byte literals the way
`tool-read-filesystem.test.ts:149-150` and `tool-shell.test.ts:206-219` do
(`中文` in GBK = `d6 d0 ce c4`).

- `packages/util/src/encoding.test.ts`
  - `detectFileEncoding`: emoji-only (`f0 9f 98 80`), `hi 😀`, and
    `한국어 테스트` stay `utf-8`; GBK `这是中文注释` → `gbk`; Latin-1 0xE9 → `gbk`;
    empty/ASCII/BOM → `utf-8`.
  - `decodeText` for a GB18030 four-byte character decodes to the right scalar;
    `encodeText(_, "gbk")` loses it (guard the asymmetry).
- `packages/core/test/file-mutation.test.ts` (`:34-51`, `:73-90`): `readText`
  returns `encoding: "gbk"` for GBK bytes; `write({ encoding: "gbk" })` emits GBK
  bytes; `writeTextPreservingBom` with `"gbk"` does not add a BOM.
- `packages/core/test/tool-read-filesystem.test.ts` (`:144-158` is the current
  malformed-UTF-8 contract to update): a GBK file reads as `中文` with
  `encoding: "gbk"`; a GBK file larger than `MAX_READ_BYTES` pages with
  `offset`/`limit`/`next`; a chunk cut mid-GBK-character is handled (append
  enough content to force a second `FIRST_CHUNK`); an emoji-only UTF-8 file stays
  `utf-8` (regression for the false positive).
- `packages/core/test/tool-read.test.ts`: the model content for a GBK file shows
  the decoded lines.
- `packages/core/test/tool-edit.test.ts` (`:123`): editing a GBK file preserves
  GBK bytes; adding a non-GBK character fails instead of writing `?`.
- `packages/core/test/tool-write.test.ts`: overwriting an existing GBK file
  preserves `gbk`; creating a new file emits UTF-8.
- `packages/core/test/tool-patch.test.ts`: update/delete preserve encoding;
  `add` writes UTF-8; a non-representable added char fails.

---

## 11. Recommendation

1. **Do not wire the aggressive `detectEncoding` into the file tools.** Add the
   conservative `detectFileEncoding(bytes)` (fatal UTF-8 gate) in
   `packages/util/src/encoding.ts`; keep `detectEncoding` for shell output.
2. **Thread an optional `FileEncoding` through `FileMutation`** (`readText`
   returns it; `write`/`writeTextPreservingBom` accept it; `syncTextBom`
   re-detects), and encode strings with `encodeText` instead of
   `new TextEncoder()`.
3. **Decode `read-filesystem.ts` with the detected encoding on complete-character
   boundaries**, detect once per file on a UTF-8-complete prefix, and widen
   `FileSystem.Content.encoding` to include `"gbk"`.
4. **Fail loudly on lossy encodes.** Never let `iconv-lite` turn a non-GBK
   character into `?` on a write; return a `ToolFailure` instead.
5. **Preserve the source encoding on `edit`/`patch` update/delete and on
   `write`-overwrite; default new files to UTF-8.**
6. **Treat the GB18030 four-byte gap as a deliberate follow-up** (either a third
   `FileEncoding` using `iconv.encode(text, "gb18030")`, or a documented
   "decode-only GB18030" limitation).
7. **Keep the explicit-encoding knob (config or `read`/`write` input) as the
   fallback** for teams that cannot rely on detection; this matches VS Code, Git,
   and EditorConfig prior art.

---

## 12. Local verification (reproduction)

Read-only. Probes live outside the repo:

```powershell
# detectEncoding / decodeText / encodeText against the real module, plus the
# TextDecoder("gbk")-vs-iconv(gbk) width comparison.
bun C:\cache\tmp\gbk_probe.ts
bun C:\cache\tmp\gbk_probe2.ts
node C:\cache\tmp\gbk_probe3.cjs
```

Observed under Bun 1.4.2 / Node 26.7.0 (Windows 11, zh-CN): `TextDecoder("gbk")`
decodes four-byte GB18030 (`U+20000`, `U+0452`); `iconv` `gbk` does not;
`detectEncoding` returns `gbk` for `😀`, `hi 😀`, and `ひらがなだけ`, and
`utf-8` for `嗨😀`, `한국어 테스트`, `こんにちは`, and `中文😀`; `EF BB BF` decodes to
`U+9518 U+FFFD` (no round-trip); GBK `d6 d0 ce c4` decodes to `中文` with
`TextDecoder("gbk")` and to `????` with `new TextDecoder()`.

---

## Sources

**Repo (`path:line`)**

- `packages/util/src/encoding.ts:3` (`FileEncoding`), `:5-32` (`detectEncoding`),
  `:13-14` (BOM check + inaccurate comment), `:34-47` (`isCoherentText`),
  `:49-52`/`:55` (`decodeText`, `gbkTextDecoder`), `:57-60` (`encodeText`),
  `:62-94` (`decodeShellOutput`), `:98-130` (`characterSize`/`completeBytes`/
  `completeCharacters`), `:132-147` (`countCjk`).
- `packages/util/src/encoding.test.ts:5` (iconv fixtures), `:8-47` (detection
  cases incl. `0xC2 0x80` at `:30-35`), `:50-59` (`decodeText`), `:97-106`
  (round-trips).
- `packages/util/src/bom.ts:9-25` (`split`/`has`/`decodeBytes`), `:27-32`
  (`syncBytes`), `:44-45` (`decode`).
- `packages/util/src/patch.ts:128-141` (`derive`/`joinBom`).
- `packages/util/package.json:58` (`iconv-lite@0.7.3`); `bun.lock:1024`,
  `bun.lock:4312`.
- `packages/core/src/file-mutation.ts:45-47` (`readText`), `:49-57`
  (`syncTextBom`), `:87-101` (`write`, encoder `:96`), `:103-118`
  (`writeTextPreservingBom`, encoder `:113`).
- `packages/core/src/tool/read-filesystem.ts:14-21` (limits), `:122` (first
  read), `:136-148` (media), `:151-161` (single-chunk decode at `:158`),
  `:176-223` (multi-chunk), `:226-236` (`readFile`), `:291-324` (`textPage`,
  decode `:294`, size `:309`, `consumed` `:322`), `:340-343` (`textLeaf`),
  `:363-389` (`textOffset`/`nthNewline`).
- `packages/core/src/filesystem.ts:53-60` (`Content.encoding` literal at `:57`).
- `packages/core/src/tool/plugin/read.ts:27` (Output union), `:108-113` (base64
  guard), `:175-211` (`toModelContent`).
- `packages/core/src/tool/plugin/edit.ts:149` (read), `:160-162` (EOL),
  `:199-207` (write + formatter/sync).
- `packages/core/src/tool/plugin/write.ts:73-91` (read, write, sync).
- `packages/core/src/tool/plugin/patch.ts:142`, `:153-181`, `:228`, `:245`,
  `:260-270`.
- `packages/core/src/formatter.ts:56-94` (`Formatter.file`).
- `packages/core/src/shell.ts:11`, `:244`; `packages/core/src/config/plugin/command.ts:223`,
  `:230`.
- `packages/core/package.json:34-37` (workerd targets), `:97-137` (no iconv dep).
- Tests: `packages/core/test/tool-shell.test.ts:38`, `:206-219`;
  `packages/core/test/tool-read-filesystem.test.ts:144-158`, `:149-150`;
  `packages/core/test/file-mutation.test.ts:34-51`, `:73-90`;
  `packages/core/test/tool-edit.test.ts:123`; `packages/core/test/tool-write.test.ts`;
  `packages/core/test/tool-patch.test.ts`.
- Local probes: `C:\cache\tmp\gbk_probe.ts`, `gbk_probe2.ts`, `gbk_probe3.cjs`.

**Upstream prior art**

- VS Code auto-guess implementation (jschardet + `@vscode/iconv-lite-umd`,
  guess min/max bytes, binary/UTF-16 `0x00` sniffing, ignored encodings,
  candidate round-trip check):
  <https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/textfile/common/encoding.ts>
- VS Code file encoding support docs (per-file/per-workspace encoding):
  <https://code.visualstudio.com/docs/editor/codebasics#_file-encoding-support>
- jschardet (detection library): <https://github.com/aadsm/jschardet>
- Git `working-tree-encoding` and its round-trip pitfalls:
  <https://git-scm.com/docs/gitattributes#_working_tree_encoding>
- EditorConfig `charset` (no GBK value): <https://spec.editorconfig.org/>
- iconv-lite README (encode/decode/`encodingExists` only; `�`/`?` replacement):
  <https://github.com/ashtuchkin/iconv-lite#usage>

**Primary docs / source**

- WHATWG Encoding Standard §10.1.1 "GBK's decoder is gb18030's decoder":
  <https://encoding.spec.whatwg.org/#gbk-decoder>
- WHATWG Encoding Standard §10.1.2 "GBK's encoder is gb18030's encoder with its
  `is GBK` set to true": <https://encoding.spec.whatwg.org/#gbk-encoder>
- WHATWG Encoding Standard names and labels table:
  <https://encoding.spec.whatwg.org/#names-and-labels>
- WHATWG Encoding Standard security note on the gb18030 decoder at end-of-queue:
  <https://encoding.spec.whatwg.org/#security-background>

**Unverified / open**

- The exact `files.autoGuessEncoding` setting id / docs wording was not fetched
  from a stable anchor; the VS Code source parameter is `autoGuessEncoding` /
  `guessEncoding`, and the Japanese-language search snippets corroborate the
  setting name. Treat the id-to-docs mapping as inferred.
- `TextDecoder("gbk")` label support in Cloudflare `workerd` (a core target) was
  not tested; only Bun 1.4.2 and Node 26.7.0 were.
- Whether any formatter configured through `Formatter.Service` preserves GBK was
  not measured; the corruption path is reasoned from `syncTextBom`'s UTF-8-only
  decode.
- The false-positive list (emoji, certain Korean/Japanese strings) is from a
  finite probe set, not an exhaustive character-space search; `isCoherentText`'s
  boundary ranges (`encoding.ts:38-44`) predict the class, but other collisions
  are possible.
- The `detectFileEncoding` recommendation deliberately rejects valid-UTF-8
  lookalike GBK files; the size of that population was not measured.
