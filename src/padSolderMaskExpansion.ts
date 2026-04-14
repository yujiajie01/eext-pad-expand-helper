/**
 * pad-expand-helper（焊盘外扩）：折线拟合几何；禁止区域或阻焊填充；PCB_Event 连续选中生成。
 */

import * as extensionConfig from '../extension.json';

const LAYER_TOP = EPCB_LayerId.TOP;
const LAYER_BOTTOM = EPCB_LayerId.BOTTOM;
const LAYER_MULTI = EPCB_LayerId.MULTI;
const LAYER_TOP_SOLDER_MASK = EPCB_LayerId.TOP_SOLDER_MASK;
const LAYER_BOTTOM_SOLDER_MASK = EPCB_LayerId.BOTTOM_SOLDER_MASK;

const PAD_SHAPE_ELLIPSE = EPCB_PrimitivePadShapeType.ELLIPSE;
const PAD_SHAPE_OVAL = EPCB_PrimitivePadShapeType.OBLONG;
const PAD_SHAPE_RECT = EPCB_PrimitivePadShapeType.RECTANGLE;
const PAD_SHAPE_NGON = EPCB_PrimitivePadShapeType.REGULAR_POLYGON;
const PAD_SHAPE_POLYGON = EPCB_PrimitivePadShapeType.POLYLINE_COMPLEX_POLYGON;

const FILL_SOLID = EPCB_PrimitiveFillMode.SOLID;
const MAX_EXP_MIL = 2000;
/** 与 iframe/index.html 中 IFRAME_ID、sessionStorage 键保持一致；多窗口须唯一 id，见内联框架说明 */
const IFRAME_SETUP_ID = 'pad-sm-guard-setup';
const IFRAME_SETUP_STORAGE_KEY = 'pad-expand-helper:iframe-setup';
/** 与 iframe 同步：宿主是否处于连续点选监听（Esc/停止后回写 false，iframe 轮询复位「停止生成」按钮） */
const IFRAME_LISTENING_ECHO_KEY = 'pad-expand-helper:listening-echo';
const IFRAME_SESSION_POLL_MS = 120;
/** 与文档一致：URI 自扩展根起，可用 `iframe/...` 或 `/iframe/...` */
const IFRAME_HTML_PATH_PRIMARY = 'iframe/index.html';
const IFRAME_HTML_PATH_ALT = '/iframe/index.html';
/** 内联设置窗高度（px）。须与 `iframe/index.html` 实际内容高度接近；过大则底部大块留白，过小易出纵向滚动条。 */
const IFRAME_SETUP_HEIGHT_PX = 575;
const IFRAME_WAIT_MAX_MS = 600_000;
/**
 * 内联设置页详细吐司（openIFrame / 存储 / 解析）。默认关；排障时改 true。
 * 内联 API 为 BETA，见：https://prodocs.lceda.cn/cn/api/reference/pro-api.sys_iframe.openiframe.html
 */
const PAD_IFRAME_SETUP_VERBOSE = false;
const ELLIPSE_POLYLINE_SEGMENTS = 48;
const SELECT_DEBOUNCE_MS = 120;
/** Toast 自动关闭：`showToastMessage` 第 3 参为秒数，`0` 为不自动关闭（勿误传毫秒） */
const TOAST_AUTO_CLOSE_SEC = 6;
/** 开发调试开关：开发排障时设为 true。 */
const PAD_EXP_DEBUG = false;
const PAD_EXP_DEBUG_TOAST_INTERVAL_MS = 800;

const MOUSE_LISTENER_ID = `${extensionConfig.uuid}-pad-exp-mouse`;

export type PadExpansionOutputKind = 'forbidden_pour' | 'forbidden_fill' | 'solder_mask';

export interface PadExpansionSettings {
	outputKind: PadExpansionOutputKind;
	expMil: number;
}

let activeInteractiveSettings: PadExpansionSettings | undefined;
let selectionDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let interactiveProcessing = false;
let pendingInteractiveSelection = false;
/** 处理中再次触发选中时保留最近一次事件的 props，供 finally 重试（勿无参 schedule，否则会丢框选/点选信息） */
let pendingInteractiveMouseProps: PcbMouseSelectProp[] | undefined;

let interactiveKeydownHandler: ((e: Event) => void) | undefined;
let interactiveContextMenuHandler: ((e: Event) => void) | undefined;
const recentPadParentIdByPadId = new Map<string, string>();
/** 内联会话内是否已注册 PCB 鼠标监听（连续模式重复「生成」仅更新参数时不重复注册） */
let padExpIframeListeningRegistered = false;
/** 当前内联会话内已连续模式提示吐司是否已出现过一次（避免停止后再生成重复刷屏） */
let padExpIframeSessionContinuousHintShown = false;

type GlobalEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

function getGlobalEventTarget(): GlobalEventTarget | undefined {
	if (typeof globalThis !== 'undefined' && 'addEventListener' in globalThis) {
		return globalThis as unknown as GlobalEventTarget;
	}
	return undefined;
}

function padExpDebugLog(message: string, payload?: unknown): void {
	if (!PAD_EXP_DEBUG) {
		return;
	}
	const writeConsole = (line: string): void => {
		console.warn(line);
		console.error(line);
	};
	const writeEdaLog = (line: string): void => {
		try {
			const logObj = (eda as unknown as { sys_Log?: Record<string, unknown> }).sys_Log;
			if (!logObj) {
				return;
			}
			// 文档只描述“添加日志条目”，不同宿主版本方法名可能不同，这里做兼容探测。
			const candidates = ['addLogLine', 'addLog', 'appendLog', 'pushLog', 'log'];
			for (const key of candidates) {
				const fn = logObj[key];
				if (typeof fn === 'function') {
					try {
						(fn as (arg0: string) => unknown).call(logObj, line);
						return;
					}
					catch {
						// 尝试下一种签名
					}
					try {
						(fn as (arg0: ESYS_LogType, arg1: string) => unknown).call(logObj, ESYS_LogType.INFO, line);
						return;
					}
					catch {
						// 尝试下一种签名
					}
				}
			}
		}
		catch {
			// ignore
		}
	};
	if (payload === undefined) {
		const line = `[pad-expand-helper·dbg] ${message}`;
		writeConsole(line);
		writeEdaLog(line);
		return;
	}
	let text: string;
	try {
		text = JSON.stringify(payload);
	}
	catch {
		text = String(payload);
	}
	const line = `[pad-expand-helper·dbg] ${message}: ${text}`;
	writeConsole(line);
	writeEdaLog(line);
}

let lastDebugToastAt = 0;
let debugToastSeq = 0;
function padExpDebugToast(message: string): void {
	if (!PAD_EXP_DEBUG) {
		return;
	}
	const now = Date.now();
	if (now - lastDebugToastAt < PAD_EXP_DEBUG_TOAST_INTERVAL_MS) {
		return;
	}
	lastDebugToastAt = now;
	debugToastSeq += 1;
	eda.sys_Message.showToastMessage(`[pad-expand-helper·dbg ${debugToastSeq}] ${message}`, ESYS_ToastMessageType.INFO, 2);
}

function padExpDebugToastForce(message: string): void {
	if (!PAD_EXP_DEBUG) {
		return;
	}
	debugToastSeq += 1;
	eda.sys_Message.showToastMessage(`[pad-expand-helper·dbg ${debugToastSeq}] ${message}`, ESYS_ToastMessageType.INFO, 3);
}

function sleepMs(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** 内联设置流程专用：与 PAD_EXP_DEBUG 独立，便于宿主环境排障。 */
function toastIframeSetupVerbose(message: string): void {
	if (!PAD_IFRAME_SETUP_VERBOSE) {
		return;
	}
	const text = `[pad-expand-helper·setup] ${message}`;
	eda.sys_Message.showToastMessage(text.length > 900 ? `${text.slice(0, 897)}…` : text, ESYS_ToastMessageType.INFO, 8);
}

function clearIframeSetupPayload(): void {
	try {
		if (typeof sessionStorage !== 'undefined') {
			sessionStorage.removeItem(IFRAME_SETUP_STORAGE_KEY);
		}
	}
	catch {
		// ignore
	}
	try {
		eda.sys_Storage.deleteExtensionUserConfig(IFRAME_SETUP_STORAGE_KEY);
	}
	catch {
		// ignore
	}
}

/**
 * iframe 与扩展主逻辑可能分属不同 JS 上下文，sessionStorage 不一定共享；
 * 优先读扩展用户配置（与 iframe 内双写对齐）。
 */
function readIframeSetupPayloadRaw(): string | null {
	try {
		const v = eda.sys_Storage.getExtensionUserConfig(IFRAME_SETUP_STORAGE_KEY);
		if (v !== undefined && v !== null) {
			if (typeof v === 'string') {
				return v.length > 0 ? v : null;
			}
			return JSON.stringify(v);
		}
	}
	catch {
		// ignore
	}
	try {
		if (typeof sessionStorage !== 'undefined') {
			const s = sessionStorage.getItem(IFRAME_SETUP_STORAGE_KEY);
			return s !== null && s !== '' ? s : null;
		}
	}
	catch {
		// ignore
	}
	return null;
}

function writeListeningEcho(listening: boolean): void {
	const payload = JSON.stringify({ listening, t: Date.now() });
	try {
		void eda.sys_Storage.setExtensionUserConfig(IFRAME_LISTENING_ECHO_KEY, payload);
	}
	catch {
		// ignore
	}
	try {
		if (typeof sessionStorage !== 'undefined') {
			sessionStorage.setItem(IFRAME_LISTENING_ECHO_KEY, payload);
		}
	}
	catch {
		// ignore
	}
}

function showDebugEnabledToast(): void {
	if (!PAD_EXP_DEBUG) {
		return;
	}
	debugToastSeq = 0;
	lastDebugToastAt = 0;
	eda.sys_Message.showToastMessage('[pad-expand-helper·dbg] Debug logging enabled', ESYS_ToastMessageType.INFO, 3);
}

/** 吐司：约 20s 自动关闭（timer 为秒）。勿传「关闭」按钮与空回调：空字符串会导致按钮无效。 */
function showPadExpToast(
	message: string,
	messageType: ESYS_ToastMessageType,
	_t?: (k: string, ...a: string[]) => string,
): void {
	eda.sys_Message.showToastMessage(message, messageType, TOAST_AUTO_CLOSE_SEC);
}

function unregisterInteractiveExitListeners(): void {
	const g = getGlobalEventTarget();
	if (!g) {
		return;
	}
	if (interactiveKeydownHandler) {
		g.removeEventListener('keydown', interactiveKeydownHandler, true);
		interactiveKeydownHandler = undefined;
	}
	if (interactiveContextMenuHandler) {
		g.removeEventListener('contextmenu', interactiveContextMenuHandler, true);
		interactiveContextMenuHandler = undefined;
	}
}

function registerInteractiveExitListeners(t: (k: string, ...a: string[]) => string): void {
	unregisterInteractiveExitListeners();
	const g = getGlobalEventTarget();
	if (!g) {
		return;
	}
	interactiveKeydownHandler = (e: Event) => {
		if (!activeInteractiveSettings) {
			return;
		}
		const ke = e as KeyboardEvent;
		if (ke.key !== 'Escape') {
			return;
		}
		ke.preventDefault();
		ke.stopPropagation();
		exitInteractiveModeWithNotify(t, 'esc');
	};
	interactiveContextMenuHandler = (e: Event) => {
		if (!activeInteractiveSettings) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		exitInteractiveModeWithNotify(t, 'contextmenu');
	};
	g.addEventListener('keydown', interactiveKeydownHandler, true);
	g.addEventListener('contextmenu', interactiveContextMenuHandler, true);
}

function exitInteractiveModeWithNotify(t: (k: string, ...a: string[]) => string, reason: 'esc' | 'contextmenu'): void {
	if (!activeInteractiveSettings) {
		return;
	}
	stopInteractiveMode();
	const key = reason === 'esc' ? 'SolderMaskExpExitEsc' : 'SolderMaskExpExitRightClick';
	showPadExpToast(t(key), ESYS_ToastMessageType.INFO, t);
}

/** {@link PCB_Event.addMouseEventListener} 回调中 props 的单项形状 */
interface PcbMouseSelectProp {
	primitiveId: string;
	primitiveType: EPCB_PrimitiveType;
	net?: string;
	designator?: string;
	parentComponentPrimitiveId?: string;
	parentComponentDesignator?: string;
}

function normalizeMouseProps(raw: unknown): PcbMouseSelectProp[] | undefined {
	if (raw == null) {
		return undefined;
	}
	if (Array.isArray(raw)) {
		if (raw.length === 0) {
			return undefined;
		}
		const first = raw[0];
		// 部分宿主将 props 传为 [[{ id }, …]] 嵌套数组
		if (Array.isArray(first)) {
			return first.length > 0 ? (first as PcbMouseSelectProp[]) : undefined;
		}
		return raw as PcbMouseSelectProp[];
	}
	if (typeof raw === 'object' && 'primitiveId' in raw) {
		return [raw as PcbMouseSelectProp];
	}
	return undefined;
}

function rememberPadParentFromMouseProps(mouseProps?: PcbMouseSelectProp[]): void {
	if (!mouseProps?.length) {
		return;
	}
	for (const p of mouseProps) {
		if (!p?.primitiveId || !p.parentComponentPrimitiveId) {
			continue;
		}
		if (p.primitiveType !== EPCB_PrimitiveType.PAD && p.primitiveType !== EPCB_PrimitiveType.COMPONENT_PAD) {
			continue;
		}
		recentPadParentIdByPadId.set(p.primitiveId, p.parentComponentPrimitiveId);
	}
}

/**
 * 选中列表：先等一帧再读（弹窗关闭后选中状态可能尚未同步）；若仍为空则用事件携带的 primitiveId 拉取图元（部分环境下仅 SELECTED 监听不可靠）。
 */
async function resolveSelectedPrimitives(mouseProps?: PcbMouseSelectProp[]): Promise<IPCB_Primitive[]> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	let list = await eda.pcb_SelectControl.getAllSelectedPrimitives();
	if (list.length === 0 && mouseProps?.length) {
		// 点选后选中列表可能晚于鼠标事件，再延迟一帧拉取
		await new Promise<void>(resolve => setTimeout(resolve, 120));
		list = await eda.pcb_SelectControl.getAllSelectedPrimitives();
	}
	if (list.length > 0) {
		return list;
	}
	if (mouseProps?.length) {
		const ids = [...new Set(mouseProps.map(p => p.primitiveId))];
		try {
			const got = await eda.pcb_Primitive.getPrimitivesByPrimitiveId(ids);
			return got.filter((p): p is IPCB_Primitive => p != null);
		}
		catch {
			return [];
		}
	}
	return [];
}

