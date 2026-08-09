---
name: sandbox-notes
description: 在 Models Kindergarten 沙箱中创建、读取和整理纯文本笔记。用户要求记录、追加整理或读取笔记时使用。
license: MIT
compatibility: Requires Models Kindergarten read_file and write_file tools.
allowed-tools: read_file write_file list_files
metadata:
  author: models-kindergarten
  version: "1.0.0"
---

# 沙箱笔记

1. 将笔记保存在 `notes/` 目录，使用能表达主题的文件名。
2. 修改已有笔记前先调用 `read_file`，避免覆盖用户已经保存的内容。
3. `write_file` 接收完整文件内容；追加时需要把旧内容和新内容合并后一次写回。
4. 工具返回 `ok=true` 后直接使用结果，不要以相同参数重复写入。
5. 最终回复说明笔记的相对路径和实际完成的修改。
