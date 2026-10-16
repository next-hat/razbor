"use client";

import { createContext, useContext, type ComponentProps } from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { codeLanguage, safeReviewUrl } from "@razbor/contracts/presentation";

import { ReviewCode } from "@web/components/review-code.js";

const ReviewPath = createContext("");

/**
 * Replaces Markdown images with their alternate text so rendering does not fetch
 * external images.
 */
function MarkdownImage({ alt }: Readonly<ComponentProps<"img">>) {
  return <span>{alt}</span>;
}

/**
 * Opens transformed review links in an isolated new tab and renders rejected or absent
 * links as plain text.
 */
function MarkdownLink({ href, children }: Readonly<ComponentProps<"a">>) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

/**
 * Extracts a fenced code block, removes its parser-added newline, and infers
 * highlighting from its language or finding path.
 */
function MarkdownCode({ node }: Readonly<ExtraProps>) {
  const path = useContext(ReviewPath);
  const code = node?.children.find(
    (n) => n.type === "element" && n.tagName === "code",
  );
  if (code?.type !== "element") return null;
  const raw = code.children
    .map((n) => (n.type === "text" ? n.value : ""))
    .join("");
  // The Markdown parser appends one delimiter newline to code nodes.
  const original = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const classes = code.properties.className;
  const explicit = Array.isArray(classes)
    ? classes.find((c) => String(c).startsWith("language-"))
    : undefined;
  return (
    <ReviewCode
      code={original}
      language={codeLanguage(
        explicit ? String(explicit).slice(9) : undefined,
        path,
      )}
    />
  );
}

/** Contains wide Markdown tables in a horizontal scroll area. */
function MarkdownTable({ children }: Readonly<ComponentProps<"table">>) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table>{children}</table>
    </div>
  );
}

const markdownComponents = {
  img: MarkdownImage,
  a: MarkdownLink,
  pre: MarkdownCode,
  table: MarkdownTable,
};

/**
 * Renders review Markdown with raw HTML disabled, sanitized URLs, inert images, and
 * syntax-highlighted code blocks.
 */
export function ReviewMarkdown({
  children,
  path = "",
}: Readonly<{ children: string; path?: string }>) {
  return (
    <ReviewPath.Provider value={path}>
      <div className="review-markdown min-w-0 max-w-full text-sm leading-relaxed">
        <Markdown
          skipHtml
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => safeReviewUrl(url) ?? ""}
          components={markdownComponents}
        >
          {children}
        </Markdown>
      </div>
    </ReviewPath.Provider>
  );
}