type PadPrimitive = IPCB_PrimitivePad | IPCB_PrimitiveComponentPad;
type PadShape = TPCB_PrimitivePadShape;
/** 解析几何焊盘形状（ELLIPSE/OBLONG/REGULAR_POLYGON/RECTANGLE），不含 POLYGON */
type AnalyticPadShape = Exclude<PadShape, [EPCB_PrimitivePadShapeType.POLYLINE_COMPLEX_POLYGON, unknown]>;
type SpecialPad = TPCB_PrimitiveSpecialPadShape;
type PolygonSource = TPCB_PolygonSourceArray;
type PolyData = Extract<PadShape, [typeof PAD_SHAPE_POLYGON, unknown]>[1];
type FillLayer = Parameters<typeof eda.pcb_PrimitiveFill.create>[0];
type FillPolygon = IPCB_Polygon | IPCB_ComplexPolygon;

const VALID_OUTPUT_KINDS = new Set<PadExpansionOutputKind>(['forbidden_pour', 'forbidden_fill', 'solder_mask']);

function isPadExpansionOutputKind(v: string): v is PadExpansionOutputKind {
	return VALID_OUTPUT_KINDS.has(v as PadExpansionOutputKind);
}

function padLabel(pad: PadPrimitive): string {
	return pad.getState_PadNumber() ?? '?';
}

function normalizeRotationDeg(deg: number): number {
	const n = deg % 360;
	return n < 0 ? n + 360 : n;
}

function rotationApiToDeg(raw: number): number {
	// 兼容宿主返回的非常规角度值：
	// 常规应为度数；若数值异常大（如 3953），实测按 raw * PI / 180 可还原真实度数（约 69°）。
	if (!Number.isFinite(raw)) {
		return 0;
	}
	if (Math.abs(raw) > 720) {
		return (raw * Math.PI) / 180;
	}
	return raw;
}

function angleDistanceDeg(a: number, b: number): number {
	const d = Math.abs(normalizeRotationDeg(a) - normalizeRotationDeg(b));
	return Math.min(d, 360 - d);
}

function solveOvalRotationForRMode(
	w: number,
	h: number,
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
	rawRot: number,
): number | undefined {
	const bw = bbox.maxX - bbox.minX;
	const bh = bbox.maxY - bbox.minY;
	const L = Math.max(w, h);
	const W = Math.min(w, h);
	const d = L - W;
	if (!(L > 0 && W > 0) || d < 1e-6) {
		return undefined;
	}
	const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
	const c = clamp01((bw - W) / d);
	const s = clamp01((bh - W) / d);
	const phi = (Math.atan2(s, c) * 180) / Math.PI; // 主轴与 X 轴夹角（0~90）
	const majorAngles = [phi, 180 - phi, 180 + phi, 360 - phi];
	const rCandidates = (h >= w)
		? majorAngles.map(ma => normalizeRotationDeg(90 - ma))
		: majorAngles.map(ma => normalizeRotationDeg(ma));
	let best = rCandidates[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const c0 of rCandidates) {
		const dist = angleDistanceDeg(c0, rawRot);
		if (dist < bestDist) {
			bestDist = dist;
			best = c0;
		}
	}
	return best;
}

function tryCallNumberMethod(target: unknown, methodNames: string[]): { value?: number; method?: string } {
	if (!target || typeof target !== 'object') {
		return {};
	}
	for (const name of methodNames) {
		const fn = (target as Record<string, unknown>)[name];
		if (typeof fn !== 'function') {
			continue;
		}
		try {
			const v = Number((fn as () => unknown).call(target));
			if (Number.isFinite(v)) {
				return { value: v, method: name };
			}
		}
		catch {
			// ignore
		}
	}
	return {};
}

function tryCallStringMethod(target: unknown, methodNames: string[]): { value?: string; method?: string } {
	if (!target || typeof target !== 'object') {
		return {};
	}
	for (const name of methodNames) {
		const fn = (target as Record<string, unknown>)[name];
		if (typeof fn !== 'function') {
			continue;
		}
		try {
			const raw = (fn as () => unknown).call(target);
			if (typeof raw === 'string' && raw.length > 0) {
				return { value: raw, method: name };
			}
		}
		catch {
			// ignore
		}
	}
	return {};
}

function checkPcbDocumentActive(): Promise<boolean> {
	return eda.dmt_SelectControl.getCurrentDocumentInfo()
		.then((doc) => {
			const t = doc?.documentType;
			return t === EDMT_EditorDocumentType.PCB || t === EDMT_EditorDocumentType.FOOTPRINT;
		})
		.catch(() => false);
}

function isPadPrimitive(p: IPCB_Primitive): p is PadPrimitive {
	const t = p.getState_PrimitiveType();
	return t === EPCB_PrimitiveType.PAD || t === EPCB_PrimitiveType.COMPONENT_PAD;
}

function isComponentPrimitive(p: IPCB_Primitive): p is IPCB_PrimitiveComponent {
	return p.getState_PrimitiveType() === EPCB_PrimitiveType.COMPONENT;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function convertInputToMil(raw: string, unit: Awaited<ReturnType<typeof eda.sys_Unit.getFrontendDataUnit>>): number | null {
	const n = Number.parseFloat(String(raw).trim().replace(/,/g, ''));
	if (!Number.isFinite(n) || n < 0) {
		return null;
	}
	const u = unit ?? 'mm';
	const sys = eda.sys_Unit;
	if (u === 'mm') {
		return sys.mmToMil(n, 6);
	}
	if (u === 'mil') {
		return n;
	}
	if (u === 'inch' || u === 'in') {
		return sys.inchToMil(n, 6);
	}
	if (u === 'cm') {
		return sys.mmToMil(n * 10, 6);
	}
	if (u === 'dm') {
		return sys.mmToMil(n * 100, 6);
	}
	if (u === 'm') {
		return sys.mmToMil(n * 1000, 6);
	}
	return sys.mmToMil(n, 6);
}

function unitHint(unit: Awaited<ReturnType<typeof eda.sys_Unit.getFrontendDataUnit>>): string {
	const u = unit ?? 'mm';
	const map: Record<string, string> = { mm: 'mm', mil: 'mil', inch: 'inch', in: 'in', cm: 'cm', dm: 'dm', m: 'm' };
	return map[u as string] ?? String(u);
}

function defaultExpansionInputByUnit(unit: Awaited<ReturnType<typeof eda.sys_Unit.getFrontendDataUnit>>): string {
	return unit === 'mm' ? '0.1' : '10';
}

function rangeCoversOuterLayer(startLayer: number, endLayer: number, outer: number): boolean {
	const lo = Math.min(startLayer, endLayer);
	const hi = Math.max(startLayer, endLayer);
	return lo <= outer && hi >= outer;
}

function solderMaskTargetsForPad(layer: TPCB_LayersOfPad, specialPad: SpecialPad | undefined): Set<FillLayer> {
	const layers = new Set<FillLayer>();
	if (specialPad?.length) {
		for (const [a, b] of specialPad) {
			if (rangeCoversOuterLayer(a, b, LAYER_TOP)) {
				layers.add(LAYER_TOP_SOLDER_MASK);
			}
			if (rangeCoversOuterLayer(a, b, LAYER_BOTTOM)) {
				layers.add(LAYER_BOTTOM_SOLDER_MASK);
			}
		}
		return layers;
	}
	if (layer === LAYER_TOP) {
		layers.add(LAYER_TOP_SOLDER_MASK);
	}
	else if (layer === LAYER_BOTTOM) {
		layers.add(LAYER_BOTTOM_SOLDER_MASK);
	}
	else if (layer === LAYER_MULTI) {
		layers.add(LAYER_TOP_SOLDER_MASK);
		layers.add(LAYER_BOTTOM_SOLDER_MASK);
	}
	return layers;
}

function bboxToExpandedRectSource(
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
	expMil: number,
): PolygonSource {
	const w = bbox.maxX - bbox.minX + 2 * expMil;
	const h = bbox.maxY - bbox.minY + 2 * expMil;
	return ['R', bbox.minX - expMil, bbox.maxY + expMil, w, h, 0, 0];
}

function bboxToRectContourSource(
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
	expMil: number,
	clockwise: boolean,
): PolygonSource {
	const left = bbox.minX - expMil;
	const right = bbox.maxX + expMil;
	const top = bbox.maxY + expMil;
	const bottom = bbox.minY - expMil;
	if (clockwise) {
		return [left, top, 'L', right, top, right, bottom, left, bottom];
	}
	return [left, top, 'L', left, bottom, right, bottom, right, top];
}

function rectContourToRectSource(source: PolygonSource): PolygonSource | undefined {
	if (
		source.length !== 9
		|| source[2] !== 'L'
		|| typeof source[0] !== 'number'
		|| typeof source[1] !== 'number'
		|| typeof source[3] !== 'number'
		|| typeof source[4] !== 'number'
		|| typeof source[5] !== 'number'
		|| typeof source[6] !== 'number'
		|| typeof source[7] !== 'number'
		|| typeof source[8] !== 'number'
	) {
		return undefined;
	}
	const xs = [source[0], source[3], source[5], source[7]];
	const ys = [source[1], source[4], source[6], source[8]];
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	return ['R', minX, maxY, maxX - minX, maxY - minY, 0, 0];
}

/** 半径 r、顶点数 n 的闭合折线（正多边形、椭圆采样等；圆焊盘优先用 {@link circlePolygonSource}） */
function closedRadialPolyline(cx: number, cy: number, r: number, vertexCount: number, clockwise: boolean): PolygonSource {
	const n = Math.max(3, Math.floor(vertexCount));
	const pts: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / n;
		const a = clockwise ? -t * 2 * Math.PI : t * 2 * Math.PI;
		pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
	}
	return [pts[0], pts[1], 'L', ...pts.slice(2)] as PolygonSource;
}

/** 原生 CIRCLE 多边形源（TPCB_PolygonSourceArray：`CIRCLE cx cy radius`），比 L 折线圆更易通过填充/布尔校验 */
function circlePolygonSource(cx: number, cy: number, r: number): PolygonSource {
	return ['CIRCLE', cx, cy, r] as PolygonSource;
}

/**
 * `R` 模式首两点为未旋转时的左上角；旋转角作用在左上角锚点上。
 * Y 向上、中心在 (cx,cy) 时：中心 = 左上 + (w/2, -h/2)，故带旋转时左上角 = 中心 − R(θ)(w/2, -h/2)。
 * rotDeg=0 时退化为 (cx - w/2, cy + h/2)，与现有矩形焊盘写法一致。
 */
