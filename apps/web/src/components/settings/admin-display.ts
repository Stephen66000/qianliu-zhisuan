import { ApiError } from "../../api/client";
export const INPUT_CLASS = "h-10 rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-sm text-ql-fg focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-ql-action";
export function errorText(error: unknown): string | null {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;
}
