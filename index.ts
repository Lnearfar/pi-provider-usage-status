import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATUS_KEY = "provider-usage";
const CODEX_REFRESH_INTERVAL_MS = 60_000;
const BALANCE_COOLDOWN_MS = 30_000;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_MISSING_AUTH_ERROR = "Missing openai-codex OAuth access/accountId";
const SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SPARK_LIMIT_NAME = "GPT-5.3-Codex-Spark";
const DEEPSEEK_BALANCE_API_URL = "https://api.deepseek.com/user/balance";
const FARO_ACCOUNT_API_URL = "https://faroapi.com/api/user/self";
const FARO_STATUS_API_URL = "https://faroapi.com/api/status";
const FARO_MISSING_AUTH_ERROR = "Missing FARO_ACCESS_TOKEN/FARO_USER_ID";
const FARO_INVALID_AUTH_ERROR = "Invalid Faro account credentials";
const PROXY_MANAGED_SENTINEL = "proxy-managed";

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
const AUTH_FILE = path.join(agentDir, "auth.json");
const SETTINGS_FILE = path.join(agentDir, "settings.json");
const SETTINGS_KEY = "pi-codex-usage";

type JsonObject = Record<string, unknown>;
type PercentMode = "left" | "used";
type Theme = ExtensionContext["ui"]["theme"];

type Preferences = {
	usageMode: PercentMode;
};

type UsageWindow = {
	used_percent?: number | null;
	limit_window_seconds?: number | null;
	reset_after_seconds?: number | null;
	reset_at?: number | null;
};

type RateLimitBucket = {
	allowed?: boolean;
	limit_reached?: boolean;
	primary_window?: UsageWindow | null;
};

type CodexUsageSnapshot = {
	leftPercent: number | null;
	resetInSeconds: number | null;
	windowLabel: string;
	isLimited: boolean;
};

type DeepSeekBalance = {
	isAvailable: boolean;
	balances: Array<{
		currency: string;
		totalBalance: string;
		grantedBalance: string;
		toppedUpBalance: string;
	}>;
};

type FaroBalance = {
	availableUsd: number;
};

const DEFAULT_PREFERENCES = { usageMode: "left" } satisfies Preferences;

const preferenceCommands = [
	{
		name: "codex-usage-mode",
		description: "Toggle Codex usage display mode, or set it explicitly: left | used",
		key: "usageMode",
		choices: ["left", "used"],
	},
] as const;

type PreferenceCommand = typeof preferenceCommands[number];

function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isStaleContextError(error: unknown): boolean {
	return errorMessage(error).includes("extension ctx is stale");
}

function contextValue<T>(getter: () => T): T | undefined {
	try {
		return getter();
	} catch (error) {
		if (isStaleContextError(error)) return undefined;
		throw error;
	}
}

function contextHasUI(ctx: ExtensionContext): boolean {
	return contextValue(() => ctx.hasUI) === true;
}

function contextTheme(ctx: ExtensionContext): Theme | undefined {
	return contextValue(() => ctx.ui.theme);
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
	try {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, value);
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
	}
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
	}
}

function modelProvider(ctx: ExtensionContext): string | undefined {
	return contextValue(() => ctx.model?.provider);
}

function contextModelId(ctx: ExtensionContext): string | undefined {
	return contextValue(() => ctx.model?.id);
}

function isProvider(provider: string | undefined, prefixes: string[]): boolean {
	const normalized = provider?.toLowerCase() ?? "";
	return prefixes.some(prefix => normalized.startsWith(prefix));
}

function isCodexProvider(ctx: ExtensionContext): boolean {
	return isProvider(modelProvider(ctx), ["openai-codex", "openai", "codex", "chatgpt"]);
}

function isDeepSeekProvider(ctx: ExtensionContext): boolean {
	return isProvider(modelProvider(ctx), ["deepseek"]);
}

