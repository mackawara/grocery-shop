/**
 * Rebuilds the materialised Conversation summary from the WhatsApp message log.
 *
 * Required once when deploying the summary (the dashboard conversation list
 * reads Conversation, so without a backfill every pre-existing conversation
 * disappears from the list until its next message arrives). Also usable any time
 * the summary is suspected of having drifted — Conversation is a derived view,
 * so rebuilding it is always safe.
 *
 * Idempotent: recomputes each conversation from scratch and overwrites, so
 * re-running never double-counts.
 *
 * Usage:  yarn tsx src/scripts/backfillConversations.ts
 */
import mongoose from 'mongoose';
import { logger } from '../services/logger.ts';
import { connectDb } from '../services/database.ts';
import Tenant from '../models/Tenant.ts';
import WhatsappMessage from '../models/whatsappMessage.model.ts';
import Conversation from '../models/Conversation.ts';
import { runWithTenant, runWithoutTenant } from '../context/tenantContext.ts';

const TAG = 'BACKFILL_CONVERSATIONS';

// Must match the write path's preview length (utils/whatsapp.utils.ts) so a
// rebuilt summary is indistinguishable from an incrementally-built one.
const PREVIEW_LENGTH = 160;

const preview = (content: string): string =>
  content.length > PREVIEW_LENGTH ? `${content.slice(0, PREVIEW_LENGTH)}…` : content;

interface GroupedConversation {
  _id: string;
  lastMessage: {
    _id: mongoose.Types.ObjectId;
    direction: string;
    messageType: string;
    interactiveType?: string | null;
    content: string;
    timestamp: Date;
    status: string;
  };
  messageCount: number;
}

// Rebuild one tenant's conversations. Runs inside runWithTenant, so both the
// aggregate and the writes are tenant-scoped by the plugin.
const backfillTenant = async (tenantLabel: string): Promise<number> => {
  // This is the expensive $group the read path used to run per request — here it
  // runs once, offline, which is the whole point of materialising it.
  const grouped = (await WhatsappMessage.aggregate([
    { $sort: { timestamp: -1, _id: -1 } },
    {
      $group: {
        _id: '$phoneNumber',
        lastMessage: {
          $first: {
            _id: '$_id',
            direction: '$direction',
            messageType: '$messageType',
            interactiveType: '$interactiveType',
            content: '$content',
            timestamp: '$timestamp',
            status: '$status',
          },
        },
        messageCount: { $sum: 1 },
      },
    },
  ])) as GroupedConversation[];

  for (const row of grouped) {
    // Full overwrite rather than $inc, so re-running is idempotent.
    await Conversation.updateOne(
      { phoneNumber: row._id },
      {
        $set: {
          lastMessage: {
            messageId: row.lastMessage._id,
            direction: row.lastMessage.direction,
            messageType: row.lastMessage.messageType,
            interactiveType: row.lastMessage.interactiveType ?? null,
            preview: preview(row.lastMessage.content),
            timestamp: row.lastMessage.timestamp,
            status: row.lastMessage.status,
          },
          lastMessageAt: row.lastMessage.timestamp,
          messageCount: row.messageCount,
        },
      },
      { upsert: true },
    );
  }

  logger.info(`[${TAG}] ${tenantLabel}: ${grouped.length} conversation(s) rebuilt.`);
  return grouped.length;
};

const run = async (): Promise<void> => {
  await connectDb();

  // Enumerating tenants is inherently cross-tenant; each tenant's own data is
  // then rebuilt inside its own context.
  const tenants = await runWithoutTenant(
    'conversation summary backfill',
    'Tenant.find({}, _id slug)',
    () => Tenant.find({}).select('_id slug').lean(),
  );

  logger.info(`[${TAG}] Rebuilding conversations for ${tenants.length} tenant(s)…`);

  let total = 0;
  for (const tenant of tenants) {
    total += await runWithTenant(
      tenant._id as mongoose.Types.ObjectId,
      () => backfillTenant(tenant.slug),
      tenant.slug,
    );
  }

  logger.info(`[${TAG}] Done. ${total} conversation(s) across ${tenants.length} tenant(s).`);
  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (error) => {
  logger.error(
    `[${TAG}] Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
  );
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
