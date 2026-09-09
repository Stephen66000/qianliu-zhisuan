import { ApiError } from "../../api/client";
export const INPUT_CLASS = "h-10 rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-sm text-ql-fg focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-ql-action";
export const BUTTON_CLASS = "h-9 rounded-lg bg-ql-action px-3 text-sm font-medium text-white hover:bg-ql-action-hover disabled:cursor-not-allowed disabled:opacity-50";
export function errorText(error: unknown): string | null {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;
}