function isFaroProvider(ctx: ExtensionContext): boolean {
	return isProvider(modelProvider(ctx), ["faro"]);
}

function activeProvider(ctx: ExtensionContext): "codex" | "deepseek" | "faro" | undefined {
	if (isCodexProvider(ctx)) return "codex";
	if (isDeepSeekProvider(ctx)) return "deepseek";
	if (isFaroProvider(ctx)) return "faro";
	return undefined;
}

async function readJsonObject(file: string): Promise<JsonObject> {
	try {
		return asObject(JSON.parse(await fs.readFile(file, "utf8"))) ?? {};
	} catch (error) {
		if (asObject(error)?.code === "ENOENT") return {};
		throw error;
	}
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return typeof value === "string" && (choices as readonly string[]).includes(value);
}

function normalizePreferences(value: unknown): Preferences {
	const settings = asObject(value);
	return {
		usageMode: isOneOf(settings?.usageMode, ["left", "used"] as const) ? settings.usageMode : DEFAULT_PREFERENCES.usageMode,
	};
}

async function loadPreferences(): Promise<Preferences> {
	const settings = await readJsonObject(SETTINGS_FILE);
	const preferences = normalizePreferences(settings[SETTINGS_KEY]);
	const persisted = asObject(settings[SETTINGS_KEY]);
	if (!persisted || persisted.usageMode !== preferences.usageMode || "refreshWindow" in persisted) {
		settings[SETTINGS_KEY] = preferences;
		await writeJson(SETTINGS_FILE, settings);
	}
	return preferences;
}

async function savePreferences(preferences: Preferences): Promise<void> {
	const settings = await readJsonObject(SETTINGS_FILE);
	settings[SETTINGS_KEY] = preferences;
	await writeJson(SETTINGS_FILE, settings);
}

function parseChoice<T extends string>(args: string, choices: readonly T[], current: T): T | null {
	const token = args.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
	if (!token || token === "toggle") return choices[(choices.indexOf(current) + 1) % choices.length] ?? current;
	return (choices as readonly string[]).includes(token) ? token as T : null;
}

function completions(choices: readonly string[], prefix: string) {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const items = [...choices, "toggle"].map(value => ({ value, label: value, description: value === "toggle" ? "Toggle current value" : `Set to ${value}` }));
	const matches = normalizedPrefix ? items.filter(item => item.value.startsWith(normalizedPrefix)) : items;
	return matches.length ? matches : null;
}

async function loadCodexAuthCredentials(): Promise<{ accessToken: string; accountId: string }> {
	const auth = await readJsonObject(AUTH_FILE);
	const entry = asObject(auth["openai-codex"]);
	const accessToken = entry?.type === "oauth" && typeof entry.access === "string" ? entry.access.trim() : undefined;
	const rawAccountId = entry?.accountId ?? entry?.account_id;
	const accountId = typeof rawAccountId === "string" ? rawAccountId.trim() : undefined;

	if (!accessToken || !accountId) throw new Error(`${CODEX_MISSING_AUTH_ERROR} in ${AUTH_FILE}`);
	return { accessToken, accountId };
}

async function requestCodexUsage(): Promise<{ rate_limit?: unknown; additional_rate_limits?: unknown }> {
	const { accessToken, accountId } = await loadCodexAuthCredentials();
	const response = await fetch(CODEX_USAGE_URL, {
		headers: {
			accept: "*/*",
			authorization: `Bearer ${accessToken}`,
			"chatgpt-account-id": accountId,
		},
	});

	if (!response.ok) throw new Error(`Codex usage request failed (${response.status}) for ${CODEX_USAGE_URL}`);
	return await response.json() as { rate_limit?: unknown; additional_rate_limits?: unknown };
}

function toPercentLeft(used: unknown): number | null {
	return typeof used === "number" && !Number.isNaN(used) ? Math.min(100, Math.max(0, 100 - used)) : null;
}

