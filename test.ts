import assert from "node:assert/strict";
import { parseCodexUsage, parseFaroBalance } from "./index.js";

const status = { data: { quota_per_unit: 500_000 } };
assert.deepEqual(
	parseFaroBalance({ success: true, data: { quota: 1_250_000 } }, status),
	{ availableUsd: 2.5 },
);
assert.throws(() => parseFaroBalance({ success: false }, status), /badjson/);
assert.throws(() => parseFaroBalance({ success: true, data: { quota: "1250000" } }, status), /badjson/);
assert.throws(() => parseFaroBalance({ success: true, data: {} }, status), /badjson/);

assert.deepEqual(
	parseCodexUsage({
		rate_limit: {
			allowed: true,
			primary_window: {
				used_percent: 20,
				limit_window_seconds: 18_000,
				reset_after_seconds: 7_200,
			},
			secondary_window: {
				used_percent: 40,
				limit_window_seconds: 604_800,
				reset_after_seconds: 86_400,
			},
		},
	}, undefined),
	{
		windows: [
			{ leftPercent: 80, resetInSeconds: 7_200, windowLabel: "5h" },
			{ leftPercent: 60, resetInSeconds: 86_400, windowLabel: "7d" },
		],
		isLimited: false,
	},
);

console.log("Provider usage parsers: ok");
