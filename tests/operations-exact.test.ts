import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateMinor,
  applyPartialReversal,
  canonicalJson,
  formatDecimal,
  formatMinorUnits,
  moneyForQuantity,
  parseDecimal,
  parseMinorUnits,
  parseMoney,
  parseQuantity,
  remainingReversibleMinor,
  reverseMinor,
  roundHalfUp,
} from "../shared/operations/exact.js";
import { canonicalCommandBody, canonicalCommandBodyHash } from "../server/operations/canonical.js";

test("fixed-point parsing keeps values beyond Number precision and enforces Decimal(38,12)", () => {
  const scaled = parseDecimal("9007199254740993.001", 3);
  assert.equal(scaled, 9_007_199_254_740_993_001n);
  assert.equal(formatDecimal(scaled, 3), "9007199254740993.001");
  assert.equal(parseDecimal("1.2300", 2), 123n);
  assert.equal(formatDecimal(-1n, 2), "-0.01");
  assert.equal(parseDecimal("99999999999999999999999999.999999999999", 12), 10n ** 38n - 1n);
  assert.throws(() => parseDecimal("1.2301", 2), /more than 2 fractional digits/);
  assert.throws(() => parseDecimal("100000000000000000000000000", 0), /exceeds precision/);
  assert.throws(() => parseDecimal("1e3", 2), /plain base-10/);
});

test("quantities retain thousandth-gram precision while ud quantities remain whole", () => {
  assert.equal(parseQuantity("1.237", "g"), 1_237n);
  assert.equal(parseQuantity("0.001", "g"), 1n);
  assert.equal(parseQuantity("12000000000", "ud"), 12_000_000_000n);
  assert.throws(() => parseQuantity("1.001", "ud"), /more than 0 fractional digits/);
  assert.throws(() => parseQuantity("1.0001", "g"), /more than 3 fractional digits/);
});

test("money multiplication rounds once to cents with HALF_UP on either sign", () => {
  assert.equal(moneyForQuantity("1", "0.005"), 1n);
  assert.equal(moneyForQuantity("1", "0.0049"), 0n);
  assert.equal(moneyForQuantity("-1", "0.005"), -1n);
  assert.equal(moneyForQuantity("2147483647", "1"), 214_748_364_700n);
  assert.equal(roundHalfUp(-1n, 2n), -1n);
  assert.equal(parseMoney("123.45"), 12_345n);
  assert.equal(formatMinorUnits(parseMinorUnits("9007199254740993")), "9007199254740993");
  assert.throws(() => moneyForQuantity("0.0001", "1"), /more than 3 fractional digits/);
  assert.throws(() => moneyForQuantity("99999999999999999999999999", "99999999999999999999999999"), /exceeds precision/);
  assert.throws(() => parseMinorUnits("01"), /canonical signed integer/);
});

test("largest-remainder allocation conserves large totals, keeps zero references, and breaks ties by ID", () => {
  const total = 4_294_967_300n;
  const allocated = allocateMinor(total, [
    { id: "z-weight-two", weight: 2n },
    { id: "zero-reference", weight: 0n },
    { id: "b-weight-one", weight: 1n },
  ]);
  assert.deepEqual(allocated, [
    { id: "b-weight-one", amount: 1_431_655_767n },
    { id: "z-weight-two", amount: 2_863_311_533n },
    { id: "zero-reference", amount: 0n },
  ]);
  assert.equal(allocated.reduce((sum, item) => sum + item.amount, 0n), total);

  assert.deepEqual(allocateMinor(1n, [
    { id: "c", weight: 1n },
    { id: "b", weight: 1n },
    { id: "a", weight: 1n },
  ]), [
    { id: "a", amount: 1n },
    { id: "b", amount: 0n },
    { id: "c", amount: 0n },
  ]);
  assert.deepEqual(allocateMinor(-1n, [
    { id: "b", weight: 1n },
    { id: "a", weight: 1n },
  ]), [
    { id: "a", amount: -1n },
    { id: "b", amount: 0n },
  ]);
  assert.throws(() => allocateMinor(1n, [{ id: "empty", weight: 0n }]), /positive allocation weight/);
  assert.throws(() => allocateMinor(1n, [{ id: "same", weight: 1n }, { id: "same", weight: 1n }]), /duplicate allocation ID/);
});