function resetSeconds(window: UsageWindow | null | undefined): number | null {
	if (typeof window?.reset_after_seconds === "number" && !Number.isNaN(window.reset_after_seconds)) return window.reset_after_seconds;
	if (typeof window?.reset_at !== "number" || Number.isNaN(window.reset_at)) return null;

	const resetAtSeconds = window.reset_at > 100_000_000_000 ? window.reset_at / 1000 : window.reset_at;
	return Math.max(0, resetAtSeconds - Date.now() / 1000);
}

function rateLimitBucket(value: unknown): RateLimitBucket | null {
	const record = asObject(value);
	return record && ("primary_window" in record || "limit_reached" in record || "allowed" in record)
		? record as RateLimitBucket
		: null;
}

function selectedCodexBucket(data: { rate_limit?: unknown; additional_rate_limits?: unknown }, modelId: string | undefined): RateLimitBucket | null {
	if (modelId !== SPARK_MODEL_ID) return rateLimitBucket(data.rate_limit);

	const additionalLimits = Array.isArray(data.additional_rate_limits)
		? data.additional_rate_limits
		: Object.values(asObject(data.additional_rate_limits) ?? {});

	for (const value of additionalLimits) {
		const record = asObject(value);
		const bucket = record?.limit_name === SPARK_LIMIT_NAME && rateLimitBucket(record.rate_limit);
		if (bucket) return bucket;
	}
	return null;
}

function formatWindowLabel(seconds: unknown): string {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "7d";
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	return `${Math.round(seconds / 3_600)}h`;
}

async function getCodexUsage(modelId: string | undefined): Promise<CodexUsageSnapshot> {
	const bucket = selectedCodexBucket(await requestCodexUsage(), modelId);
	const window = bucket?.primary_window;
	return {
		leftPercent: toPercentLeft(window?.used_percent),
		resetInSeconds: resetSeconds(window),
		windowLabel: formatWindowLabel(window?.limit_window_seconds),
		isLimited: bucket?.limit_reached === true || bucket?.allowed === false,
	};
}

function codexModelLabel(modelId: string | undefined): string {
	return modelId === SPARK_MODEL_ID ? "Codex Spark" : "Codex";
}

function formatPercent(theme: Theme, leftPercent: number | null, mode: PercentMode): string {
	if (leftPercent === null) return theme.fg("muted", "--");

	const color = leftPercent <= 10 ? "error" : leftPercent <= 25 ? "warning" : "success";
	const displayed = mode === "left" ? leftPercent : 100 - leftPercent;
	return theme.fg(color, `${Math.round(displayed)}% ${mode}`);
}

function formatCountdown(seconds: number | null): string | null {
	if (seconds === null || Number.isNaN(seconds)) return null;

	const total = Math.max(0, Math.round(seconds));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);

	if (days) return `${days}d${hours}h`;
	if (hours) return `${hours}h${minutes}m`;
	return minutes ? `${minutes}m` : `${total % 60}s`;
}

function formatCodexStatus(theme: Theme, usage: CodexUsageSnapshot, preferences: Preferences, modelId: string | undefined): string {
	const title = theme.fg(usage.isLimited ? "error" : "dim", codexModelLabel(modelId));
	const usageText = `${theme.fg("dim", `${usage.windowLabel}:`)}${formatPercent(theme, usage.leftPercent, preferences.usageMode)}`;
	const reset = formatCountdown(usage.resetInSeconds);
	const resetText = reset ? theme.fg("dim", ` (↺${reset})`) : "";
	return `${title} ${usageText}${resetText}`;
}

function unavailableCodexStatus(theme: Theme, modelId: string | undefined): string {
	return theme.fg("warning", `${codexModelLabel(modelId)} unavailable`);
}