function rectTopLeftFromCenter(cx: number, cy: number, w: number, h: number, rotDeg: number): { x: number; y: number } {
	const rad = (rotDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const dx = w / 2;
	const dy = -h / 2;
	const rx = dx * cos - dy * sin;
	const ry = dx * sin + dy * cos;
	return { x: cx - rx, y: cy - ry };
}

/**
 * 跑道形（OBLONG）多边形源：使用官方 `R` 圆角矩形，`round = min(w,h)/2` 时即为胶囊（两端半圆+直边），
 * 与 L 折线逼近相比更易被 pcb_PrimitiveFill 接受（与圆焊盘用 CIRCLE 同理）。
 */
function stadiumPolygonSource(cx: number, cy: number, rotDeg: number, w: number, h: number): PolygonSource {
	if (Math.abs(w - h) < 1e-6) {
		return circlePolygonSource(cx, cy, Math.max(w, h) / 2);
	}
	const round = Math.min(w, h) / 2;
	const tl = rectTopLeftFromCenter(cx, cy, w, h, rotDeg);
	return ['R', tl.x, tl.y, w, h, rotDeg, round] as PolygonSource;
}

/** 椭圆闭合折线（半轴 rx, ry；均匀外扩近似为半轴各 +exp） */
function closedEllipsePolygonSource(
	cx: number,
	cy: number,
	rx: number,
	ry: number,
	rotDeg: number,
	segments: number,
	clockwise: boolean,
): PolygonSource {
	const n = Math.max(8, Math.floor(segments));
	const rad = (rotDeg * Math.PI) / 180;
	const cosR = Math.cos(rad);
	const sinR = Math.sin(rad);
	const flat: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / n;
		const a = clockwise ? -t * 2 * Math.PI : t * 2 * Math.PI;
		const lx = rx * Math.cos(a);
		const ly = ry * Math.sin(a);
		flat.push(cx + lx * cosR - ly * sinR, cy + lx * sinR + ly * cosR);
	}
	return [flat[0], flat[1], 'L', ...flat.slice(2)] as PolygonSource;
}

function normalizeComplexPolygonSource(data: PolyData): PolygonSource[] | undefined {
	const complex = eda.pcb_MathPolygon.createComplexPolygon(data);
	if (!complex) {
		return undefined;
	}
	if ('getSourceStrictComplex' in complex && typeof complex.getSourceStrictComplex === 'function') {
		const strict = complex.getSourceStrictComplex();
		if (Array.isArray(strict) && strict.length > 0) {
			// 兼容宿主返回：
			// 1) PolygonSource[]（多轮廓）
			// 2) PolygonSource（单轮廓，扁平数组）
			if (Array.isArray(strict[0])) {
				return strict as PolygonSource[];
			}
			return [strict as unknown as PolygonSource];
		}
	}
	if ('getSource' in complex && typeof complex.getSource === 'function') {
		const src = complex.getSource();
		if (Array.isArray(src) && src.length > 0) {
			if (Array.isArray(src[0])) {
				return src as PolygonSource[];
			}
			return [src as unknown as PolygonSource];
		}
	}
	return undefined;
}

function isSinglePolygonSourceData(data: PolyData): boolean {
	return Array.isArray(data) && data.length > 0 && !Array.isArray(data[0]);
}

function normalizeSinglePolygonSource(data: PolyData): PolygonSource | undefined {
	if (!isSinglePolygonSourceData(data)) {
		return undefined;
	}
	return toStrictSingleContourSource(data as unknown as PolygonSource) ?? (data as unknown as PolygonSource);
}

function getPolygonSourceFirstPoint(source: PolygonSource): { x: number; y: number } | undefined {
	if (source.length < 2) {
		return undefined;
	}
	if (typeof source[0] === 'number' && typeof source[1] === 'number') {
		return { x: source[0], y: source[1] };
	}
	if (source[0] === 'L' && typeof source[1] === 'number' && typeof source[2] === 'number') {
		return { x: source[1], y: source[2] };
	}
	if (source[0] === 'R' && typeof source[1] === 'number' && typeof source[2] === 'number'
		&& typeof source[3] === 'number' && typeof source[4] === 'number') {
		return { x: source[1] + source[3] / 2, y: source[2] - source[4] / 2 };
	}
	if (source[0] === 'CIRCLE' && typeof source[1] === 'number' && typeof source[2] === 'number') {
		return { x: source[1], y: source[2] };
	}
	return undefined;
}

function getPolygonSourceSamplePoints(source: PolygonSource): Array<{ x: number; y: number }> {
	const pts: Array<{ x: number; y: number }> = [];
	if (source.length === 0) {
		return pts;
	}
	if (source[0] === 'R'
		&& typeof source[1] === 'number'
		&& typeof source[2] === 'number'
		&& typeof source[3] === 'number'
		&& typeof source[4] === 'number') {
		const x = source[1];
		const y = source[2];
		const w = source[3];
		const h = source[4];
		pts.push({ x, y }, { x: x + w, y }, { x: x + w, y: y - h }, { x, y: y - h });
		return pts;
	}
	if (source[0] === 'CIRCLE'
		&& typeof source[1] === 'number'
		&& typeof source[2] === 'number'
		&& typeof source[3] === 'number') {
		const cx = source[1];
		const cy = source[2];
		const r = source[3];
		pts.push({ x: cx + r, y: cy }, { x: cx, y: cy + r }, { x: cx - r, y: cy }, { x: cx, y: cy - r });
		return pts;
	}
	let i = source[0] === 'L' ? 1 : 0;
	while (i + 1 < source.length) {
		const x = source[i];
		const y = source[i + 1];
		if (typeof x === 'number' && typeof y === 'number') {
			pts.push({ x, y });
			i += 2;
			continue;
		}
		i += 1;
	}
	return pts;
}

function getPolygonSourceBBox(source: PolygonSource): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
	const pts = getPolygonSourceSamplePoints(source);
	if (pts.length === 0) {
		return undefined;
	}
	let minX = pts[0].x;
	let minY = pts[0].y;
	let maxX = pts[0].x;
	let maxY = pts[0].y;
	for (let i = 1; i < pts.length; i++) {
		minX = Math.min(minX, pts[i].x);
		minY = Math.min(minY, pts[i].y);
		maxX = Math.max(maxX, pts[i].x);
		maxY = Math.max(maxY, pts[i].y);
	}
	return { minX, minY, maxX, maxY };
}

function scalePolygonSourceAroundCenter(source: PolygonSource, growMil: number): PolygonSource | undefined {
	if (!(growMil > 0)) {
		return source;
	}
	const strict = toStrictSingleContourSource(source) ?? source;
	const bbox = getPolygonSourceBBox(strict);
	if (!bbox) {
		return undefined;
	}
	const w = bbox.maxX - bbox.minX;
	const h = bbox.maxY - bbox.minY;
	if (!(w > 1e-9 && h > 1e-9)) {
		return undefined;
	}
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	const sx = (w + 2 * growMil) / w;
	const sy = (h + 2 * growMil) / h;
	const out: PolygonSource = [];
	for (let i = 0; i < strict.length; i++) {
		const tk = strict[i];
		if (typeof tk === 'string') {
			if (tk !== 'L') {
				return undefined;
			}
			out.push('L');
			continue;
		}
		const x = tk;
		const y = strict[i + 1];
		if (typeof x !== 'number' || typeof y !== 'number') {
			return undefined;
		}
		out.push(cx + (x - cx) * sx, cy + (y - cy) * sy);
		i += 1;
	}
	return out;
}

async function debugPadPose(pad: PadPrimitive): Promise<void> {
	if (!PAD_EXP_DEBUG) {
		return;
	}
	const pid = pad.getState_PrimitiveId();
	const primitiveType = String(pad.getState_PrimitiveType());
	const padX = pad.getState_X();
	const padY = pad.getState_Y();
	const padRot = rotationApiToDeg(pad.getState_Rotation());
	let parentId: string | undefined;
	let parentPose: { x?: number; y?: number; rot?: number } | undefined;
	try {
		const parentIdInfo = tryCallStringMethod(
			pad,
			[
				'getState_ParentComponentPrimitiveId',
				'getState_ParentPrimitiveId',
				'getState_ComponentPrimitiveId',
				'getState_OwnerPrimitiveId',
			],
		);
		parentId = parentIdInfo.value;
		if (parentId) {
			const parent = (await eda.pcb_Primitive.getPrimitivesByPrimitiveId([parentId]))?.[0] as IPCB_PrimitiveComponent | undefined;
			if (parent) {
				parentPose = {
					x: tryCallNumberMethod(parent, ['getState_X']).value,
					y: tryCallNumberMethod(parent, ['getState_Y']).value,
					rot: rotationApiToDeg(tryCallNumberMethod(parent, ['getState_Rotation']).value ?? 0),
				};
			}
		}
	}
	catch {
		// ignore debug lookup errors
	}
	padExpDebugLog('pad-pose', { pid, primitiveType, padX, padY, padRot, parentId, parentPose });
	padExpDebugToast(`pad(${pid.slice(0, 6)}): x=${padX.toFixed(1)}, y=${padY.toFixed(1)}, r=${padRot.toFixed(1)}`);
}

function transformLocalPointToWorld(
	x: number,
	y: number,
	localCenter: { x: number; y: number },
	cx: number,
	cy: number,
	rotDeg: number,
	scale: number,
): { x: number; y: number } {
	const lx = (x - localCenter.x) * scale;
	const ly = (y - localCenter.y) * scale;
	const rad = (rotDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return {
		x: cx + lx * cos - ly * sin,
		y: cy + lx * sin + ly * cos,
	};
}

function transformPolygonSourceLMode(
	source: PolygonSource,
	localCenter: { x: number; y: number },
	cx: number,
	cy: number,
	rotDeg: number,
	scale: number,
): PolygonSource | undefined {
	if (source.length < 4) {
		return undefined;
	}
	// 兼容两种常见格式：
	// 1) x1 y1 L x2 y2 ...
	// 2) L x1 y1 x2 y2 ...
	let startIdx = 0;
	let withLeadingL = false;
	if (source[0] === 'L') {
		withLeadingL = true;
		startIdx = 1;
	}
	else if (source[2] !== 'L') {
		// 兜底：若全是数值，按点序列处理
		const allNum = source.every(v => typeof v === 'number');
		if (!allNum) {
			return undefined;
		}
	}
	const out: PolygonSource = [];
	if (withLeadingL) {
		out.push('L');
	}
	let idx = startIdx;
	let seenModeToken = withLeadingL;
	while (idx < source.length) {
		const tk = source[idx];
		if (typeof tk === 'string') {
			if (tk !== 'L') {
				return undefined;
			}
			if (!withLeadingL) {
				out.push('L');
			}
			seenModeToken = true;
			idx++;
			continue;
		}
		const x = source[idx];
		const y = source[idx + 1];
		if (typeof x !== 'number' || typeof y !== 'number') {
			return undefined;
		}
		const p = transformLocalPointToWorld(x, y, localCenter, cx, cy, rotDeg, scale);
		out.push(p.x, p.y);
		idx += 2;
	}
	if (!seenModeToken) {
		out.splice(2, 0, 'L');
	}
	return out.length >= 5 ? out : undefined;
}

function transformPolygonSourceRectMode(
	source: PolygonSource,
	localCenter: { x: number; y: number },
	cx: number,
	cy: number,
	rotDeg: number,
	scale: number,
): PolygonSource | undefined {
	if (
		source.length !== 7
		|| source[0] !== 'R'
		|| typeof source[1] !== 'number'
		|| typeof source[2] !== 'number'
		|| typeof source[3] !== 'number'
		|| typeof source[4] !== 'number'
		|| typeof source[5] !== 'number'
		|| typeof source[6] !== 'number'
	) {
		return undefined;
	}
	const x = source[1];
	const y = source[2];
	const w = source[3];
	const h = source[4];
	const rot = source[5];
	const round = source[6];
	const centerLocal = { x: x + w / 2, y: y - h / 2 };
	const centerWorld = transformLocalPointToWorld(centerLocal.x, centerLocal.y, localCenter, cx, cy, rotDeg, scale);
	const wOut = w * scale;
	const hOut = h * scale;
	const tl = rectTopLeftFromCenter(centerWorld.x, centerWorld.y, wOut, hOut, rot + rotDeg);
	return ['R', tl.x, tl.y, wOut, hOut, rot + rotDeg, round * scale] as PolygonSource;
}

function transformPolygonSourceCircleMode(
	source: PolygonSource,
	localCenter: { x: number; y: number },
	cx: number,
	cy: number,
	rotDeg: number,
	scale: number,
): PolygonSource | undefined {
	if (
		source.length !== 4
		|| source[0] !== 'CIRCLE'
		|| typeof source[1] !== 'number'
		|| typeof source[2] !== 'number'
		|| typeof source[3] !== 'number'
	) {
		return undefined;
	}
	const p = transformLocalPointToWorld(source[1], source[2], localCenter, cx, cy, rotDeg, scale);
	return ['CIRCLE', p.x, p.y, source[3] * scale] as PolygonSource;
}

function toStrictSingleContourSource(source: PolygonSource): PolygonSource | undefined {
	const poly = eda.pcb_MathPolygon.createPolygon(source);
	if (!poly) {
		return undefined;
	}
	if ('getSourceStrict' in poly && typeof (poly as IPCB_Polygon & { getSourceStrict?: () => unknown }).getSourceStrict === 'function') {
		const strict = (poly as IPCB_Polygon & { getSourceStrict: () => unknown }).getSourceStrict();
		if (Array.isArray(strict) && strict.length > 0 && !Array.isArray(strict[0])) {
			return strict as PolygonSource;
		}
	}
	const src = poly.getSource();
	if (Array.isArray(src) && src.length > 0 && !Array.isArray(src[0])) {
		return src as PolygonSource;
	}
	return undefined;
}

interface XYPoint {
	x: number;
	y: number;
}

function signedAreaOfPoints(points: XYPoint[]): number {
	if (points.length < 3) {
		return 0;
	}
	let area2 = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		area2 += a.x * b.y - b.x * a.y;
	}
	return area2 / 2;
}

