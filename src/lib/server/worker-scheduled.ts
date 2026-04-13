import type { ScheduledController, ExecutionContext } from '@cloudflare/workers-types';
import type { PosBindings } from '$lib/server/env';
import { runScheduledLowStockAlert } from '$lib/server/inventory';

export async function handleScheduledInventoryAlert(
	_controller: ScheduledController,
	env: PosBindings,
	ctx: ExecutionContext
) {
	ctx.waitUntil(runScheduledLowStockAlert(env));
}