async function buildApiKeyAuthHeaders(ctx: ExtensionContext, provider: string): Promise<Record<string, string>> {
	const modelRegistry = contextValue(() => ctx.modelRegistry);
	const apiKey = modelRegistry ? await modelRegistry.getApiKeyForProvider(provider) : undefined;
	const headers: Record<string, string> = { "Accept-Encoding": "identity" };
	if (apiKey && apiKey !== PROXY_MANAGED_SENTINEL) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		throw new Error(`fetch: ${errorMessage(error)}`);
	}
	if (!response.ok) throw new Error(`http${response.status}`);
	try {
		return await response.json();
	} catch (error) {
		throw new Error(`badjson: ${errorMessage(error)}`);
	}
}

async function getDeepSeekBalance(ctx: ExtensionContext): Promise<DeepSeekBalance> {
	const data = asObject(await fetchJson(DEEPSEEK_BALANCE_API_URL, { headers: await buildApiKeyAuthHeaders(ctx, "deepseek") }));
	const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
	return {
		isAvailable: data?.is_available === true,
		balances: infos.map(info => {
			const record = asObject(info) ?? {};
			return {
				currency: typeof record.currency === "string" ? record.currency : "",
				totalBalance: typeof record.total_balance === "string" ? record.total_balance : String(record.total_balance ?? "0"),
				grantedBalance: typeof record.granted_balance === "string" ? record.granted_balance : String(record.granted_balance ?? "0"),
				toppedUpBalance: typeof record.topped_up_balance === "string" ? record.topped_up_balance : String(record.topped_up_balance ?? "0"),
			};
		}),
	};
}

function colorForCredit(value: number, theme: Theme): (text: string) => string {
	if (value <= 1) return text => theme.fg("error", text);
	if (value <= 5) return text => theme.fg("warning", text);
	return text => theme.fg("success", text);
}

function currencySymbol(currency: string): string {
	if (currency === "USD") return "$";
	if (currency === "CNY") return "¥";
	return `${currency} `;
}

function formatMoney(amount: number, currency: string): string {
	const symbol = currencySymbol(currency);
	const abs = Math.abs(amount).toFixed(2);
	return amount < 0 ? `-${symbol}${abs}` : `${symbol}${abs}`;
}

function renderDeepSeekStatus(data: DeepSeekBalance, theme: Theme): string {
	const balance = data.balances.find(item => item.currency === "USD") ?? data.balances[0];
	if (!balance) return theme.fg("muted", "DeepSeek:") + theme.fg("accent", "No balance");
	const amount = parseFloat(balance.totalBalance);
	return theme.fg("muted", "DeepSeek:") + colorForCredit(amount, theme)(formatMoney(amount, balance.currency));
}

function faroAccountHeaders(): Record<string, string> {
	const accessToken = process.env.FARO_ACCESS_TOKEN?.trim();
	const userId = process.env.FARO_USER_ID?.trim();
	if (!accessToken || !userId) throw new Error(FARO_MISSING_AUTH_ERROR);
	return {
		Authorization: `Bearer ${accessToken}`,
		"New-Api-User": userId,
		"Accept-Encoding": "identity",
	};
}

export function parseFaroBalance(accountValue: unknown, statusValue: unknown): FaroBalance {
	const account = asObject(accountValue);
	const data = asObject(account?.data);
	const status = asObject(asObject(statusValue)?.data);
	const quotaPerUnit = typeof status?.quota_per_unit === "number" ? status.quota_per_unit : Number.NaN;
	const quota = typeof data?.quota === "number" ? data.quota : Number.NaN;
	if (account?.success !== true || !data || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0 || !Number.isFinite(quota)) {
		throw new Error("badjson: invalid Faro account response");
	}
	return { availableUsd: quota / quotaPerUnit };
}

async function getFaroBalance(): Promise<FaroBalance> {
	const [account, status] = await Promise.all([
		fetchJson(FARO_ACCOUNT_API_URL, { headers: faroAccountHeaders() }),
		fetchJson(FARO_STATUS_API_URL),
	]);
	if (asObject(account)?.success === false) throw new Error(FARO_INVALID_AUTH_ERROR);
	return parseFaroBalance(account, status);
}

