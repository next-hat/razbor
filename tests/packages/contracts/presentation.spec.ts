import assert from "node:assert/strict";
import { test } from "node:test";

import {
  codeFence,
  codeLanguage,
  fileLanguage,
} from "@razbor/contracts/presentation";

test("individual paths and explicit fence labels map to normalized grammars", () => {
  for (const [path, language] of Object.entries({
    "a.ts": "typescript",
    "a.mts": "typescript",
    "a.cts": "typescript",
    "a.tsx": "tsx",
    "a.js": "javascript",
    "a.mjs": "javascript",
    "a.cjs": "javascript",
    "a.jsx": "jsx",
    "a.rs": "rust",
    "a.py": "python",
    "a.go": "go",
    "a.json": "json",
    "a.yaml": "yaml",
    "a.yml": "yaml",
    "a.toml": "toml",
    "a.sh": "bash",
    Dockerfile: "dockerfile",
    "dev/Dockerfile.agent": "dockerfile",
    "prod.dockerfile": "dockerfile",
    "unknown.blob": "text",
  }))
    assert.equal(fileLanguage(path), language, path);
  assert.equal(codeLanguage("ts", "a.py"), "typescript");
  assert.equal(codeLanguage("js"), "javascript");
  assert.equal(codeLanguage("diff", "a.ts"), "diff");
  assert.equal(codeLanguage("", "a.ts"), "typescript");
  assert.equal(codeLanguage("suggestion:-1+2", "a.tsx"), "tsx");
  assert.equal(codeLanguage("not-a-grammar", "a.ts"), "text");
  assert.equal(codeLanguage("constructor"), "text");
});

test("code fences preserve raw indentation, newlines and embedded backticks", () => {
  const code = "  const ticks = ` ``` `;\n\n";
  assert.equal(codeFence(code, "ts"), `\`\`\`\`typescript\n${code}\n\`\`\`\``);
});
