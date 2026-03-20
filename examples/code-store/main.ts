import { add, multiply, subtract, divide } from "rit:utils";
import type { MathOp } from "rit:utils";

const op: MathOp = add;
console.log("add(2, 3) =", op(2, 3));
console.log("multiply(4, 5) =", multiply(4, 5));
console.log("subtract(10, 3) =", subtract(10, 3));
console.log("divide(15, 3) =", divide(15, 3));