function renderFaroStatus(data: FaroBalance, theme: Theme): string {
	return theme.fg("muted", "Faro:") + colorForCredit(data.availableUsd, theme)(formatMoney(data.availableUsd, "USD"));
}

function renderBalanceError(provider: string, error: unknown, theme: Theme): string {
	const message = errorMessage(error);
	const code = message.match(/\b(http\d+|fetch|badjson)\b/)?.[1] ?? "fetch";
	return theme.fg("muted", `${provider}:`) + theme.fg("error", `<err:${code}>`);
}

class ProviderUsageStatus {
	private ctx?: ExtensionContext;
	private generation = 0;
	private timer?: ReturnType<typeof setInterval>;
	private codexInFlight = false;
	private codexQueued?: { ctx: ExtensionContext; generation: number; modelId?: string };
	private lastCodexUsage?: CodexUsageSnapshot;
	private preferences: Preferences = { ...DEFAULT_PREFERENCES };
	private preferenceRevision = 0;
	private preferenceQueue: Promise<void> = Promise.resolve();
	private deepSeekInFlight = false;
	private lastDeepSeekData?: DeepSeekBalance;
	private lastDeepSeekFetchTime = 0;
	private faroInFlight = false;
	private faroQueued?: { ctx: ExtensionContext; generation: number; force: boolean };
	private lastFaroData?: FaroBalance;
	private lastFaroFetchTime = 0;

	public constructor(private readonly pi: ExtensionAPI) {
		pi.on("session_start", (_event, ctx) => this.start(ctx));
		pi.on("turn_end", (_event, ctx) => this.runInBackground(this.refreshForCurrentProvider(ctx), ctx));
		pi.on("model_select", (_event, ctx) => void this.onModelSelect(ctx));
		pi.on("session_shutdown", (_event, ctx) => this.stop(ctx));

		for (const command of preferenceCommands) this.registerPreferenceCommand(command);
	}

	private isCurrent(generation: number): boolean {
		return this.ctx !== undefined && this.generation === generation;
	}

	private clearCapturedContext(ctx?: ExtensionContext): void {
		if (ctx && this.ctx && ctx !== this.ctx) return;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.codexQueued = undefined;
		this.faroQueued = undefined;
		this.ctx = undefined;
		this.generation++;
	}

	private runInBackground(promise: Promise<void>, ctx?: ExtensionContext): void {
		void promise.catch(error => {
			if (isStaleContextError(error)) {
				this.clearCapturedContext(ctx);
				return;
			}
			console.error("provider-usage-status background refresh failed:", error);
		});
	}

	private start(ctx: ExtensionContext): void {
		this.generation++;
		this.ctx = ctx;
		setStatus(ctx, undefined);
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => this.refreshCodexTimer(), CODEX_REFRESH_INTERVAL_MS);
		this.timer.unref?.();

