import { describe, expect, test } from "bun:test"
import { pathKey } from "./path-key"

describe("pathKey", () => {
  test("normalizes Windows drive letter case", () => {
    expect(String(pathKey("f:\\workgame\\fmhxy_trunk\\mhimage"))).toBe(
      String(pathKey("F:/workgame/fmhxy_trunk/mhimage")),
    )
  })

  test("normalizes separators and trailing slashes", () => {
    expect(String(pathKey("F:\\workgame\\fmhxy_trunk\\mhimage\\"))).toBe("F:/workgame/fmhxy_trunk/mhimage")
  })

  test("keeps drive-only path with trailing slash", () => {
    expect(String(pathKey("f:"))).toBe("F:/")
  })

  test("keeps non-windows paths unchanged", () => {
    expect(String(pathKey("/home/user/project"))).toBe("/home/user/project")
  })
})
