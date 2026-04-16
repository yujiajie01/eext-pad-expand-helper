/**
 * 与本地 pad-expand-agent-mvp（LangGraph）HTTP 服务通信。
 * 默认：http://127.0.0.1:8787
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

export async function chatStart(baseUrl: string): Promise<ChatStartResponse> {
	const url = `${trimBaseUrl(baseUrl)}/chat/start`;
	const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`chat/start ${res.status}${text ? `: ${text}` : ''}`);
	}
	const data = (await res.json()) as { sessionId?: string; reply?: string };
	if (!data.sessionId || typeof data.reply !== 'string') {
		throw new Error('chat/start: 响应缺少 sessionId 或 reply');
	}
	return { sessionId: data.sessionId, reply: data.reply };
}

export async function chatTurn(
	baseUrl: string,
	sessionId: string,
	input: string,
): Promise<ChatTurnResponse> {
	const url = `${trimBaseUrl(baseUrl)}/chat/turn`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId, input }),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`chat/turn ${res.status}${text ? `: ${text}` : ''}`);
	}
	const data = (await res.json()) as ChatTurnResponse;
	if (!data.sessionId || typeof data.reply !== 'string' || typeof data.status !== 'string') {
		throw new Error('chat/turn: 响应格式异常');
	}
	return data;
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
