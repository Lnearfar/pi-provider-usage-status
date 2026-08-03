import assert from "node:assert/strict";
import { parseFaroBalance } from "./index.js";

const status = { data: { quota_per_unit: 500_000 } };
assert.deepEqual(
	parseFaroBalance({ success: true, data: { quota: 1_250_000 } }, status),
	{ availableUsd: 2.5 },
);
assert.throws(() => parseFaroBalance({ success: false }, status), /badjson/);
assert.throws(() => parseFaroBalance({ success: true, data: { quota: "1250000" } }, status), /badjson/);
assert.throws(() => parseFaroBalance({ success: true, data: {} }, status), /badjson/);

console.log("Faro balance parser: ok");