function strictLSourceToClosedPoints(source: PolygonSource): XYPoint[] | undefined {
	if (source.length < 5) {
		return undefined;
	}
	const pts: XYPoint[] = [];
	let i = source[0] === 'L' ? 1 : 0;
	while (i + 1 < source.length) {
		const x = source[i];
		const y = source[i + 1];
		if (typeof x !== 'number' || typeof y !== 'number') {
			return undefined;
		}
		pts.push({ x, y });
		i += 2;
	}
	if (pts.length < 3) {
		return undefined;
	}
	const first = pts[0];
	const last = pts[pts.length - 1];
	if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-7) {
		pts.pop();
	}
	return pts.length >= 3 ? pts : undefined;
}

function closedPointsToLSource(points: XYPoint[]): PolygonSource | undefined {
	if (points.length < 3) {
		return undefined;
	}
	const out: PolygonSource = [points[0].x, points[0].y, 'L'];
	for (let i = 1; i < points.length; i++) {
		out.push(points[i].x, points[i].y);
	}
	return out;
}

function lineIntersection(
	p1: XYPoint,
	d1: XYPoint,
	p2: XYPoint,
	d2: XYPoint,
): XYPoint | undefined {
	const det = d1.x * d2.y - d1.y * d2.x;
	if (Math.abs(det) < 1e-12) {
		return undefined;
	}
	const qx = p2.x - p1.x;
	const qy = p2.y - p1.y;
	const t = (qx * d2.y - qy * d2.x) / det;
	return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

function normalizeVector(v: XYPoint): XYPoint | undefined {
	const len = Math.hypot(v.x, v.y);
	if (!(len > 1e-12)) {
		return undefined;
	}
	return { x: v.x / len, y: v.y / len };
}

function offsetClosedPolylinePoints(points: XYPoint[], offsetMil: number, flipNormal: boolean): XYPoint[] | undefined {
	const n = points.length;
	if (n < 3 || !(offsetMil > 0)) {
		return undefined;
	}
	const area = signedAreaOfPoints(points);
	if (Math.abs(area) < 1e-9) {
		return undefined;
	}
	const orient = area > 0 ? 1 : -1;
	const side = flipNormal ? -1 : 1;
	const vertices: XYPoint[] = [];
	const edgeDirs: XYPoint[] = Array.from({ length: n }, () => ({ x: 0, y: 0 }));
	const edgeNormals: XYPoint[] = Array.from({ length: n }, () => ({ x: 0, y: 0 }));
	for (let i = 0; i < n; i++) {
		const a = points[i];
		const b = points[(i + 1) % n];
		const dir = normalizeVector({ x: b.x - a.x, y: b.y - a.y });
		if (!dir) {
			return undefined;
		}
		edgeDirs[i] = dir;
		// y 轴向上坐标系：CCW 轮廓外法线为右法线；CW 外法线为左法线
		const outward = orient > 0
			? { x: dir.y, y: -dir.x }
			: { x: -dir.y, y: dir.x };
		edgeNormals[i] = {
			x: outward.x * side,
			y: outward.y * side,
		};
	}
	const maxMiter = Math.max(offsetMil * 8, offsetMil + 1e-6);
	for (let i = 0; i < n; i++) {
		const prev = (i - 1 + n) % n;
		const currPoint = points[i];
		const prevPoint = points[prev];
		const prevDir = edgeDirs[prev];
		const currDir = edgeDirs[i];
		const prevNormal = edgeNormals[prev];
		const currNormal = edgeNormals[i];
		const line1Point = {
			x: prevPoint.x + prevNormal.x * offsetMil,
			y: prevPoint.y + prevNormal.y * offsetMil,
		};
		const line2Point = {
			x: currPoint.x + currNormal.x * offsetMil,
			y: currPoint.y + currNormal.y * offsetMil,
		};
		let p = lineIntersection(line1Point, prevDir, line2Point, currDir);
		if (!p) {
			const merged = normalizeVector({
				x: prevNormal.x + currNormal.x,
				y: prevNormal.y + currNormal.y,
			});
			if (merged) {
				p = {
					x: currPoint.x + merged.x * offsetMil,
					y: currPoint.y + merged.y * offsetMil,
				};
			}
			else {
				p = {
					x: currPoint.x + currNormal.x * offsetMil,
					y: currPoint.y + currNormal.y * offsetMil,
				};
			}
		}
		const dx = p.x - currPoint.x;
		const dy = p.y - currPoint.y;
		const miterLen = Math.hypot(dx, dy);
		if (miterLen > maxMiter) {
			const dir = normalizeVector({ x: dx, y: dy });
			if (dir) {
				p = {
					x: currPoint.x + dir.x * maxMiter,
					y: currPoint.y + dir.y * maxMiter,
				};
			}
		}
		vertices.push(p);
	}
	// 去除极近重复顶点，避免宿主几何器崩溃
	const simplified: XYPoint[] = [];
	for (const pt of vertices) {
		const prev = simplified[simplified.length - 1];
		if (!prev || Math.hypot(prev.x - pt.x, prev.y - pt.y) > 1e-6) {
			simplified.push(pt);
		}
	}
	if (simplified.length >= 3 && Math.hypot(
		simplified[0].x - simplified[simplified.length - 1].x,
		simplified[0].y - simplified[simplified.length - 1].y,
	) <= 1e-6) {
		simplified.pop();
	}
	return simplified.length >= 3 ? simplified : undefined;
}

function offsetPolygonSourceFixedDistance(inner: PolygonSource, expMil: number): PolygonSource | undefined {
	if (!(expMil > 0)) {
		return inner;
	}
	const strict = toStrictSingleContourSource(inner) ?? inner;
	const points = strictLSourceToClosedPoints(strict);
	if (!points) {
		return undefined;
	}
	const candidates = [
		offsetClosedPolylinePoints(points, expMil, false),
		offsetClosedPolylinePoints(points, expMil, true),
	].filter((v): v is XYPoint[] => Array.isArray(v) && v.length >= 3);
	if (candidates.length === 0) {
		return undefined;
	}
	const innerArea = Math.abs(signedAreaOfPoints(points));
	let best = candidates[0];
	let bestGain = Math.abs(signedAreaOfPoints(best)) - innerArea;
	for (let i = 1; i < candidates.length; i++) {
		const gain = Math.abs(signedAreaOfPoints(candidates[i])) - innerArea;
		if (gain > bestGain) {
			bestGain = gain;
			best = candidates[i];
		}
	}
	return closedPointsToLSource(best);
}

function ensurePointsOrientation(points: XYPoint[], clockwise: boolean): XYPoint[] {
	const area = signedAreaOfPoints(points);
	const isCw = area < 0;
	if (clockwise === isCw) {
		return points;
	}
	return [...points].reverse();
}

function estimateSourceAreaAbsSimple(source: PolygonSource): number {
	const pts = strictLSourceToClosedPoints(source);
	if (!pts || pts.length < 3) {
		return 0;
	}
	return Math.abs(signedAreaOfPoints(pts));
}

function pickLargestPolygonSource(polys: IPCB_Polygon[]): PolygonSource | undefined {
	if (polys.length === 0) {
		return undefined;
	}
	let best: PolygonSource | undefined;
	let bestArea = -1;
	for (const p of polys) {
		const src = p.getSource() as PolygonSource;
		const strict = toStrictSingleContourSource(src) ?? src;
		const area = estimateSourceAreaAbsSimple(strict);
		if (area > bestArea) {
			bestArea = area;
			best = strict;
		}
	}
	return best;
}

function normalizeComplexSources(src: unknown): PolygonSource[] {
	if (!Array.isArray(src) || src.length === 0) {
		return [];
	}
	if (Array.isArray(src[0])) {
		return src as PolygonSource[];
	}
	return [src as PolygonSource];
}

/**
 * 对可能自交/退化的外轮廓做正规化：借助 ComplexPolygon 的 nonzero 规则消解异常段，
 * 然后取面积最大的单轮廓作为最终 outer。
 */
function normalizeOuterContourByComplex(outer: PolygonSource): PolygonSource | undefined {
	const strict = toStrictSingleContourSource(outer) ?? outer;
	const complex = eda.pcb_MathPolygon.createComplexPolygon(strict);
	if (!complex) {
		return strict;
	}
	let contourList: PolygonSource[] = [];
	if ('getSourceStrictComplex' in complex && typeof complex.getSourceStrictComplex === 'function') {
		contourList = normalizeComplexSources(complex.getSourceStrictComplex());
	}
	if (contourList.length === 0 && 'getSource' in complex && typeof complex.getSource === 'function') {
		contourList = normalizeComplexSources(complex.getSource());
	}
	if (contourList.length === 0) {
		return strict;
	}
	let best = contourList[0];
	let bestArea = estimateSourceAreaAbsSimple(toStrictSingleContourSource(best) ?? best);
	for (let i = 1; i < contourList.length; i++) {
		const cand = toStrictSingleContourSource(contourList[i]) ?? contourList[i];
		const area = estimateSourceAreaAbsSimple(cand);
		if (area > bestArea) {
			bestArea = area;
			best = cand;
		}
	}
	return toStrictSingleContourSource(best) ?? best;
}

/**
 * 稳定外扩：将「原轮廓 + 边条带 + 顶点圆盘」作为复杂多边形并集近似，
 * 再拆分并取最大外轮廓。对凹角比“顶点交点法”更稳健。
 */
function buildDilatedOuterByStrokeUnion(inner: PolygonSource, expMil: number): PolygonSource | undefined {
	if (!(expMil > 0)) {
		return inner;
	}
	const strict = toStrictSingleContourSource(inner) ?? inner;
	const ptsRaw = strictLSourceToClosedPoints(strict);
	if (!ptsRaw || ptsRaw.length < 3) {
		return undefined;
	}
	const clockwise = signedAreaOfPoints(ptsRaw) < 0;
	const pts = ensurePointsOrientation(ptsRaw, clockwise);
	const shapes: PolygonSource[] = [strict];
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % pts.length];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		if (!(len > 1e-6)) {
			continue;
		}
		const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
		// 边条带：沿边方向略加长，避免端点缝隙。
		const stripW = len + expMil * 2;
		const stripH = expMil * 2;
		const centerX = (a.x + b.x) / 2;
		const centerY = (a.y + b.y) / 2;
		const tl = rectTopLeftFromCenter(centerX, centerY, stripW, stripH, angle);
		shapes.push(['R', tl.x, tl.y, stripW, stripH, angle, 0] as PolygonSource);
		shapes.push(circlePolygonSource(a.x, a.y, expMil));
	}
	const complex = eda.pcb_MathPolygon.createComplexPolygon(shapes);
	if (!complex) {
		return undefined;
	}
	const split = eda.pcb_MathPolygon.splitPolygon(complex);
	if (!Array.isArray(split) || split.length === 0) {
		return undefined;
	}
	const largest = pickLargestPolygonSource(split);
	if (!largest) {
		return undefined;
	}
	const largestPts = strictLSourceToClosedPoints(largest);
	if (!largestPts) {
		return largest;
	}
	return closedPointsToLSource(ensurePointsOrientation(largestPts, clockwise));
}

function transformPolygonSourceToWorld(
	source: PolygonSource,
	localCenter: { x: number; y: number },
	cx: number,
	cy: number,
	rotDeg: number,
	scale: number,
): PolygonSource | undefined {
	if (source[0] === 'R') {
		return transformPolygonSourceRectMode(source, localCenter, cx, cy, rotDeg, scale);
	}
	if (source[0] === 'CIRCLE') {
		return transformPolygonSourceCircleMode(source, localCenter, cx, cy, rotDeg, scale);
	}
	const lMode = transformPolygonSourceLMode(source, localCenter, cx, cy, rotDeg, scale);
	if (lMode) {
		return lMode;
	}
	// 兼容 ARC/CARC/C 等模式：先转严格折线，再做世界坐标变换
	const strict = toStrictSingleContourSource(source);
	if (!strict) {
		return undefined;
	}
	return transformPolygonSourceLMode(strict, localCenter, cx, cy, rotDeg, scale);
}

