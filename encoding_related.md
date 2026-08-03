# 编码相关模块与 Bug 记录

## 编码基础设施

### `packages/core/src/util/encoding.ts`
- `detectEncoding(bytes)`: 尝试 UTF-8 解码，失败则判定 GBK
- `decodeText(bytes, encoding)`: 按编码解码为 string
- `encodeText(text, encoding)`: GBK 用 iconv-lite 编码为 Uint8Array，UTF-8 用 TextEncoder
- 类型: `FileEncoding = "utf-8" | "gbk"`

### `packages/opencode/src/util/bom.ts`
- `readFile(fs, filePath)`: 编码感知读文件，返回 `{ text, bom, encoding }`
- `writeFileEncoded(text, encoding)`: GBK 返回 Uint8Array，UTF-8 返回 string
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
