# 编码相关模块与 Bug 记录

## 编码基础设施

### `packages/core/src/util/encoding.ts`
- `detectEncoding(bytes)`: 尝试 UTF-8 解码，失败则判定 GBK。UTF-8 合法时再做 GBK 回环 + CJK 计数对比：GBK 文件按 UTF-8 解码不会得到 CJK（CJK 在 UTF-8 中是 3 字节，GBK 是 2 字节对），故 `utf8Cjk === 0 && gbkCjk > 0` 判 GBK，可捕捉"GBK 字节恰好构成合法 UTF-8"的误判。`EF BB BF` 前缀一律视为 UTF-8 BOM。
- `decodeText(bytes, encoding)`: 按编码解码为 string；UTF-8 分支 `ignoreBOM: true`，保留 BOM 字符供调用方拆分
- `encodeText(text, encoding)`: GBK 用 iconv-lite 编码为 Uint8Array，UTF-8 用 TextEncoder
- `gbkTextDecoder()`: 封装 `new TextDecoder("gbk")`（Bun 全局 `Encoding` 类型未收录 gbk 标签，需窄化）
- 类型: `FileEncoding = "utf-8" | "gbk"`

### `packages/opencode/src/util/bom.ts`
- `readFile(fs, filePath)`: 编码感知读文件，返回 `{ text, bom, encoding }`
- `writeFileEncoded(text, encoding)`: GBK 返回 Uint8Array 并剥离 `\uFEFF`（GBK 无 BOM，iconv 会把不可编码的 U+FEFF 替换成 `?`），UTF-8 返回 string
- `syncFile(fs, filePath, bom)`: 格式化后同步 BOM，已正确处理编码
- `split(text)` / `join(text, bom)` : BOM 拆分/合并

### `packages/core/src/file-mutation.ts`
- `writeIfUnchanged({ target, expected, content })`: content 接受 `string | Uint8Array`
- `writeTextPreservingBom({ target, content })`: 已正确处理编码，含 BOM 保留

---

## 已修复的编码 Bug

### Bug #1: `packages/opencode/src/tool/edit.ts:155`
**状态**: 已修复
**问题**: 写入时 `Bom.join(contentNew, desiredBom)` 返回纯 string，始终按 UTF-8 写入，丢弃源文件编码
**修复**: 改用 `Bom.writeFileEncoded(Bom.join(...), source.encoding)`

### Bug #2: `packages/opencode/src/patch/index.ts:541-551`
**状态**: 已修复
**问题**: `applyHunksToFiles` 的 update 分支：`fs.readFileString()` 无编码检测 + `Bom.join()` 无编码保留
**修复**: 用 `Bom.readFile(fs, path)` 替代 `fs.readFileString()`，用 `Bom.writeFileEncoded(Bom.join(...), source.encoding)` 替代 `Bom.join()`

### Bug #3: `packages/core/src/tool/apply-patch.ts:124-135`
**状态**: 已修复
**问题**: 硬编码 `new TextDecoder("utf-8").decode(source)`，GBK 文件解码乱码 + 写回 UTF-8
**修复**: 导入 `detectEncoding/decodeText/encodeText`，检测编码 → 正确解码 → GBK 时 `encodeText()` 写回

### Bug #4: `decodeText` UTF-8 分支静默剥离 BOM
**状态**: 已修复
**问题**: `new TextDecoder("utf-8", { fatal: true })` 默认 `ignoreBOM: false` 会吞掉 `EF BB BF`，`Bom.readFile` 对 UTF-8 BOM 文件恒返回 `bom: false`，edit/write/apply_patch 每次写入丢失 BOM
**修复**: `decodeText` UTF-8 分支加 `ignoreBOM: true`，恢复 BOM 感知

### Bug #5: formatter 把 GBK 文件转成 UTF-8 乱码
**状态**: 已修复
**问题**: edit/write/apply_patch 写完 GBK 文件后 `format.file()` 运行 prettier/biome 等，它们按 UTF-8 读入得到乱码并以 UTF-8 写回，随后 `syncFile` 静默接受
**修复**: `source.encoding === "gbk"` 时跳过 formatter（GBK 下格式化必然乱码）

### Bug #6: GBK 字节恰好构成合法 UTF-8 被误判（约 8% 的 GBK 汉字）
**状态**: 已修复
**问题**: 旧 `detectEncoding` 只测 UTF-8 严格合法性，含 1 个汉字时约 8% 概率误判成 UTF-8，写回后整文件转码损坏
**修复**: `detectEncoding` 增加 GBK 回环 + CJK 计数判别（`utf8Cjk === 0 && gbkCjk > 0` 判 GBK）

### Bug #7: legacy read 工具只采样 4096 字节检测编码
**状态**: 已修复
**问题**: 文件前 4KB 是 ASCII、中文靠后时显示乱码，模型把乱码写回
**修复**: `read.ts` 采样扩大到 `Math.min(MAX_BYTES, fileSize)`（50KB）

### Bug #8: V2 core `read-filesystem.ts` 仍只支持 UTF-8
**状态**: 已修复
**问题**: `new TextDecoder("utf-8", { fatal: true })` 使 GBK 文件直接报 "File is not valid UTF-8"
**修复**: 接入 `detectEncoding/decodeText`，非分页路径整体解码、分页路径按首个 64KB 选择解码器

### Bug #9: GBK 写入时若 desiredBom=true，`\uFEFF` 被 iconv 编码成 `?`
**状态**: 已修复
**问题**: `iconv.encode('\uFEFF...', 'gbk')` 把不可编码的 U+FEFF 替换为 `?`（已验证 3F...）
**修复**: `writeFileEncoded` 与 `writeTextPreservingBom` 在 gbk 分支剥离 `\uFEFF`

---

## 已验证正确的模块

| 文件 | 说明 |
|------|------|
| `packages/opencode/src/tool/write.ts:64` | 使用 `Bom.writeFileEncoded` ✅ |
| `packages/opencode/src/tool/edit.ts:111` | 新建文件路径，无源编码可保留，UTF-8 默认 ✅ |
| `packages/core/src/tool/edit.ts:187-194` | 编码感知读写 ✅ |
| `packages/core/src/tool/write.ts:85` | 通过 `writeTextPreservingBom` 已处理编码 ✅ |
| `packages/core/src/file-mutation.ts:108-125` | `writeTextPreservingBom` 内部正确处理 GBK + BOM ✅ |

---

## 正确写入模式

```ts
// 读取（保留编码信息）
const source = yield* Bom.readFile(fs, filePath)

// 写入（保留原编码）
yield* fs.writeWithDirs(filePath,
  Bom.writeFileEncoded(Bom.join(newText, source.bom), source.encoding)
)
```

修改记录: 2026-06-15: 修复 3 处编码 bug + 记录完整编码相关分析