test("partial reversals are exact, signed opposite the original, and bounded by the unreversed amount", () => {
  const original = 9_007_199_254_740_993n;
  assert.equal(reverseMinor(original), -9_007_199_254_740_993n);
  assert.equal(remainingReversibleMinor(original, 2_000n), original - 2_000n);
  assert.deepEqual(applyPartialReversal(1_250n, 300n, 200n), {
    amount: -200n,
    reversedTotal: 500n,
    remaining: 750n,
  });
  assert.deepEqual(applyPartialReversal(-1_250n, 1_050n, 200n), {
    amount: 200n,
    reversedTotal: 1_250n,
    remaining: 0n,
  });
  assert.throws(() => applyPartialReversal(1_250n, 1_050n, 201n), /exceeds the unreversed/);
  assert.throws(() => remainingReversibleMinor(1_250n, 1_251n), /between zero and the original/);
});

test("canonical JSON sorts object names recursively and uses ECMAScript number and string serialization", () => {
  const value = {
    z: "line\n",
    "💩": true,
    a: { b: 1, a: -0 },
    tiny: 1e-7,
    big: 1e21,
  };
  assert.equal(
    canonicalJson(value),
    '{"a":{"a":0,"b":1},"big":1e+21,"tiny":1e-7,"z":"line\\n","💩":true}',
  );
});

test("canonical JSON requires amount-like fields to be exact strings and rejects non-JSON values", () => {
  assert.equal(canonicalJson({ amount: "0.10", amountMinor: "10", deliveryMinor: "25", paymentKey: "abc-123", totalItems: 3, version: 1 }),
    '{"amount":"0.10","amountMinor":"10","deliveryMinor":"25","paymentKey":"abc-123","totalItems":3,"version":1}');
  assert.throws(() => canonicalJson({ amount: 10 }), /must be a string/);
  assert.throws(() => canonicalJson({ price: "1e3" }), /plain base-10/);
  assert.throws(() => canonicalJson({ amountMinor: "01" }), /canonical signed integer/);
  assert.throws(() => canonicalJson({ referenceMinor: 25 }), /must be a string/);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ value: undefined }), /JSON data model/);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), /circular references/);
  assert.throws(() => canonicalJson({ value: "\ud800" }), /valid Unicode/);
});

test("receipt hashing covers the complete wire command and ignores only object key order", () => {
  const command = {
    schemaVersion: 1 as const,
    requestId: "84933422-c7de-44ca-abfc-135d66ce77d2",
    expectedVersion: 0,
    targetId: "abc",
    data: { amountMinor: "1234" },
    command: "CollectionReported",
    occurredAt: "2026-09-30T12:00:00.000Z",
  };
  assert.equal(canonicalCommandBody(command),
    '{"command":"CollectionReported","data":{"amountMinor":"1234"},"expectedVersion":0,"occurredAt":"2026-09-30T12:00:00.000Z","requestId":"84933422-c7de-44ca-abfc-135d66ce77d2","schemaVersion":1,"targetId":"abc"}');
  assert.equal(canonicalCommandBodyHash(command), canonicalCommandBodyHash({ data: command.data, command: command.command, targetId: command.targetId, occurredAt: command.occurredAt, expectedVersion: command.expectedVersion, schemaVersion: command.schemaVersion, requestId: command.requestId }));
  for (const changed of [{ ...command, expectedVersion: 1 }, { ...command, targetId: "another-object" }, { ...command, data: { amountMinor: "1235" } }]) assert.notEqual(canonicalCommandBodyHash(command), canonicalCommandBodyHash(changed));
  assert.throws(() => canonicalCommandBody({ ...command, data: { amountMinor: 1234 } }), /must be a string/);
});