		const generation = this.generation;
		this.runInBackground((async () => {
			await this.loadPreferences(ctx, generation);
			await this.refreshForCurrentProvider(ctx, generation, true);
		})(), ctx);
	}

	private stop(ctx: ExtensionContext): void {
		this.clearCapturedContext(ctx);
		setStatus(ctx, undefined);
	}

	private onModelSelect(ctx: ExtensionContext): void {
		this.generation++;
		this.ctx = ctx;
		setStatus(ctx, undefined);
		this.runInBackground(this.refreshForCurrentProvider(ctx, this.generation, true), ctx);
	}

	private refreshCodexTimer(): void {
		try {
			const ctx = this.ctx;
			if (!ctx || !isCodexProvider(ctx)) return;
			this.runInBackground(this.refreshCodex(ctx, contextModelId(ctx), this.generation), ctx);
		} catch (error) {
			if (isStaleContextError(error)) {
				this.clearCapturedContext();
				return;
			}
			throw error;
		}
	}

	private async refreshForCurrentProvider(ctx = this.ctx, generation = this.generation, force = false): Promise<void> {
		if (!ctx || !contextHasUI(ctx) || !this.isCurrent(generation)) return;
		switch (activeProvider(ctx)) {
			case "codex":
				await this.refreshCodex(ctx, contextModelId(ctx), generation);
				break;
			case "deepseek":
				await this.refreshDeepSeek(ctx, generation, force);
				break;
			case "faro":
				await this.refreshFaro(ctx, generation, force);
				break;
			default:
				setStatus(ctx, undefined);
		}
	}

	private enqueuePreferenceOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.preferenceQueue.then(operation);
		this.preferenceQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async loadPreferences(ctx: ExtensionContext, generation: number): Promise<void> {
		const revision = this.preferenceRevision;
		try {
			const preferences = await this.enqueuePreferenceOperation(() => loadPreferences());
			if (this.isCurrent(generation) && this.preferenceRevision === revision) this.preferences = preferences;
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			const changedDuringLoad = this.preferenceRevision !== revision;
			if (!changedDuringLoad) this.preferences = { ...DEFAULT_PREFERENCES };
			const action = changedDuringLoad ? "keeping current preferences" : "using defaults";
			notify(ctx, `provider-usage-status: failed to load ${SETTINGS_FILE}, ${action}: ${errorMessage(error)}`, "warning");
		}
	}

	private async refreshCodex(ctx = this.ctx, modelId = ctx ? contextModelId(ctx) : undefined, generation = this.generation): Promise<void> {
		if (!ctx || !contextHasUI(ctx) || !this.isCurrent(generation) || !isCodexProvider(ctx)) return;

		if (this.codexInFlight) {
			this.codexQueued = { ctx, generation, modelId };
			return;
		}

		this.codexInFlight = true;
		try {
			const usage = await getCodexUsage(modelId);
			if (!this.isCurrent(generation) || !isCodexProvider(ctx)) return;
			const theme = contextTheme(ctx);
			if (!theme) return;
			this.lastCodexUsage = usage;
			setStatus(ctx, formatCodexStatus(theme, usage, this.preferences, modelId));
		} catch (error) {
			if (!this.isCurrent(generation) || !isCodexProvider(ctx)) return;
			const theme = contextTheme(ctx);
			if (errorMessage(error).includes(CODEX_MISSING_AUTH_ERROR)) {
				this.lastCodexUsage = undefined;
				setStatus(ctx, undefined);
			} else if (theme) {
				setStatus(ctx, unavailableCodexStatus(theme, modelId));
			}
		} finally {
			this.codexInFlight = false;
			const queued = this.codexQueued;
			this.codexQueued = undefined;
			if (queued && this.isCurrent(queued.generation)) this.runInBackground(this.refreshCodex(queued.ctx, queued.modelId, queued.generation), queued.ctx);
		}
	}

	private async refreshDeepSeek(ctx: ExtensionContext, generation = this.generation, force = false): Promise<void> {
		if (!contextHasUI(ctx) || !this.isCurrent(generation) || !isDeepSeekProvider(ctx) || this.deepSeekInFlight) return;
		const now = Date.now();
		const cachedTheme = contextTheme(ctx);
		if (!force && this.lastDeepSeekData && now - this.lastDeepSeekFetchTime < BALANCE_COOLDOWN_MS && cachedTheme) {
			setStatus(ctx, renderDeepSeekStatus(this.lastDeepSeekData, cachedTheme));
			return;
		}

		this.deepSeekInFlight = true;
		try {
			const data = await getDeepSeekBalance(ctx);
			if (!this.isCurrent(generation) || !isDeepSeekProvider(ctx)) return;
			const theme = contextTheme(ctx);
			if (!theme) return;
			this.lastDeepSeekData = data;
			this.lastDeepSeekFetchTime = now;
			setStatus(ctx, renderDeepSeekStatus(data, theme));
		} catch (error) {
			if (!this.isCurrent(generation) || !isDeepSeekProvider(ctx)) return;
			const theme = contextTheme(ctx);
			if (theme) setStatus(ctx, renderBalanceError("DeepSeek", error, theme));
		} finally {
			this.deepSeekInFlight = false;
		}
	}

	private async refreshFaro(ctx: ExtensionContext, generation = this.generation, force = false): Promise<void> {
		if (!contextHasUI(ctx) || !this.isCurrent(generation) || !isFaroProvider(ctx)) return;
		if (this.faroInFlight) {
			this.faroQueued = { ctx, generation, force };
			return;
		}
		const now = Date.now();
		const cachedTheme = contextTheme(ctx);
		if (!force && this.lastFaroData && now - this.lastFaroFetchTime < BALANCE_COOLDOWN_MS && cachedTheme) {
			setStatus(ctx, renderFaroStatus(this.lastFaroData, cachedTheme));
			return;
		}

		this.faroInFlight = true;
		try {
			const data = await getFaroBalance();
			if (!this.isCurrent(generation) || !isFaroProvider(ctx)) return;
			const theme = contextTheme(ctx);
			if (!theme) return;
			this.lastFaroData = data;
			this.lastFaroFetchTime = now;
			setStatus(ctx, renderFaroStatus(data, theme));
		} catch (error) {
			if (!this.isCurrent(generation) || !isFaroProvider(ctx)) return;
			const theme = contextTheme(ctx);
			if (errorMessage(error).includes(FARO_MISSING_AUTH_ERROR)) {
				if (theme) setStatus(ctx, theme.fg("warning", "Faro:auth required"));
			} else if (errorMessage(error).includes(FARO_INVALID_AUTH_ERROR)) {
				if (theme) setStatus(ctx, theme.fg("error", "Faro:auth invalid"));
			} else if (theme) {
				setStatus(ctx, renderBalanceError("Faro", error, theme));
			}
		} finally {
			this.faroInFlight = false;
			const queued = this.faroQueued;
			this.faroQueued = undefined;
			if (queued && this.isCurrent(queued.generation)) this.runInBackground(this.refreshFaro(queued.ctx, queued.generation, queued.force), queued.ctx);
		}
	}

	private renderLastCodex(ctx: ExtensionContext): boolean {
		const theme = contextTheme(ctx);
		if (!contextHasUI(ctx) || !theme || !this.lastCodexUsage || !isCodexProvider(ctx)) return false;
		setStatus(ctx, formatCodexStatus(theme, this.lastCodexUsage, this.preferences, contextModelId(ctx)));
		return true;
	}

	private savePreferences(ctx: ExtensionContext, generation = this.generation): void {
		const preferences = { ...this.preferences };
		const result = this.enqueuePreferenceOperation(() => savePreferences(preferences));
		void result.catch(error => {
			const notifyContext = this.ctx ?? ctx;
			if (this.isCurrent(generation)) {
				notify(notifyContext, `provider-usage-status: failed to write ${SETTINGS_FILE}: ${errorMessage(error)}`, "warning");
			}
		});
	}

	private registerPreferenceCommand(command: PreferenceCommand): void {
		this.pi.registerCommand(command.name, {
			description: command.description,
			getArgumentCompletions: prefix => completions(command.choices, prefix),
			handler: async (args, ctx) => {
				const current = this.preferences[command.key];
				const next = parseChoice(args, command.choices, current);
				if (!next) return;

				this.preferenceRevision++;
				this.preferences = { ...this.preferences, [command.key]: next } as Preferences;
				this.savePreferences(ctx);
				if (isCodexProvider(ctx) && !this.renderLastCodex(ctx)) await this.refreshCodex(ctx);
			},
		});
	}
}

export default function (pi: ExtensionAPI) {
	new ProviderUsageStatus(pi);
}