function buildPolygonPadOuterInnerContours(
	data: PolyData,
	cx: number,
	cy: number,
	rotDeg: number,
	expMil: number,
): { outer: PolygonSource; inner: PolygonSource } | undefined {
	// case 1: 单多边形源（TPCB_PolygonSourceArray）
	let base: PolygonSource | undefined;
	let complex: IPCB_ComplexPolygon | undefined;
	if (isSinglePolygonSourceData(data)) {
		padExpDebugLog('polygon-case=single', { tokenCount: data.length });
		base = normalizeSinglePolygonSource(data);
		if (!base) {
			padExpDebugLog('single-normalize-failed');
			return undefined;
		}
		complex = eda.pcb_MathPolygon.createComplexPolygon(base);
	}
	// case 2: 复杂多边形源（Array<TPCB_PolygonSourceArray> / 等价 complex 数据）
	else {
		padExpDebugLog('polygon-case=complex');
		complex = eda.pcb_MathPolygon.createComplexPolygon(data);
		if (!complex) {
			padExpDebugLog('complex-create-failed');
			return undefined;
		}
		const contourList = normalizeComplexPolygonSource(data);
		if (!contourList?.length) {
			padExpDebugLog('complex-normalize-empty');
			return undefined;
		}
		base = contourList[0];
		padExpDebugLog('complex-contours', { count: contourList.length });
	}
	if (!complex || !base) {
		padExpDebugLog('polygon-base-or-complex-missing');
		return undefined;
	}
	const w = eda.pcb_MathPolygon.calculateWidth(complex);
	const h = eda.pcb_MathPolygon.calculateHeight(complex);
	if (!(w > 0 && h > 0)) {
		padExpDebugLog('polygon-size-invalid', { w, h });
		return undefined;
	}
	const localCenter = complex.getCenter();
	const baseFirst = getPolygonSourceFirstPoint(base);
	padExpDebugLog('polygon-base', { baseFirst, localCenter, cx, cy, rotDeg });
	if (baseFirst) {
		padExpDebugToast(`base=(${baseFirst.x.toFixed(1)},${baseFirst.y.toFixed(1)}), c=(${cx.toFixed(1)},${cy.toFixed(1)})`);
	}
	const scale = Math.max((w + 2 * expMil) / w, (h + 2 * expMil) / h);
	const sourceApproxCenter = (source: PolygonSource): { x: number; y: number } | undefined => {
		const pts = getPolygonSourceSamplePoints(source);
		if (pts.length === 0) {
			return undefined;
		}
		const sx = pts.reduce((s, p) => s + p.x, 0);
		const sy = pts.reduce((s, p) => s + p.y, 0);
		return { x: sx / pts.length, y: sy / pts.length };
	};
	const buildPair = (mode: 'world' | 'local'): { outer?: PolygonSource; inner?: PolygonSource; score: number } => {
		const outer = mode === 'world'
			? transformPolygonSourceToWorld(base, localCenter, localCenter.x, localCenter.y, 0, scale)
			: transformPolygonSourceToWorld(base, localCenter, cx, cy, rotDeg, scale);
		const inner = mode === 'world'
			? transformPolygonSourceToWorld(base, localCenter, localCenter.x, localCenter.y, 0, 1)
			: transformPolygonSourceToWorld(base, localCenter, cx, cy, rotDeg, 1);
		if (!outer || !inner) {
			return { score: Number.POSITIVE_INFINITY };
		}
		const c = sourceApproxCenter(outer);
		if (!c) {
			return { score: Number.POSITIVE_INFINITY };
		}
		const score = Math.hypot(c.x - cx, c.y - cy);
		return { outer, inner, score };
	};
	const worldPair = buildPair('world');
	const localPair = buildPair('local');
	const picked = worldPair.score <= localPair.score ? { mode: 'world', ...worldPair } : { mode: 'local', ...localPair };
	padExpDebugLog('polygon-space-select', { worldScore: worldPair.score, localScore: localPair.score, picked: picked.mode });
	padExpDebugToastForce(`space=${picked.mode}, ws=${worldPair.score.toFixed(1)}, ls=${localPair.score.toFixed(1)}`);
	const inner = picked.inner;
	if (!inner) {
		padExpDebugLog('polygon-transform-failed', { hasInner: Boolean(inner), scale });
		padExpDebugToastForce(`transform failed: scale=${scale.toFixed(4)}`);
		return undefined;
	}
	let outer = offsetPolygonSourceFixedDistance(inner, expMil);
	if (!outer) {
		outer = buildDilatedOuterByStrokeUnion(inner, expMil);
	}
	if (outer) {
		outer = normalizeOuterContourByComplex(outer) ?? outer;
	}
	if (!outer) {
		// 兜底：避免回退到旧的 picked.outer（历史缩放结果），否则会出现“改了算法但效果不变”。
		outer = scalePolygonSourceAroundCenter(inner, expMil);
	}
	if (!outer) {
		padExpDebugLog('polygon-offset-failed', { expMil, innerLen: inner.length });
		return undefined;
	}
	padExpDebugLog('polygon-transform-ok', { scale, outerLen: outer.length, innerLen: inner.length, offsetMode: 'fixed-distance' });
	const ob = getPolygonSourceBBox(outer);
	const ib = getPolygonSourceBBox(inner);
	if (ob && ib) {
		const gx = Math.min(ib.minX - ob.minX, ob.maxX - ib.maxX);
		const gy = Math.min(ib.minY - ob.minY, ob.maxY - ib.maxY);
		const minGrow = Math.min(gx, gy);
		padExpDebugLog('polygon-grow-check', { gx, gy, minGrow, expMil });
		// 仅当外扩显著错误（明显内缩/塌陷）时才回退，避免覆盖固定距离偏移结果。
		if (minGrow < -Math.max(0.1, expMil * 0.2)) {
			const shapeOuter = scalePolygonSourceAroundCenter(inner, expMil);
			if (shapeOuter) {
				padExpDebugToastForce(`grow fallback: shape-scale (${expMil})`);
				return { outer: shapeOuter, inner };
			}
		}
	}
	padExpDebugToastForce(`transform ok: scale=${scale.toFixed(4)}, len=${outer.length}/${inner.length}`);
	return { outer, inner };
}

function selectDimsByBboxFit(
	w: number,
	h: number,
	rotDeg: number,
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
): { w: number; h: number } {
	const bw = bbox.maxX - bbox.minX;
	const bh = bbox.maxY - bbox.minY;
	const rad = (rotDeg * Math.PI) / 180;
	const absCos = Math.abs(Math.cos(rad));
	const absSin = Math.abs(Math.sin(rad));
	const err = (dw: number, dh: number): number => {
		const pw = dw * absCos + dh * absSin;
		const ph = dw * absSin + dh * absCos;
		return Math.abs(pw - bw) + Math.abs(ph - bh);
	};
	return err(w, h) <= err(h, w) ? { w, h } : { w: h, h: w };
}

async function resolveExpansionRotationDeg(
	pad: PadPrimitive,
	_padShape: PadShape,
	_worldBBox: { minX: number; minY: number; maxX: number; maxY: number } | undefined,
): Promise<number> {
	const padRotRaw = tryCallNumberMethod(
		pad,
		[
			'getState_GlobalRotation',
			'getState_AbsoluteRotation',
			'getState_PadRotation',
			'getState_Rotation',
			'getState_Angle',
		],
	);
	const padRotApiRaw = padRotRaw.value ?? 0;
	const padRot = normalizeRotationDeg(rotationApiToDeg(padRotApiRaw));
	const primitiveType = pad.getState_PrimitiveType();
	// IPCB_PrimitivePad：直接使用 pad 自身旋转角
	if (primitiveType === EPCB_PrimitiveType.PAD) {
		if (_worldBBox && _padShape[0] === PAD_SHAPE_OVAL) {
			const w = typeof _padShape[1] === 'number' ? _padShape[1] : 0;
			const h = typeof _padShape[2] === 'number' ? _padShape[2] : 0;
			if (w > 0 && h > 0) {
				const solved = solveOvalRotationForRMode(w, h, _worldBBox, padRot);
				if (solved !== undefined) {
					return solved;
				}
			}
		}
		return padRot;
	}

	// IPCB_PrimitiveComponentPad：严格按 worldRot = padRot + componentRot
	let compRot: number | undefined;
	try {
		const parentIdInfo = tryCallStringMethod(
			pad,
			[
				'getState_ParentComponentPrimitiveId',
				'getState_ParentPrimitiveId',
				'getState_ComponentPrimitiveId',
				'getState_OwnerPrimitiveId',
			],
		);
		const parentId = parentIdInfo.value;
		const fallbackParentId = recentPadParentIdByPadId.get(pad.getState_PrimitiveId());
		const finalParentId = parentId || fallbackParentId;
		if (finalParentId) {
			const parent = (await eda.pcb_Primitive.getPrimitivesByPrimitiveId([finalParentId]))?.[0] as IPCB_PrimitiveComponent | undefined;
			const compRotRaw = tryCallNumberMethod(
				parent,
				[
					'getState_GlobalRotation',
					'getState_AbsoluteRotation',
					'getState_Rotation',
					'getState_Angle',
				],
			);
			if (Number.isFinite(compRotRaw.value)) {
				compRot = rotationApiToDeg(compRotRaw.value ?? 0);
			}
		}
	}
	catch {
		// ignore, fallback below
	}

	if (compRot === undefined || !Number.isFinite(compRot)) {
		return padRot;
	}

	const used = normalizeRotationDeg(padRot + compRot);
	return used;
}

function expandAnalyticShapeToPolylineSource(
	padShape: PadShape,
	cx: number,
	cy: number,
	rotDeg: number,
	expMil: number,
): PolygonSource | undefined {
	const e2 = expMil * 2;
	if (padShape[0] === PAD_SHAPE_ELLIPSE) {
		const w = padShape[1] + e2;
		const h = padShape[2] + e2;
		if (Math.abs(w - h) < 1e-6) {
			return circlePolygonSource(cx, cy, Math.max(w, h) / 2);
		}
		return closedEllipsePolygonSource(cx, cy, w / 2, h / 2, rotDeg, ELLIPSE_POLYLINE_SEGMENTS, true);
	}
	if (padShape[0] === PAD_SHAPE_OVAL) {
		const w = padShape[1] + e2;
		const h = padShape[2] + e2;
		return stadiumPolygonSource(cx, cy, rotDeg, w, h);
	}
	if (padShape[0] === PAD_SHAPE_RECT) {
		const w = padShape[1] + e2;
		const h = padShape[2] + e2;
		const tl = rectTopLeftFromCenter(cx, cy, w, h, rotDeg);
		return ['R', tl.x, tl.y, w, h, rotDeg, 0];
	}
	if (padShape[0] === PAD_SHAPE_NGON) {
		const diameter = padShape[1] + e2;
		const sides = Math.min(64, Math.max(3, typeof padShape[2] === 'number' ? padShape[2] : 6));
		return closedRadialPolyline(cx, cy, Math.max(diameter / 2, 0), sides, true);
	}
	return undefined;
}

/** 已用解析几何处理跑道/椭圆外扩，不再依赖整焊盘 AABB 矩形 */
function shapeNeedsWholePadBBox(_s: PadShape): boolean {
	return false;
}

/** 类型守卫：判断是否为圆形焊盘（ELLIPSE 且宽高相等），并收窄 shape 为解析几何类型 */
function isCirclePadShape(shape: PadShape): shape is AnalyticPadShape {
	if (shape[0] !== PAD_SHAPE_ELLIPSE) {
		return false;
	}
	// 对于 ELLIPSE，shape 是 [type, number, number]
	const w = shape[1] as number;
	const h = shape[2] as number;
	return Math.abs(w - h) < 1e-6;
}

async function getPadWorldBBox(pad: PadPrimitive): Promise<{ minX: number; minY: number; maxX: number; maxY: number } | undefined> {
	try {
		return (await eda.pcb_Primitive.getPrimitivesBBox([pad.getState_PrimitiveId()])) ?? undefined;
	}
	catch {
		return undefined;
	}
}

async function buildExpandedMaskSource(
	pad: PadPrimitive,
	padShape: PadShape,
	expMil: number,
	rotationDeg: number,
): Promise<PolygonSource | undefined> {
	const cx = pad.getState_X();
	const cy = pad.getState_Y();
	const rot = rotationDeg;
	if (padShape[0] === PAD_SHAPE_POLYGON) {
		const contour = buildPolygonPadOuterInnerContours((padShape as [typeof PAD_SHAPE_POLYGON, PolyData])[1], cx, cy, rot, expMil);
		return contour?.outer;
	}
	return expandAnalyticShapeToPolylineSource(padShape, cx, cy, rot, expMil);
}

function tryComplexRing(outer: PolygonSource, inner: PolygonSource, worldBBox: { minX: number; minY: number; maxX: number; maxY: number }, expMil: number): FillPolygon | undefined {
	const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
	if (ring) {
		return ring;
	}
	const outerOnly = eda.pcb_MathPolygon.createPolygon(bboxToExpandedRectSource(worldBBox, expMil));
	return outerOnly ?? undefined;
}

