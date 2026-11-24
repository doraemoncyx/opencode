# Home projects

`view.tsx` is upstream-owned. The fork adds only two things: the `getParentFolderName` import and the duplicate-name folder hint, plus the server label under the compact dropdown's selected project.

When merging `upstream/dev`, take upstream's imports and trigger markup verbatim, then re-add those two blocks. Do not restore the old `<span>` wrapper or reword upstream's class names; that drift is what creates the conflict every sync.
