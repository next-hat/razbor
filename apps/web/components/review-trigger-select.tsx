"use client";

import { useId } from "react";

import type { ReviewTriggerMode } from "@razbor/contracts";

import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@web/components/ui/field.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select.js";

export const reviewTriggerLabels = {
  manual: "Manual",
  opt_in_continuous: "On-demand continuous",
  automatic: "Fully automatic",
} satisfies Record<ReviewTriggerMode, string>;

const descriptions = {
  manual: "A permitted user comments /agentic_review for each review.",
  opt_in_continuous:
    "A permitted user comments /agentic_review once per pull request. Later commits trigger reviews until the request closes.",
  automatic:
    "Razbor reviews ready pull requests and new revisions. On public repositories, the PR author must be named in the permitted senders list.",
} satisfies Record<ReviewTriggerMode, string>;

/** Select the repository policy and explain when the choice will incur model usage. */
export function ReviewTriggerSelect({
  value,
  onChange,
  disabled,
  fileManaged,
}: Readonly<{
  value: ReviewTriggerMode;
  onChange: (value: ReviewTriggerMode) => void;
  disabled?: boolean;
  fileManaged?: boolean;
}>) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>Review trigger mode</FieldLabel>
      <Select
        items={reviewTriggerLabels}
        value={value}
        disabled={disabled || fileManaged}
        onValueChange={(mode) => {
          if (mode) onChange(mode);
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-describedby={`${id}-help`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {Object.entries(reviewTriggerLabels).map(([mode, label]) => (
              <SelectItem key={mode} value={mode}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription id={`${id}-help`}>
        {descriptions[value]}{" "}
        {value !== "manual" &&
          "Automatic reviews consume inference tokens and can incur model costs. "}
        {fileManaged && "Change this setting in the repository registry file."}
      </FieldDescription>
    </Field>
  );
}
