import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { logger } from '../../services/logger.ts';
import WhatsappMessage from '../../models/whatsappMessage.model.ts';
import Conversation from '../../models/Conversation.ts';
import User from '../../models/User.ts';
import { normalizePhone, isValidPhone } from '../../utils/phone.ts';

const TAG = '[dashboard-chats]';

// All handlers run behind dashboardAuthResolver, which establishes the tenant
// context — every model call below is tenant-scoped automatically.
//
// Read-only: this surface never sends. The conversation list reads the
// materialised Conversation summary (written by saveWhatsappMessage), then
// resolves display names from User in a second scoped query — tenantScope
// rejects `$lookup`, so there is no join.

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? 'Invalid request.';

// --- Conversation list -------------------------------------------------------

const listQuerySchema = z.object({
  // Matches a phone number fragment or a customer name (case-insensitive).
  search: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// Escape user input before it reaches a RegExp — a raw `search` would otherwise
// let a caller inject regex metacharacters (catastrophic backtracking, etc.).
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /dashboard/chats — one row per phone number that has ever exchanged a
// message with this tenant, newest conversation first.
export const listConversationsHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { search, page, limit } = parsed.data;

  try {
    // A search term may match either the number itself or the customer's name.
    // Names live on User, so resolve matching names to phone numbers first and
    // fold them into a single `$match` on the message log.
    const match: Record<string, unknown> = {};
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      const digits = normalizePhone(search);
      const namedUsers = await User.find({ name: pattern }).select('phoneNumber').lean();
      const phones = namedUsers.map((u) => u.phoneNumber);
      const clauses: Record<string, unknown>[] = [];
      if (digits) {
        clauses.push({ phoneNumber: { $regex: escapeRegex(digits) } });
      }
      if (phones.length > 0) {
        clauses.push({ phoneNumber: { $in: phones } });
      }
      // A non-numeric term that matched no customer name can only yield nothing.
      if (clauses.length === 0) {
        res.status(200).json({ conversations: [], total: 0, page, limit });
        return;
      }
      match.$or = clauses;
    }

    // Reads the materialised Conversation summary (maintained on write by
    // saveWhatsappMessage) rather than re-deriving the list from the whole
    // message log. Cost now scales with the tenant's conversation count, and the
    // { tenantId, lastMessageAt } index serves the sort directly — where the old
    // $sort + $group scanned every message the tenant had ever exchanged.
    const [rows, total] = await Promise.all([
      Conversation.find(match)
        .sort({ lastMessageAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Conversation.countDocuments(match),
    ]);

    // Second scoped query for the display names (no cross-collection stage).
    const phoneNumbers = rows.map((r) => r.phoneNumber);
    const users = await User.find({ phoneNumber: { $in: phoneNumbers } })
      .select('phoneNumber name status lastInteractionAt')
      .lean();
    const byPhone = new Map(users.map((u) => [u.phoneNumber, u]));

    const conversations = rows.map((row) => {
      const user = byPhone.get(row.phoneNumber);
      return {
        phoneNumber: row.phoneNumber,
        name: user?.name ?? null,
        userId: user ? String(user._id) : null,
        status: user?.status ?? null,
        messageCount: row.messageCount,
        lastMessage: {
          id: String(row.lastMessage.messageId),
          direction: row.lastMessage.direction,
          messageType: row.lastMessage.messageType,
          interactiveType: row.lastMessage.interactiveType ?? null,
          // Already truncated at write time — the summary stores a preview, not
          // the full body, so nothing to trim here.
          preview: row.lastMessage.preview,
          timestamp: row.lastMessage.timestamp,
          status: row.lastMessage.status,
        },
      };
    });

    res.status(200).json({ conversations, total, page, limit });
  } catch (err) {
    logger.error(`${TAG} list failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load conversations. Please try again.' });
  }
};

// --- Thread ------------------------------------------------------------------

const threadQuerySchema = z
  .object({
    // Scroll-back cursor. Composite on purpose: WhatsApp timestamps carry only
    // second precision, so a plain `timestamp < before` skips every other message
    // that shares the boundary second with the anchor — and a burst of messages
    // inside one second is exactly when that happens. `beforeId` disambiguates
    // within the second, matching the (timestamp, _id) sort below.
    before: z.coerce.date().optional(),
    beforeId: z
      .string()
      .refine((v) => Types.ObjectId.isValid(v), { message: 'Invalid cursor.' })
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  // `beforeId` only disambiguates within `before`'s second — alone it cannot
  // position anything, and silently ignoring it would return the NEWEST page.
  // A client paginating on that response would ask for the same page forever, so
  // an incomplete cursor has to fail loudly rather than look like a fresh thread.
  // `before` alone remains valid: that is the documented legacy cursor.
  .refine((query) => !(query.beforeId && !query.before), {
    message: 'beforeId requires before.',
    path: ['beforeId'],
  });

// GET /dashboard/chats/:phoneNumber/messages — one conversation, newest page
// first on the wire but returned oldest-first so the client can append directly.
export const getConversationHandler = async (req: Request, res: Response): Promise<void> => {
  const phoneNumber = normalizePhone(String(req.params.phoneNumber ?? ''));
  if (!isValidPhone(phoneNumber)) {
    res.status(400).json({ error: 'Invalid phone number.' });
    return;
  }
  const parsed = threadQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { before, beforeId, limit } = parsed.data;

  const filter: Record<string, unknown> = { phoneNumber };
  if (before && beforeId) {
    // Strictly-before in the same (timestamp desc, _id desc) order the sort uses:
    // an older second, or the same second but an earlier-sorting _id.
    filter.$or = [
      { timestamp: { $lt: before } },
      { timestamp: before, _id: { $lt: new Types.ObjectId(beforeId) } },
    ];
  } else if (before) {
    // Timestamp-only cursor (older clients). Kept working, but it can skip
    // messages sharing the boundary second — send beforeId to avoid that.
    filter.timestamp = { $lt: before };
  }

  try {
    // Fetch newest-first so `limit` takes the most recent page, then flip.
    const page = await WhatsappMessage.find(filter)
      .sort({ timestamp: -1, _id: -1 })
      .limit(limit + 1)
      .select('direction messageType interactiveType content timestamp status externalId')
      .lean();

    const hasMore = page.length > limit;
    const messages = (hasMore ? page.slice(0, limit) : page).reverse().map((m) => ({
      id: String(m._id),
      direction: m.direction,
      messageType: m.messageType,
      interactiveType: m.interactiveType ?? null,
      content: m.content,
      timestamp: m.timestamp,
      status: m.status,
      externalId: m.externalId ?? null,
    }));

    const user = await User.find({ phoneNumber })
      .select('phoneNumber name status lastInteractionAt')
      .limit(1)
      .lean();

    res.status(200).json({
      contact: {
        phoneNumber,
        name: user[0]?.name ?? null,
        userId: user[0] ? String(user[0]._id) : null,
        status: user[0]?.status ?? null,
        lastInteractionAt: user[0]?.lastInteractionAt ?? null,
      },
      messages,
      hasMore,
      // Cursor for the next (older) page — the oldest row in this page, both
      // halves. Null when the thread is exhausted.
      nextBefore: hasMore && messages[0] ? messages[0].timestamp : null,
      nextBeforeId: hasMore && messages[0] ? messages[0].id : null,
    });
  } catch (err) {
    logger.error(`${TAG} thread failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load the conversation. Please try again.' });
  }
};
