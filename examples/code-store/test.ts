import { add, multiply, subtract, divide } from "rit:utils";
import type { MathOp } from "rit:utils";

let passed = 0;
let failed = 0;

function assert(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name} — expected ${expected}, got ${actual}`);
  }
}

assert("add(2, 3)", add(2, 3), 5);
assert("add(0, 0)", add(0, 0), 0);
assert("add(-1, 1)", add(-1, 1), 0);
assert("multiply(4, 5)", multiply(4, 5), 20);
assert("multiply(0, 100)", multiply(0, 100), 0);
assert("subtract(10, 3)", subtract(10, 3), 7);
assert("divide(15, 3)", divide(15, 3), 5);
assert("divide(1, 2)", divide(1, 2), 0.5);

// Type check: MathOp should be assignable from any of the functions
const ops: MathOp[] = [add, multiply, subtract, divide];
assert("all ops are MathOp", ops.length, 4);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
