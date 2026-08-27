import { describe, expect, test } from "bun:test"
import { pathKey } from "./path-key"

describe("pathKey", () => {
  test("normalizes Windows drive letter case", () => {
    expect(pathKey("f:\\workgame\\fmhxy_trunk\\mhimage")).toBe(pathKey("F:/workgame/fmhxy_trunk/mhimage"))
  })

  test("normalizes separators and trailing slashes", () => {
    expect(pathKey("F:\\workgame\\fmhxy_trunk\\mhimage\\")).toBe("F:/workgame/fmhxy_trunk/mhimage")
  })

  test("keeps drive-only path with trailing slash", () => {
    expect(pathKey("f:")).toBe("F:/")
  })

  test("keeps non-windows paths unchanged", () => {
    expect(pathKey("/home/user/project")).toBe("/home/user/project")
  })
})
