import { loadPolicy } from '@open-policy-agent/opa-wasm';
import type { Op, RoomState } from '../wire/messages';

/**
 * OPA-Wasm policy engine — evaluates cic.rego (compiled to static/policy/cic.wasm
 * by `opa build -t wasm`, see package.json `policy:build`).
 * Every client evaluates every op against these rules before applying it.
 */

type Policy = { evaluate(input: unknown): { result: unknown }[] };

let policy: Policy | null = null;

export async function initPolicy(): Promise<void> {
	const wasm = await fetch('/policy/cic.wasm').then((r) => r.arrayBuffer());
	policy = await loadPolicy(wasm);
}

function evalEntry<T>(entrypoint: string, input: unknown): T | undefined {
	if (!policy) return undefined;
	const out = policy.evaluate(input) as { result: Record<string, T> }[];
	return out[0]?.result?.[entrypoint];
}

export interface Actor {
	id: string;
	canManageRoom: boolean;
}

/** returns list of deny reasons; empty = allowed */
export function denyReasons(op: Op, actor: Actor, state: RoomState): string[] {
	return evalEntry<string[]>('cic/deny', { op, actor, state }) ?? ['policy not loaded'];
}

export function allowed(op: Op, actor: Actor, state: RoomState): boolean {
	return evalEntry<boolean>('cic/allow', { op, actor, state }) === true;
}
