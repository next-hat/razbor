"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Check, Copy } from "lucide-react";

import { codeLanguage } from "@razbor/contracts/presentation";

import { Button } from "@web/components/ui/button.js";
import type { HighlightTokens } from "@web/lib/highlight.js";

/**
 * Displays inert code with lazy syntax highlighting and copy support, retaining plain
 * text if highlighting fails.
 */
export function ReviewCode({
  code,
  language,
}: Readonly<{
  code: string;
  language: string;
}>) {
  const label = codeLanguage(language);
  const [highlight, setHighlight] = useState<{
    code: string;
    label: string;
    tokens: HighlightTokens;
  }>();
  const [copyStatus, setCopyStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    let active = true;
    void import("@web/lib/highlight.js")
      .then(({ highlightCode }) => highlightCode(code, label))
      .then((tokens) => {
        if (active) setHighlight({ code, label, tokens });
      })
      .catch(() => {
        /* Plain inert code remains readable if highlighting fails. */
      });
    return () => {
      active = false;
    };
  }, [code, label]);
  const tokens =
    highlight?.code === code && highlight.label === label
      ? highlight.tokens
      : undefined;
  /**
   * Copies the original code and briefly reports the result, replacing any previous
   * feedback timer.
   */
  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed");
    }
    timer.current = setTimeout(() => setCopyStatus(""), 2000);
  }
  let lineOffset = 0;
  const tokenLines = tokens?.map((line) => {
    const offset = lineOffset;
    lineOffset +=
      line.reduce((length, token) => length + token.content.length, 0) + 1;
    return { offset, tokens: line };
  });
  return (
    <div className="review-code min-w-0 max-w-full overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">
          {label === "text" ? "Plain text" : label}
        </span>
        <div className="flex items-center gap-2">
          <output className="text-xs text-muted-foreground">
            {copyStatus}
          </output>
          <Button
            variant="ghost"
            size="xs"
            aria-label="Copy code"
            onClick={copy}
          >
            {copyStatus === "Copied" ? (
              <Check data-icon="inline-start" />
            ) : (
              <Copy data-icon="inline-start" />
            )}
            Copy
          </Button>
        </div>
      </div>
      <pre
        tabIndex={0}
        aria-label={`${label} code`}
        className="max-w-full overflow-x-auto p-4 font-mono text-xs leading-6"
      >
        <code>
          {tokens
            ? tokenLines?.map((line) => (
                <Fragment key={line.offset}>
                  {line.offset > 0 ? "\n" : ""}
                  {line.tokens.map((token) => (
                    <span
                      key={token.offset}
                      style={token.htmlStyle as CSSProperties}
                    >
                      {token.content}
                    </span>
                  ))}
                </Fragment>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
