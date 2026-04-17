/**
 * 与 pad-expand-agent-mvp 通信：HTTP + `application/json`，请求头 `X-Agent-Key`。
 */

export type PadExpandAgentStatus = 'collecting' | 'confirming' | 'completed' | 'error';

export interface PadExpandNormalized {
	outputKind: 'forbidden_pour' | 'forbidden_fill' | 'solder_mask';
	expMil: number;
	continuous: boolean;
}

export interface ChatStartResponse {
	sessionId: string;
	reply: string;
}

export interface ChatTurnResponse {
	sessionId: string;
	status: PadExpandAgentStatus;
	reply: string;
	normalized: PadExpandNormalized | null;
	missingFields?: string[];
	errors?: string[];
}

function trimBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/$/, '');
}

export type PostJsonFn = (url: string, jsonBody: string, headers?: Record<string, string>) => Promise<Response>;

function throwHttpJsonError(res: Response, bodyText: string): never {
	let parsed: { error?: unknown };
	try {
		parsed = JSON.parse(bodyText) as { error?: unknown };
	}
	catch {
		throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 800)}` : ''}`);
	}
	if (typeof parsed.error === 'string') {
		throw new TypeError(parsed.error);
	}
	throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 800)}` : ''}`);
}

export async function chatStart(
	baseUrl: string,
	postJson: PostJsonFn,
	onDelta?: (chunk: string) => void,
): Promise<ChatStartResponse> {
	const url = `${trimBaseUrl(baseUrl)}/chat/start`;
	const requestId = crypto.randomUUID();
	const res = await postJson(url, '{}', { 'X-Request-Id': requestId });
	const text = await res.text();
	if (!res.ok) {
		throwHttpJsonError(res, text);
	}
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(text) as Record<string, unknown>;
	}
	catch {
		throw new Error('chat/start: 响应非 JSON');
	}
	const sessionId = data.sessionId;
	const reply = data.reply;
	if (typeof sessionId !== 'string' || typeof reply !== 'string') {
		throw new TypeError('chat/start: 缺少 sessionId 或 reply');
	}
	if (onDelta) {
		onDelta(reply);
	}
	return { sessionId, reply };
}

export async function chatTurn(
	baseUrl: string,
	sessionId: string,
	input: string,
	postJson: PostJsonFn,
	onDelta?: (chunk: string) => void,
): Promise<ChatTurnResponse> {
	const url = `${trimBaseUrl(baseUrl)}/chat/turn`;
	const requestId = crypto.randomUUID();
	const res = await postJson(url, JSON.stringify({ sessionId, input }), { 'X-Request-Id': requestId });
	const text = await res.text();
	if (!res.ok) {
		throwHttpJsonError(res, text);
	}
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(text) as Record<string, unknown>;
	}
	catch {
		throw new Error('chat/turn: 响应非 JSON');
	}
	if (
		typeof data.sessionId !== 'string'
		|| typeof data.reply !== 'string'
		|| typeof data.status !== 'string'
	) {
		throw new TypeError('chat/turn: 缺少字段');
	}
	if (onDelta) {
		onDelta(data.reply as string);
	}
	return {
		sessionId: data.sessionId as string,
		status: data.status as ChatTurnResponse['status'],
		reply: data.reply as string,
		normalized: (data.normalized ?? null) as ChatTurnResponse['normalized'],
		missingFields: data.missingFields as string[] | undefined,
		errors: data.errors as string[] | undefined,
	};
}

export function isNormalizedConfig(v: unknown): v is PadExpandNormalized {
	if (!v || typeof v !== 'object') {
		return false;
	}
	const o = v as Record<string, unknown>;
	const kind = o.outputKind;
	if (kind !== 'forbidden_pour' && kind !== 'forbidden_fill' && kind !== 'solder_mask') {
		return false;
	}
	const exp = o.expMil;
	if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
		return false;
	}
	return typeof o.continuous === 'boolean';
}
