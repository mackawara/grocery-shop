import { logger } from '../services/logger.ts';
import { BillingControl, billingModels } from './models.ts';
import { runBilling } from './service.ts';

export const startBillingWorker = async (): Promise<void> => {
  // Unique indexes must exist before accepting concurrent ledger operations.
  for (const model of billingModels) {
    await model.init();
  }
  await BillingControl.updateOne(
    { _id: 'billing' },
    { $setOnInsert: { revision: 0 } },
    { upsert: true },
  );
  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await runBilling();
    } catch {
      logger.error('[billing] Invoice generation failed; it will retry on the next tick');
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(
    () => {
      void tick();
    },
    60 * 60 * 1000,
  ).unref();
};
