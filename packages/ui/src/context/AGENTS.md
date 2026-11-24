# UI context

`marked-parser.tsx` is upstream-owned. The fork adds only `\[...\]` display math: `inlineBracketMathRegex` plus one `inlineBracketKatex` extension in the `mathExtension` list.

When merging `upstream/dev`, take upstream's `createMarkdownParser`, `codeExtension`, `renderFenceMath`, and `mathExtension` verbatim. Re-add the bracket extension as one self-contained object; do not restore the old `markdownMath` renderer object.
