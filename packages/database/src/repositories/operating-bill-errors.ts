import type { OperatingBillGap } from "./operating-bill-types.js";

export class OperatingBillAlreadyClosedError extends Error {}
export class OperatingBillNotClosedError extends Error {}
export class OperatingBillReferenceError extends Error {}
export class OperatingBillCloseNoteRequiredError extends Error {}
export class OperatingBillFutureOpeningBalanceError extends Error {}
export class OperatingBillOpeningBalanceCurrencyMismatchError extends Error {}
export class OperatingBillOpeningBalanceAlreadyAvailableError extends Error {}
export class OperatingBillIncompleteError extends Error {
  constructor(readonly gaps: OperatingBillGap[]) {
    super("operating_bill_incomplete");
  }
}