async function buildExpandedMaskPolygon(
	pad: PadPrimitive,
	padShape: PadShape,
	expMil: number,
	_useWholePadBBox: boolean,
	outputKind?: PadExpansionOutputKind,
): Promise<FillPolygon | undefined> {
	await debugPadPose(pad);
	const worldBBox = await getPadWorldBBox(pad);
	const cx = pad.getState_X();
	const cy = pad.getState_Y();
	const rot = await resolveExpansionRotationDeg(pad, padShape, worldBBox);
	padExpDebugLog('pad-bbox-and-rot', { cx, cy, rot, worldBBox, shapeType: padShape[0], expMil });
	padExpDebugToast(`shape=${String(padShape[0])}, rot=${rot.toFixed(2)}, exp=${expMil}`);
	const e2 = expMil * 2;

	// 圆焊盘：用焊盘中心与 padShape 直径（与 bbox 解耦，避免 bbox 与焊盘不一致时孔洞无效导致 create fill 失败）
	if (isCirclePadShape(padShape)) {
		const rInner = Math.min(padShape[1], padShape[2]) / 2;
		if (rInner > 1e-9 && expMil > 1e-9) {
			const ccx = pad.getState_X();
			const ccy = pad.getState_Y();
			const rOuter = rInner + expMil;
			const outer = circlePolygonSource(ccx, ccy, rOuter);
			const inner = circlePolygonSource(ccx, ccy, rInner);
			if (outputKind === 'solder_mask') {
				const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
				if (outerOnly) {
					return outerOnly;
				}
			}
			const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
			if (ring) {
				return ring;
			}
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
	}

	if (worldBBox && padShape[0] === PAD_SHAPE_OVAL) {
		const dim = selectDimsByBboxFit(padShape[1], padShape[2], rot, worldBBox);
		const w0 = dim.w;
		const h0 = dim.h;
		if (typeof w0 === 'number' && typeof h0 === 'number' && w0 > 0 && h0 > 0) {
			const outer = stadiumPolygonSource(cx, cy, rot, w0 + e2, h0 + e2);
			const inner = stadiumPolygonSource(cx, cy, rot, w0, h0);
			if (outputKind === 'solder_mask') {
				const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
				if (outerOnly) {
					return outerOnly;
				}
			}
			const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
			if (ring) {
				return ring;
			}
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
	}

	if (worldBBox && padShape[0] === PAD_SHAPE_ELLIPSE && !isCirclePadShape(padShape)) {
		const w0 = padShape[1];
		const h0 = padShape[2];
		if (typeof w0 === 'number' && typeof h0 === 'number' && w0 > 0 && h0 > 0) {
			const outer = closedEllipsePolygonSource(cx, cy, (w0 + e2) / 2, (h0 + e2) / 2, rot, ELLIPSE_POLYLINE_SEGMENTS, true);
			const inner = closedEllipsePolygonSource(cx, cy, w0 / 2, h0 / 2, rot, ELLIPSE_POLYLINE_SEGMENTS, false);
			if (outputKind === 'solder_mask') {
				const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
				if (outerOnly) {
					return outerOnly;
				}
			}
			const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
			if (ring) {
				return ring;
			}
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
	}

	if (worldBBox && padShape[0] === PAD_SHAPE_RECT) {
		const w0 = padShape[1];
		const h0 = padShape[2];
		const outerTl = rectTopLeftFromCenter(cx, cy, w0 + e2, h0 + e2, rot);
		const innerTl = rectTopLeftFromCenter(cx, cy, w0, h0, rot);
		const outer: PolygonSource = ['R', outerTl.x, outerTl.y, w0 + e2, h0 + e2, rot, 0];
		const inner: PolygonSource = ['R', innerTl.x, innerTl.y, w0, h0, rot, 0];
		if (outputKind === 'solder_mask') {
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
		return tryComplexRing(outer, inner, worldBBox, expMil);
	}

	if (padShape[0] === PAD_SHAPE_POLYGON) {
		const contour = buildPolygonPadOuterInnerContours((padShape as [typeof PAD_SHAPE_POLYGON, PolyData])[1], cx, cy, rot, expMil);
		if (contour) {
			if (outputKind === 'solder_mask') {
				const outerOnly = eda.pcb_MathPolygon.createPolygon(contour.outer);
				if (outerOnly) {
					return outerOnly;
				}
			}
			const ring = eda.pcb_MathPolygon.createComplexPolygon([contour.outer, contour.inner]);
			if (ring) {
				return ring;
			}
			const outerOnly = eda.pcb_MathPolygon.createPolygon(contour.outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
	}

	if (worldBBox) {
		const outer = bboxToRectContourSource(worldBBox, expMil, true);
		const inner = bboxToRectContourSource(worldBBox, 0, false);
		if (outputKind === 'solder_mask') {
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
		return tryComplexRing(outer, inner, worldBBox, expMil);
	}
	const source = await buildExpandedMaskSource(pad, padShape, expMil, rot);
	if (!source) {
		return undefined;
	}
	return eda.pcb_MathPolygon.createPolygon(source);
}

async function fillCreate(layer: FillLayer, polygon: IPCB_Polygon | IPCB_ComplexPolygon): Promise<IPCB_PrimitiveFill | undefined> {
	// 宿主 API 第二参名义为 IPCB_Polygon，实际接受复杂多边形或双轮廓源，勿强转为错误形态
	return eda.pcb_PrimitiveFill.create(layer, polygon as unknown as IPCB_Polygon, undefined, FILL_SOLID, 0, false);
}

async function createMaskFill(layer: FillLayer, maskPolygon: FillPolygon): ReturnType<typeof eda.pcb_PrimitiveFill.create> {
	const tryFill = (poly: IPCB_Polygon | IPCB_ComplexPolygon | PolygonSource[]) =>
		eda.pcb_PrimitiveFill.create(layer, poly as unknown as IPCB_Polygon, undefined, FILL_SOLID, 0, false);
	const getSourceSamplePoints = (source: PolygonSource): Array<{ x: number; y: number }> => {
		const pts: Array<{ x: number; y: number }> = [];
		if (source.length === 0) {
			return pts;
		}
		if (source[0] === 'R'
			&& typeof source[1] === 'number'
			&& typeof source[2] === 'number'
			&& typeof source[3] === 'number'
			&& typeof source[4] === 'number') {
			const x = source[1];
			const y = source[2];
			const w = source[3];
			const h = source[4];
			pts.push({ x, y }, { x: x + w, y }, { x: x + w, y: y - h }, { x, y: y - h });
			return pts;
		}
		if (source[0] === 'CIRCLE'
			&& typeof source[1] === 'number'
			&& typeof source[2] === 'number'
			&& typeof source[3] === 'number') {
			const cx = source[1];
			const cy = source[2];
			const r = source[3];
			pts.push({ x: cx + r, y: cy }, { x: cx, y: cy + r }, { x: cx - r, y: cy }, { x: cx, y: cy - r });
			return pts;
		}
		let i = source[0] === 'L' ? 1 : 0;
		while (i + 1 < source.length) {
			const x = source[i];
			const y = source[i + 1];
			if (typeof x === 'number' && typeof y === 'number') {
				pts.push({ x, y });
				i += 2;
				continue;
			}
			i += 1;
		}
		return pts;
	};
	const estimateSourceAreaAbs = (source: PolygonSource): number => {
		const pts = getSourceSamplePoints(source);
		if (pts.length < 3) {
			return 0;
		}
		let area2 = 0;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i];
			const b = pts[(i + 1) % pts.length];
			area2 += a.x * b.y - b.x * a.y;
		}
		return Math.abs(area2) / 2;
	};
	const sortContoursOuterFirst = (contours: PolygonSource[]): PolygonSource[] =>
		[...contours].sort((a, b) => estimateSourceAreaAbs(b) - estimateSourceAreaAbs(a));

	// 优先尝试「多轮廓源数组」：部分宿主对 IPCB_ComplexPolygon 包装不创建，对双轮廓数组可接受
	if ('getSourceStrictComplex' in maskPolygon && typeof (maskPolygon as IPCB_ComplexPolygon).getSourceStrictComplex === 'function') {
		const strict = (maskPolygon as IPCB_ComplexPolygon).getSourceStrictComplex();
		if (Array.isArray(strict) && strict.length >= 2) {
			try {
				const ordered = sortContoursOuterFirst(strict as PolygonSource[]);
				const r = await tryFill(ordered);
				if (r) {
					return r;
				}
			}
			catch {
				// fall through
			}
		}
	}
	if ('getSource' in maskPolygon && typeof maskPolygon.getSource === 'function') {
		const src = maskPolygon.getSource();
		if (Array.isArray(src) && src.length >= 2 && Array.isArray(src[0])) {
			try {
				const ordered = sortContoursOuterFirst(src as PolygonSource[]);
				const r = await tryFill(ordered);
				if (r) {
					return r;
				}
			}
			catch {
				// fall through
			}
		}
	}

	try {
		return await fillCreate(layer, maskPolygon as IPCB_ComplexPolygon);
	}
	catch {
		if ('getSource' in maskPolygon && typeof maskPolygon.getSource === 'function') {
			const src = maskPolygon.getSource();
			if (Array.isArray(src) && src.length > 0 && Array.isArray(src[0])) {
				const ordered = sortContoursOuterFirst(src as PolygonSource[]);
				try {
					const outer = eda.pcb_MathPolygon.createPolygon(ordered[0] as PolygonSource);
					if (outer) {
						return await fillCreate(layer, outer);
					}
				}
				catch {
					const rectSource = rectContourToRectSource(ordered[0] as PolygonSource);
					if (rectSource) {
						const rect = eda.pcb_MathPolygon.createPolygon(rectSource);
						if (rect) {
							return await fillCreate(layer, rect);
						}
					}
				}
			}
		}
		throw new Error('create fill failed');
	}
}

function extractLargestContourPolygon(maskPolygon: FillPolygon): IPCB_Polygon | undefined {
	const getSourceSamplePoints = (source: PolygonSource): Array<{ x: number; y: number }> => {
		const pts: Array<{ x: number; y: number }> = [];
		if (source.length === 0) {
			return pts;
		}
		if (source[0] === 'R'
			&& typeof source[1] === 'number'
			&& typeof source[2] === 'number'
			&& typeof source[3] === 'number'
			&& typeof source[4] === 'number') {
			const x = source[1];
			const y = source[2];
			const w = source[3];
			const h = source[4];
			pts.push({ x, y }, { x: x + w, y }, { x: x + w, y: y - h }, { x, y: y - h });
			return pts;
		}
		if (source[0] === 'CIRCLE'
			&& typeof source[1] === 'number'
			&& typeof source[2] === 'number'
			&& typeof source[3] === 'number') {
			const cx = source[1];
			const cy = source[2];
			const r = source[3];
			pts.push({ x: cx + r, y: cy }, { x: cx, y: cy + r }, { x: cx - r, y: cy }, { x: cx, y: cy - r });
			return pts;
		}
		let i = source[0] === 'L' ? 1 : 0;
		while (i + 1 < source.length) {
			const x = source[i];
			const y = source[i + 1];
			if (typeof x === 'number' && typeof y === 'number') {
				pts.push({ x, y });
				i += 2;
				continue;
			}
			i += 1;
		}
		return pts;
	};
	const estimateSourceAreaAbs = (source: PolygonSource): number => {
		const pts = getSourceSamplePoints(source);
		if (pts.length < 3) {
			return 0;
		}
		let area2 = 0;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i];
			const b = pts[(i + 1) % pts.length];
			area2 += a.x * b.y - b.x * a.y;
		}
		return Math.abs(area2) / 2;
	};
	const pickLargest = (list: PolygonSource[]): PolygonSource | undefined => {
		if (list.length === 0) {
			return undefined;
		}
		let best = list[0];
		let bestArea = estimateSourceAreaAbs(best);
		for (let i = 1; i < list.length; i++) {
			const a = estimateSourceAreaAbs(list[i]);
			if (a > bestArea) {
				bestArea = a;
				best = list[i];
			}
		}
		return best;
	};
	const asComplex = maskPolygon as IPCB_ComplexPolygon;
	if ('getSourceStrictComplex' in asComplex && typeof asComplex.getSourceStrictComplex === 'function') {
		const strict = asComplex.getSourceStrictComplex();
		if (Array.isArray(strict) && strict.length > 0 && Array.isArray(strict[0])) {
			const largest = pickLargest(strict as PolygonSource[]);
			if (largest) {
				return eda.pcb_MathPolygon.createPolygon(largest) ?? undefined;
			}
		}
	}
	if ('getSource' in maskPolygon && typeof maskPolygon.getSource === 'function') {
		const src = maskPolygon.getSource();
		if (Array.isArray(src) && src.length > 0 && Array.isArray(src[0])) {
			const largest = pickLargest(src as PolygonSource[]);
			if (largest) {
				return eda.pcb_MathPolygon.createPolygon(largest) ?? undefined;
			}
		}
	}
	return (maskPolygon as IPCB_Polygon);
}

function normalizeValueForKey(value: unknown): string {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value.toFixed(6) : 'NaN';
	}
	if (Array.isArray(value)) {
		return `[${value.map(normalizeValueForKey).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		return `{${keys.map(k => `${k}:${normalizeValueForKey(obj[k])}`).join(',')}}`;
	}
	return String(value);
}

function buildGenerationUniqueKey(
	pad: PadPrimitive,
	shape: PadShape,
	settings: PadExpansionSettings,
	smLayer: FillLayer,
): string {
	const pid = pad.getState_PrimitiveId();
	const px = pad.getState_X();
	const py = pad.getState_Y();
	const rot = rotationApiToDeg(pad.getState_Rotation());
	const shapeKey = normalizeValueForKey(shape);
	return [
		`pid=${pid}`,
		`kind=${settings.outputKind}`,
		`smLayer=${String(smLayer)}`,
		`exp=${settings.expMil.toFixed(6)}`,
		`x=${px.toFixed(6)}`,
		`y=${py.toFixed(6)}`,
		`rot=${normalizeRotationDeg(rot).toFixed(6)}`,
		`shape=${shapeKey}`,
	].join('|');
}

async function finalizeFillForSettings(
	fill: IPCB_PrimitiveFill,
	settings: PadExpansionSettings,
	padElectricalLayer: TPCB_LayersOfPad,
): Promise<boolean> {
	fill.setState_FillMode(FILL_SOLID);
	if (settings.outputKind === 'solder_mask') {
		if (fill.isAsync()) {
			await fill.done();
		}
		return true;
	}
	const region = await fill.convertToRegion();
	if (!region) {
		try {
			await eda.pcb_PrimitiveFill.delete(fill);
		}
		catch {
			// ignore
		}
		return false;
	}
	region.setState_RuleType([settings.outputKind === 'forbidden_fill'
		? EPCB_PrimitiveRegionRuleType.NO_FILLS
		: EPCB_PrimitiveRegionRuleType.NO_POURS]);
	region.setState_Layer(padElectricalLayer as TPCB_LayersOfRegion);
	region.setState_LineWidth(0);
	if (region.isAsync()) {
		await region.done();
	}
	return true;
}

function showInputDialogAsync(
	before: string,
	after: string,
	title: string,
	defaultInput: string,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showInputDialog(
			before,
			after,
			title,
			'number',
			defaultInput,
			{ placeholder: defaultInput, step: 0.000_001 },
			resolve,
		);
	});
}

function showConfirmationAsync(
	content: string,
	title: string,
	mainButtonTitle?: string,
	cancelButtonTitle?: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, title, mainButtonTitle, cancelButtonTitle, ok => resolve(Boolean(ok)));
	});
}

function showSelectKindAsync(t: (k: string, ...a: string[]) => string): Promise<PadExpansionOutputKind | undefined> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showSelectDialog(
			[
				{ value: 'forbidden_pour', displayContent: t('SolderMaskExpKindForbiddenPour') },
				{ value: 'forbidden_fill', displayContent: t('SolderMaskExpKindForbiddenFill') },
				{ value: 'solder_mask', displayContent: t('SolderMaskExpKindSolderMask') },
			],
			t('SolderMaskExpSelectKindBefore'),
			t('SolderMaskExpSelectKindAfter'),
			t('SolderMaskExpTitle'),
			'forbidden_pour',
			false,
			(v: string | undefined) => {
				resolve(v !== undefined && v !== '' && isPadExpansionOutputKind(v) ? v : undefined);
			},
		);
	});
}

async function collectPadsFromSelection(selected: IPCB_Primitive[]): Promise<{ pads: PadPrimitive[]; errors: string[] }> {
	const uniqueById = new Map<string, PadPrimitive>();
	const errors: string[] = [];
	for (const p of selected) {
		if (isPadPrimitive(p)) {
			uniqueById.set(p.getState_PrimitiveId(), p);
		}
	}
	for (const comp of selected.filter(isComponentPrimitive)) {
		try {
			const id = comp.getState_PrimitiveId();
			const byStatic = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id);
			const pinList = byStatic?.length
				? byStatic
				: await comp.toSync().getAllPins();
			for (const pad of pinList) {
				uniqueById.set(pad.getState_PrimitiveId(), pad);
			}
		}
		catch (e) {
			errors.push(`${comp.getState_Designator() ?? '?'}: ${errorMessage(e)}`);
		}
	}
	return { pads: [...uniqueById.values()], errors };
}

async function processPads(
	targetPads: PadPrimitive[],
	settings: PadExpansionSettings,
): Promise<{ created: number; errors: string[] }> {
	const te = (key: string) => eda.sys_I18n.text(key, undefined, undefined);
	let created = 0;
	const errors: string[] = [];
	/** 仅同一次批处理内去重：禁止用语义几何签名跨条目判断（易与「删除后再生成」同形重叠误伤）。 */
	const generatedKeySet = new Set<string>();

	for (const pad of targetPads) {
		const layer = pad.getState_Layer();
		const special = pad.getState_SpecialPad();
		const padShape = pad.getState_Pad();
		const label = padLabel(pad);

		if (!special?.length && !padShape) {
			errors.push(`${label}: no pad shape`);
			continue;
		}

		const maskLayers = solderMaskTargetsForPad(layer, special);
		const shapesToPlace: Array<{ shape: PadShape; layers: Set<FillLayer> }> = [];

		if (special?.length) {
			for (const [sa, sb, sh] of special) {
				const sub = new Set<FillLayer>();
				if (rangeCoversOuterLayer(sa, sb, LAYER_TOP)) {
					sub.add(LAYER_TOP_SOLDER_MASK);
				}
				if (rangeCoversOuterLayer(sa, sb, LAYER_BOTTOM)) {
					sub.add(LAYER_BOTTOM_SOLDER_MASK);
				}
				if (sub.size > 0) {
					shapesToPlace.push({ shape: sh, layers: sub });
				}
			}
		}
		else {
			if (!padShape) {
				errors.push(`${label}: no pad shape`);
				continue;
			}
			if (maskLayers.size === 0) {
				errors.push(`${label}: ${te('SolderMaskExpNoSolderMaskLayer')}`);
				continue;
			}
			shapesToPlace.push({ shape: padShape, layers: maskLayers });
		}

		if (shapesToPlace.length === 0) {
			errors.push(`${label}: ${te('SolderMaskExpNoShapeForSolderMask')}`);
			continue;
		}

		for (const { shape, layers } of shapesToPlace) {
			const useWholePadBBox = shapeNeedsWholePadBBox(shape) && !special?.length;
			for (const smLayer of layers) {
				const generationKey = buildGenerationUniqueKey(pad, shape, settings, smLayer);
				if (generatedKeySet.has(generationKey)) {
					continue;
				}
				const ipcMaskPoly = await buildExpandedMaskPolygon(pad, shape, settings.expMil, useWholePadBBox, settings.outputKind);
				if (!ipcMaskPoly) {
					padExpDebugLog('buildExpandedMaskPolygon-empty', {
						label,
						layer: smLayer,
						shapeType: shape[0],
						expMil: settings.expMil,
					});
					errors.push(`${label}: invalid geometry`);
					continue;
				}
				const polygonForFill = settings.outputKind === 'solder_mask'
					? (extractLargestContourPolygon(ipcMaskPoly) ?? ipcMaskPoly)
					: ipcMaskPoly;
				let fill: IPCB_PrimitiveFill | undefined;
				try {
					fill = await createMaskFill(smLayer, polygonForFill);
				}
				catch (e) {
					padExpDebugLog('createMaskFill-error', {
						label,
						layer: smLayer,
						shapeType: shape[0],
						error: errorMessage(e),
					});
					errors.push(`${label}: create fill failed (${errorMessage(e)})`);
					continue;
				}
				if (!fill) {
					padExpDebugLog('createMaskFill-empty', {
						label,
						layer: smLayer,
						shapeType: shape[0],
					});
					errors.push(`${label}: create fill returned empty`);
					continue;
				}
				try {
					if (await finalizeFillForSettings(fill, settings, layer)) {
						created++;
						generatedKeySet.add(generationKey);
					}
					else {
						errors.push(`${label}: ${te('SolderMaskExpFinalizeRegionFailed')}`);
					}
				}
				catch (e) {
					errors.push(`${label}: finalize failed (${errorMessage(e)})`);
				}
			}
		}
	}

	return { created, errors };
}

async function runInteractiveSelectionHandler(mouseProps?: PcbMouseSelectProp[]): Promise<void> {
	const settings = activeInteractiveSettings;
	if (!settings) {
		return;
	}
	if (interactiveProcessing) {
		pendingInteractiveSelection = true;
		pendingInteractiveMouseProps = mouseProps;
		return;
	}
	const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);
	interactiveProcessing = true;
	try {
		rememberPadParentFromMouseProps(mouseProps);
		const selected = await resolveSelectedPrimitives(mouseProps);
		const { pads, errors: collectErrors } = await collectPadsFromSelection(selected);
		if (pads.length === 0) {
			return;
		}
		const { created, errors } = await processPads(pads, settings);
		const allErr = [...collectErrors, ...errors];
		const errTail = allErr.length
			? `\n${t('SolderMaskExpErrors')}\n${allErr.slice(0, 5).join('\n')}${allErr.length > 5 ? '\n…' : ''}`
			: '';
		const toastType = allErr.length === 0
			? ESYS_ToastMessageType.SUCCESS
			: created === 0
				? ESYS_ToastMessageType.ERROR
				: ESYS_ToastMessageType.WARNING;
		showPadExpToast(
			t('SolderMaskExpInteractiveToast', String(created), String(pads.length)) + errTail,
			toastType,
			t,
		);
	}
	catch (e) {
		showPadExpToast(t('SolderMaskExpFailed', errorMessage(e)), ESYS_ToastMessageType.ERROR, t);
	}
	finally {
		interactiveProcessing = false;
		if (pendingInteractiveSelection && activeInteractiveSettings) {
			pendingInteractiveSelection = false;
			const nextProps = pendingInteractiveMouseProps;
			pendingInteractiveMouseProps = undefined;
			// 直接处理下一轮，避免再经 debounce 丢 props 或额外延迟
			void runInteractiveSelectionHandler(nextProps);
		}
	}
}

function scheduleInteractiveProcess(mouseProps?: PcbMouseSelectProp[]): void {
	if (selectionDebounceTimer !== undefined) {
		clearTimeout(selectionDebounceTimer);
	}
	const captured: PcbMouseSelectProp[] | undefined = mouseProps === undefined
		? undefined
		: (mouseProps.length > 0 ? mouseProps : undefined);
	selectionDebounceTimer = setTimeout(() => {
		selectionDebounceTimer = undefined;
		void runInteractiveSelectionHandler(captured);
	}, SELECT_DEBOUNCE_MS);
}

function registerInteractiveMouseListener(
	t: (k: string, ...a: string[]) => string,
	options?: { skipHintToast?: boolean },
): void {
	eda.pcb_Event.removeEventListener(MOUSE_LISTENER_ID);
	// 使用 'all' 再过滤 SELECTED：部分环境下仅注册 SELECTED 时回调不触发
	eda.pcb_Event.addMouseEventListener(
		MOUSE_LISTENER_ID,
		'all',
		(eventType, props) => {
			// 使用字符串比较，避免 EPCB_MouseEventType 运行时未定义
			const et = String(eventType).toLowerCase();
			const isSelected = et === 'selected';
			if (!isSelected || !activeInteractiveSettings) {
				return;
			}
			scheduleInteractiveProcess(normalizeMouseProps(props));
		},
	);
	if (!options?.skipHintToast) {
		showPadExpToast(t('SolderMaskExpInteractiveHint'), ESYS_ToastMessageType.INFO, t);
	}
	registerInteractiveExitListeners(t);
	writeListeningEcho(true);
	// 应用后立即尝试当前选中（无需再等一次选中事件）
	scheduleInteractiveProcess();
}

function stopInteractiveMode(): void {
	eda.pcb_Event.removeEventListener(MOUSE_LISTENER_ID);
	unregisterInteractiveExitListeners();
	activeInteractiveSettings = undefined;
	interactiveProcessing = false;
	pendingInteractiveSelection = false;
	pendingInteractiveMouseProps = undefined;
	padExpIframeListeningRegistered = false;
	recentPadParentIdByPadId.clear();
	if (selectionDebounceTimer !== undefined) {
		clearTimeout(selectionDebounceTimer);
		selectionDebounceTimer = undefined;
	}
	writeListeningEcho(false);
}

async function promptExpansionMil(
	unit: Awaited<ReturnType<typeof eda.sys_Unit.getFrontendDataUnit>>,
	hint: string,
	t: (k: string, ...a: string[]) => string,
): Promise<number | undefined> {
	const defaultInput = defaultExpansionInputByUnit(unit);
	for (;;) {
		const input = await showInputDialogAsync(
			t('SolderMaskExpInputBefore', hint),
			t('SolderMaskExpInputAfter', String(MAX_EXP_MIL)),
			t('SolderMaskExpInputTitle'),
			defaultInput,
		);
		if (input === undefined) {
			return undefined;
		}
		const converted = convertInputToMil(String(input), unit);
		if (converted === null) {
			eda.sys_Dialog.showInformationMessage(t('SolderMaskExpInvalidNumber'), t('SolderMaskExpTitle'));
			continue;
		}
		if (converted <= 0) {
			eda.sys_Dialog.showInformationMessage(t('SolderMaskExpNeedPositive'), t('SolderMaskExpTitle'));
			continue;
		}
		if (converted > MAX_EXP_MIL) {
			eda.sys_Dialog.showInformationMessage(t('SolderMaskExpTooLarge', String(MAX_EXP_MIL)), t('SolderMaskExpTitle'));
			continue;
		}
		return converted;
	}
}

interface PadExpansionSetupResult {
	outputKind: PadExpansionOutputKind;
	expMil: number;
	continuous: boolean;
}

/**
 * 解析内联页写入的一条「应用」消息（非 stopInteractive）。
 */
async function parseApplyRecord(
	p: Record<string, unknown>,
	t: (k: string, ...a: string[]) => string,
): Promise<PadExpansionSetupResult | undefined> {
	if (p.cancelled === true) {
		toastIframeSetupVerbose('解析：cancelled=true，退出');
		return undefined;
	}
	const kindRaw = p.kind;
	if (typeof kindRaw !== 'string' || !isPadExpansionOutputKind(kindRaw)) {
		toastIframeSetupVerbose(`解析：kind 无效 kindRaw=${String(kindRaw)}`);
		eda.sys_Dialog.showInformationMessage(t('SolderMaskExpInvalidKind'), t('SolderMaskExpTitle'));
		return undefined;
	}
	const unit = await eda.sys_Unit.getFrontendDataUnit();
	const expMil = convertInputToMil(String(p.expansionInput ?? ''), unit);
	if (expMil === null) {
		toastIframeSetupVerbose(`解析：expansionInput 转换失败 input=${String(p.expansionInput)} unit=${unit}`);
		eda.sys_Dialog.showInformationMessage(t('SolderMaskExpInvalidNumber'), t('SolderMaskExpTitle'));
		return undefined;
	}
	if (expMil <= 0) {
		toastIframeSetupVerbose(`解析：expMil <= 0 (${expMil})`);
		eda.sys_Dialog.showInformationMessage(t('SolderMaskExpNeedPositive'), t('SolderMaskExpTitle'));
		return undefined;
	}
	if (expMil > MAX_EXP_MIL) {
		toastIframeSetupVerbose(`解析：expMil 过大 (${expMil})`);
		eda.sys_Dialog.showInformationMessage(t('SolderMaskExpTooLarge', String(MAX_EXP_MIL)), t('SolderMaskExpTitle'));
		return undefined;
	}
	toastIframeSetupVerbose(`解析成功: kind=${kindRaw} expMil=${expMil.toFixed(4)} continuous=${String(p.continuous)}`);
	return {
		outputKind: kindRaw,
		expMil,
		continuous: Boolean(p.continuous),
	};
}

async function runFallbackChainExecute(t: (k: string, ...a: string[]) => string): Promise<void> {
	const setup = await padExpansionSetupFallbackAsync(t);
	if (setup === undefined) {
		return;
	}
	const settings: PadExpansionSettings = { outputKind: setup.outputKind, expMil: setup.expMil };
	if (setup.continuous) {
		activeInteractiveSettings = settings;
		registerInteractiveMouseListener(t);
		padExpIframeListeningRegistered = true;
	}
	else {
		await runOneShotPadExpansion(t, settings);
	}
}

/**
 * 内联窗打开期间轮询存储：处理「生成」「停止」直至窗口关闭。
 */
async function runIframeSetupSessionLoop(
	sysIframe: { isIFrameAlreadyExist: (id: string) => Promise<boolean> },
	t: (k: string, ...a: string[]) => string,
	initialEverVisible: boolean,
): Promise<void> {
	padExpIframeSessionContinuousHintShown = false;
	let lastHandledApplySeq = 0;
	let oneShotRunning = false;
	let everIframeVisible = initialEverVisible;
	const sessionT0 = Date.now();

	for (;;) {
		if (Date.now() - sessionT0 > IFRAME_WAIT_MAX_MS) {
			toastIframeSetupVerbose('内联会话达到最大等待时间，结束');
			break;
		}
		const exists = await sysIframe.isIFrameAlreadyExist(IFRAME_SETUP_ID);
		if (exists) {
			everIframeVisible = true;
		}

		const raw = readIframeSetupPayloadRaw();
		if (raw) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw) as unknown;
			}
			catch (e) {
				toastIframeSetupVerbose(`会话轮询：JSON 解析失败 ${errorMessage(e)}`);
				clearIframeSetupPayload();
				await sleepMs(IFRAME_SESSION_POLL_MS);
				continue;
			}
			if (parsed && typeof parsed === 'object') {
				const p = parsed as Record<string, unknown>;
				if (p.command === 'stopInteractive') {
					stopInteractiveMode();
					clearIframeSetupPayload();
					await sleepMs(IFRAME_SESSION_POLL_MS);
					continue;
				}
				if (p.cancelled === true) {
					stopInteractiveMode();
					clearIframeSetupPayload();
					await sleepMs(IFRAME_SESSION_POLL_MS);
					continue;
				}
				const seq = p.seq;
				if (typeof seq === 'number' && seq > lastHandledApplySeq && typeof p.kind === 'string') {
					const result = await parseApplyRecord(p, t);
					if (result) {
						lastHandledApplySeq = seq;
						clearIframeSetupPayload();
						const settings: PadExpansionSettings = {
							outputKind: result.outputKind,
							expMil: result.expMil,
						};
						if (result.continuous) {
							activeInteractiveSettings = settings;
							if (!padExpIframeListeningRegistered) {
								const skipHint = padExpIframeSessionContinuousHintShown;
								registerInteractiveMouseListener(t, { skipHintToast: skipHint });
								padExpIframeListeningRegistered = true;
								if (!skipHint) {
									padExpIframeSessionContinuousHintShown = true;
								}
							}
						}
						else if (!oneShotRunning) {
							oneShotRunning = true;
							try {
								await runOneShotPadExpansion(t, settings);
							}
							finally {
								oneShotRunning = false;
							}
						}
					}
					else {
						clearIframeSetupPayload();
					}
				}
			}
		}

		if (everIframeVisible && !exists) {
			toastIframeSetupVerbose('内联设置窗口已关闭，结束会话');
			break;
		}

		await sleepMs(IFRAME_SESSION_POLL_MS);
	}

	stopInteractiveMode();
}

/**
 * 内联设置页（`/iframe/` 目录 + {@link eda.sys_IFrame.openIFrame}）。
 * @see https://prodocs.lceda.cn/cn/api/guide/inline-frame.html
 * @see https://prodocs.lceda.cn/cn/api/reference/pro-api.sys_iframe.openiframe.html
 */
async function openPadExpansionSetupIframe(t: (k: string, ...a: string[]) => string): Promise<void> {
	const sysIframe = eda.sys_IFrame;
	if (!sysIframe || typeof sysIframe.openIFrame !== 'function') {
		toastIframeSetupVerbose('sys_IFrame.openIFrame 不可用，走回退对话框');
		await runFallbackChainExecute(t);
		return;
	}
	writeListeningEcho(false);
	clearIframeSetupPayload();
	const iframeProps = {
		title: t('SolderMaskExpSetupTitle'),
		grayscaleMask: true,
		minimizeButton: false,
		maximizeButton: false,
		buttonCallbackFn: async (button: 'close' | 'minimize' | 'maximize') => {
			if (button === 'close') {
				try {
					const cur = readIframeSetupPayloadRaw();
					if (cur === null || cur === '') {
						try {
							sessionStorage.setItem(IFRAME_SETUP_STORAGE_KEY, JSON.stringify({ cancelled: true }));
						}
						catch {
							// ignore
						}
						try {
							await eda.sys_Storage.setExtensionUserConfig(
								IFRAME_SETUP_STORAGE_KEY,
								JSON.stringify({ cancelled: true }),
							);
						}
						catch {
							// ignore
						}
					}
				}
				catch {
					// ignore
				}
			}
		},
	};
	let opened: boolean | undefined;
	try {
		opened = await sysIframe.openIFrame(
			IFRAME_HTML_PATH_PRIMARY,
			420,
			IFRAME_SETUP_HEIGHT_PX,
			IFRAME_SETUP_ID,
			iframeProps,
		) as boolean | undefined;
	}
	catch (e) {
		padExpDebugLog('openIFrame-primary-throw', e);
		try {
			opened = await sysIframe.openIFrame(
				IFRAME_HTML_PATH_ALT,
				420,
				IFRAME_SETUP_HEIGHT_PX,
				IFRAME_SETUP_ID,
				iframeProps,
			) as boolean | undefined;
		}
		catch (e2) {
			padExpDebugLog('openIFrame-alt-throw', e2);
			toastIframeSetupVerbose(`openIFrame 异常: ${errorMessage(e2)}`);
			await runFallbackChainExecute(t);
			return;
		}
	}
	// 文档为 Promise<boolean>；部分宿主返回 undefined，勿用 Boolean(opened) 误判
	toastIframeSetupVerbose(`openIFrame 返回 opened=${String(opened)}`);
	// 无论 openIFrame 返回什么，都等待一下再检测；某些宿主返回 undefined 但窗口已打开
	await sleepMs(200);
	let exists = await sysIframe.isIFrameAlreadyExist(IFRAME_SETUP_ID);
	toastIframeSetupVerbose(`首次检测 isIFrameAlreadyExist => ${String(exists)}`);
	// 若不存在，再给予几次重试（某些宿主初始化有延迟）
	for (let retry = 0; !exists && retry < 5; retry++) {
		await sleepMs(200);
		exists = await sysIframe.isIFrameAlreadyExist(IFRAME_SETUP_ID);
		toastIframeSetupVerbose(`重试${retry + 1} isIFrameAlreadyExist => ${String(exists)}`);
	}
	// 放宽判断：宿主常见行为是 openIFrame 返回 undefined（非 false）、isIFrameAlreadyExist 恒为 false。
	// 若用 Boolean(opened)，undefined 会被当成 false，导致误判「未打开」并在用户尚未操作时就 return，后续生成永远进不了主逻辑。
	// 仅当明确返回 false 且探测不到窗口时，才视为打开失败。
	const windowLikelyOpen = opened !== false || exists;
	if (!windowLikelyOpen) {
		toastIframeSetupVerbose('openIFrame 返回 false 且 isIFrameAlreadyExist=false，判定为打开失败');
		eda.sys_Dialog.showInformationMessage(t('SolderMaskExpIframeOpenFailed'), t('SolderMaskExpTitle'));
		return;
	}
	if (!exists) {
		toastIframeSetupVerbose('警告：isIFrameAlreadyExist 始终为 false，但继续会话轮询（以存储与超时为准）');
	}
	await runIframeSetupSessionLoop(sysIframe, t, exists);
}

async function padExpansionSetupFallbackAsync(t: (k: string, ...a: string[]) => string): Promise<PadExpansionSetupResult | undefined> {
	const kind = await showSelectKindAsync(t);
	if (kind === undefined) {
		return undefined;
	}
	const unit = await eda.sys_Unit.getFrontendDataUnit();
	const expMil = await promptExpansionMil(unit, unitHint(unit), t);
	if (expMil === undefined) {
		return undefined;
	}
	const continuous = await showConfirmationAsync(
		t('SolderMaskExpContinuousModePrompt'),
		t('SolderMaskExpTitle'),
		t('SolderMaskExpContinuousYes'),
		t('SolderMaskExpContinuousNo'),
	);
	return { outputKind: kind, expMil, continuous };
}

async function runOneShotPadExpansion(
	t: (k: string, ...a: string[]) => string,
	settings: PadExpansionSettings,
): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	let selected = await resolveSelectedPrimitives();
	if (selected.length === 0) {
		await new Promise<void>(resolve => setTimeout(resolve, 120));
		selected = await eda.pcb_SelectControl.getAllSelectedPrimitives();
	}
	const { pads, errors: collectErrors } = await collectPadsFromSelection(selected);
	if (pads.length === 0) {
		return;
	}
	const { created, errors } = await processPads(pads, settings);
	const allErr = [...collectErrors, ...errors];
	const errTail = allErr.length
		? `\n${t('SolderMaskExpErrors')}\n${allErr.slice(0, 5).join('\n')}${allErr.length > 5 ? '\n…' : ''}`
		: '';
	const toastType = allErr.length === 0
		? ESYS_ToastMessageType.SUCCESS
		: created === 0
			? ESYS_ToastMessageType.ERROR
			: ESYS_ToastMessageType.WARNING;
	showPadExpToast(
		t('SolderMaskExpInteractiveToast', String(created), String(pads.length)) + errTail,
		toastType,
		t,
	);
}

export async function runPadSolderMaskExpansion(): Promise<void> {
	const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);
	stopInteractiveMode();
	showDebugEnabledToast();
	padExpDebugLog('runPadSolderMaskExpansion-enter');
	try {
		if (!(await checkPcbDocumentActive())) {
			eda.sys_Dialog.showConfirmationMessage(t('SolderMaskExpNeedPcb'), t('SolderMaskExpTitle'));
			return;
		}
		await openPadExpansionSetupIframe(t);
	}
	catch (err) {
		eda.sys_Dialog.showConfirmationMessage(
			eda.sys_I18n.text('SolderMaskExpFailed', undefined, undefined, err instanceof Error ? err.message : String(err)),
			t('SolderMaskExpTitle'),
		);
	}
}
