import { useState } from "react";

import { INPUT_CLASS } from "./FormField";

export const NUMERIC_24_8_MONEY_MAX_INTEGER_DIGITS = 16;

export function validateMoneyAmount(value: string, required = false): string | null {
  if (value === "") return required ? "金额不能为空" : null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return "请输入非负金额，最多保留两位小数";
  const integer = value.split(".")[0]!.replace(/^0+(?=\d)/, "");
  if (integer.length > NUMERIC_24_8_MONEY_MAX_INTEGER_DIGITS) {
    return "金额超出系统可保存范围";
  }
  return null;
}

export function normalizeMoneyAmount(value: string): string {
  if (validateMoneyAmount(value) !== null || value === "") return value;
  const [integer, fraction = ""] = value.split(".");
  const canonicalInteger = integer!.replace(/^0+(?=\d)/, "");
  return `${canonicalInteger}.${fraction.padEnd(2, "0")}`;
}

function displayMoneyAmount(value: string): string {
  const normalized = normalizeMoneyAmount(value);
  if (normalized === "") return "";
  if (normalized === value && validateMoneyAmount(value) !== null) return value;
  const [integer, fraction] = normalized.split(".");
  return `${integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

interface MoneyAmountInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  className?: string;
  "aria-invalid"?: boolean;
  placeholder?: string;
}

export function MoneyAmountInput({
  id,
  value,
  onChange,
  onBlur,
  name,
  disabled,
  className = INPUT_CLASS,
  "aria-invalid": ariaInvalid,
  placeholder,
}: MoneyAmountInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      aria-invalid={ariaInvalid}
      className={className}
      disabled={disabled}
      id={id}
      inputMode="decimal"
      name={name}
      onBlur={() => {
        setFocused(false);
        onChange(normalizeMoneyAmount(value));
        onBlur?.();
      }}
      onChange={(event) => onChange(event.target.value.replaceAll(",", ""))}
      onFocus={() => setFocused(true)}
      placeholder={placeholder}
      value={focused ? value : displayMoneyAmount(value)}
    />
  );
}
