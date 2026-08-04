import { useLayoutEffect, useRef } from "react";

import { INPUT_CLASS } from "./FormField";

export const POSTGRES_BIGINT_MAX = "9223372036854775807";
export const NUMERIC_30_8_INTEGER_MAX = "9999999999999999999999";

export function normalizeIntegerAmountInput(displayValue: string): string {
  if (displayValue === "") return "";
  if (/^\d+$/.test(displayValue)) return displayValue;
  if (/^\d{1,3}(?:,\d{3})+$/.test(displayValue)) {
    return displayValue.replaceAll(",", "");
  }
  return displayValue;
}

export function formatIntegerAmountInput(rawValue: string): string {
  if (!/^\d+$/.test(rawValue)) return rawValue;
  const canonical = rawValue.replace(/^0+(?=\d)/, "");
  return canonical.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function validateIntegerAmount(
  value: string,
  max: string,
  required = true,
): string | null {
  if (value === "") return required ? "额度不能为空" : null;
  if (!/^\d+$/.test(value)) return "请输入非负整数，可粘贴带千分位的数字";
  const canonical = value.replace(/^0+(?=\d)/, "");
  if (canonical.length > max.length || (canonical.length === max.length && canonical > max)) {
    return `额度不能超过 ${formatIntegerAmountInput(max)}`;
  }
  return null;
}

interface IntegerAmountInputProps {
  id: string;
  value: string;
  onChange: (rawValue: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  className?: string;
  "aria-invalid"?: boolean;
}

export function IntegerAmountInput({
  id,
  value,
  onChange,
  onBlur,
  name,
  disabled,
  className = INPUT_CLASS,
  "aria-invalid": ariaInvalid,
}: IntegerAmountInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const caretDigitOffset = useRef<number | null>(null);
  const displayValue = formatIntegerAmountInput(value);

  useLayoutEffect(() => {
    const digitOffset = caretDigitOffset.current;
    const input = inputRef.current;
    if (digitOffset === null || !input || !/^\d[\d,]*$/.test(displayValue)) return;
    let cursor = 0;
    let digits = 0;
    while (cursor < displayValue.length && digits < digitOffset) {
      if (/\d/.test(displayValue[cursor]!)) digits += 1;
      cursor += 1;
    }
    input.setSelectionRange(cursor, cursor);
    caretDigitOffset.current = null;
  }, [displayValue]);

  return (
    <input
      aria-invalid={ariaInvalid}
      className={className}
      disabled={disabled}
      id={id}
      inputMode="numeric"
      name={name}
      onBlur={onBlur}
      onChange={(event) => {
        const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
        caretDigitOffset.current = event.currentTarget.value.slice(0, cursor).replace(/\D/g, "").length;
        const typedValue = event.currentTarget.value;
        onChange(/^[\d,]+$/.test(typedValue) ? typedValue.replaceAll(",", "") : typedValue);
      }}
      onPaste={(event) => {
        const pasted = event.clipboardData.getData("text");
        const normalized = normalizeIntegerAmountInput(pasted);
        if (normalized === pasted && !/^\d+$/.test(pasted)) {
          event.preventDefault();
          onChange(pasted);
        }
      }}
      ref={inputRef}
      value={displayValue}
    />
  );
}
